import { NextRequest } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import EPub from "epub2";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  addBook,
  loadSettings,
  saveCover,
  findBookByFilename,
  saveBookPages,
  listSeries,
  saveSeries,
  saveBookSpecialistProfile,
} from "@/lib/book-store";
import type { BookPage } from "@/lib/book-store";
import { rebuildKnowledgeForBook } from "@/lib/knowledge-store";

export const maxDuration = 300;
const AWS_REGION = process.env.AWS_REGION || "eu-central-1";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-opus-4-6-v1";
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

function detectSeriesName(filename: string): string | null {
  const base = titleFromFilename(filename);

  const paren = base.match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    const cleaned = paren[1].replace(/#\d+.*$/i, "").trim();
    if (cleaned.length >= 3) return cleaned;
  }

  const dashParts = base.split(" - ").map((p) => p.trim()).filter(Boolean);
  if (dashParts.length >= 3) {
    const mid = dashParts[1].replace(/#\d+.*$/i, "").trim();
    if (mid.length >= 3) return mid;
  }

  const expeditionary = base.match(/(Expeditionary Force)/i);
  if (expeditionary) return "Expeditionary Force";

  return null;
}

async function buildSpecialistProfile(
  bookId: string,
  title: string,
  pages: BookPage[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const settings = loadSettings();
  const extractionModelId = settings.modelRouting?.extractionModelId || BEDROCK_MODEL_ID;
  const combined = pages
    .slice(0, 40)
    .map((p) => `[${p.label}]\n${p.text}`)
    .join("\n\n---\n\n")
    .slice(0, 30000);

  if (!combined.trim()) return;
  onProgress?.("Training specialist AI profile for this book...");

  try {
    const prompt =
      "You are creating a specialist memory profile for one book. Return strict JSON only with keys: summary (string), keyTopics (string[]), notableEntities (string[]), styleNotes (string[]).";
    const command = new InvokeModelCommand({
      modelId: extractionModelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1200,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${prompt}\n\nBook: ${title}\n\nExtracted passages:\n${combined}`,
              },
            ],
          },
        ],
      }),
    });
    const response = await bedrockClient.send(command);
    const bedrockRaw = new TextDecoder().decode(response.body);
    const bedrockParsed = JSON.parse(bedrockRaw) as {
      content?: Array<{ type?: string; text?: string }>;
    };

    const raw = bedrockParsed.content?.find((c) => c.type === "text")?.text || "";
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON in response");
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
      summary?: string;
      keyTopics?: string[];
      notableEntities?: string[];
      styleNotes?: string[];
    };

    saveBookSpecialistProfile({
      bookId,
      bookTitle: title,
      summary: parsed.summary || `Specialist profile for "${title}".`,
      keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.map(String).slice(0, 12) : [],
      notableEntities: Array.isArray(parsed.notableEntities)
        ? parsed.notableEntities.map(String).slice(0, 20)
        : [],
      styleNotes: Array.isArray(parsed.styleNotes) ? parsed.styleNotes.map(String).slice(0, 8) : [],
      updatedAt: new Date().toISOString(),
    });
    onProgress?.("Specialist profile ready");
  } catch {
    saveBookSpecialistProfile({
      bookId,
      bookTitle: title,
      summary: `Specialist profile for "${title}" (fallback profile).`,
      keyTopics: [],
      notableEntities: [],
      styleNotes: [],
      updatedAt: new Date().toISOString(),
    });
    onProgress?.("Specialist profile created (fallback)");
  }
}

interface PdfResult {
  text: string;
  pages: BookPage[];
}

async function extractPdf(buffer: ArrayBuffer): Promise<PdfResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf);

  const pages: BookPage[] = text.map((pageText, i) => ({
    label: `Page ${i + 1}`,
    text: pageText,
  }));

  return { text: text.join("\n\n"), pages };
}

interface EpubResult {
  text: string;
  pages: BookPage[];
  cover?: { buffer: Buffer; mimeType: string };
  author?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function extractEpubInner(
  filePath: string,
  onProgress?: (msg: string) => void
): Promise<EpubResult> {
  const epub = await withTimeout(
    EPub.createAsync(filePath),
    30000,
    "EPUB parsing"
  );

  const chapters: string[] = [];
  const pages: BookPage[] = [];
  const totalItems = epub.flow.length;
  let processed = 0;
  let chapterNum = 0;

  for (const item of epub.flow) {
    processed++;
    if (item.id) {
      try {
        const text = await withTimeout(
          epub.getChapterAsync(item.id),
          10000,
          `chapter ${processed}/${totalItems}`
        );
        const plainText = text
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (plainText) {
          chapterNum++;
          chapters.push(plainText);
          pages.push({ label: `Chapter ${chapterNum}`, text: plainText });
        }
        if (onProgress && processed % 5 === 0) {
          onProgress(`Read ${processed}/${totalItems} chapters (${chapters.length} with text)...`);
        }
      } catch {
        // Skip unreadable or timed-out chapters
      }
    }
  }

  let cover: EpubResult["cover"];
  try {
    const coverId = epub.metadata?.cover;
    if (coverId) {
      const [imgBuffer, mimeType] = await epub.getImageAsync(coverId);
      if (imgBuffer && imgBuffer.length > 0) {
        cover = { buffer: imgBuffer, mimeType };
      }
    }
  } catch {
    // No cover available
  }

  const author = epub.metadata?.creator || undefined;
  return { text: chapters.join("\n\n"), pages, cover, author };
}

async function extractEpub(
  buffer: ArrayBuffer,
  onProgress?: (msg: string) => void
): Promise<EpubResult> {
  const dir = await mkdtemp(join(tmpdir(), "epub-"));
  const filePath = join(dir, "book.epub");
  await writeFile(filePath, Buffer.from(buffer));

  // epub2 throws uncaught exceptions from its internal TOC parser
  // (navLabel.trim errors). Trap them so they don't crash the server.
  const trapUncaught = (err: Error) => {
    if (err?.message?.includes(".trim is not a function")) {
      // Swallowed — epub2 TOC parsing bug
    } else {
      throw err;
    }
  };
  process.on("uncaughtException", trapUncaught);

  try {
    return await withTimeout(
      extractEpubInner(filePath, onProgress),
      120000,
      "full EPUB extraction"
    );
  } finally {
    process.removeListener("uncaughtException", trapUncaught);
    await unlink(filePath).catch(() => {});
  }
}

interface TxtResult {
  text: string;
  pages: BookPage[];
}

function extractTxt(buffer: ArrayBuffer): TxtResult {
  const fullText = new TextDecoder("utf-8").decode(buffer);
  const charsPerPage = 3000;
  const pages: BookPage[] = [];

  for (let i = 0; i < fullText.length; i += charsPerPage) {
    pages.push({
      label: `Page ${pages.length + 1}`,
      text: fullText.slice(i, i + charsPerPage),
    });
  }

  return { text: fullText, pages };
}

export async function POST(request: NextRequest) {
  if (process.env.PUBLIC_MODE === "true") {
    return Response.json(
      { error: "Uploads are disabled in public mode." },
      { status: 403 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: string) => {
        controller.enqueue(encoder.encode(`${type}:${data}\n`));
      };

      try {
        const formData = await request.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
          send("ERROR", "No file provided");
          controller.close();
          return;
        }

        const ext = file.name.split(".").pop()?.toLowerCase();
        const title = titleFromFilename(file.name);

        const existing = findBookByFilename(file.name);
        if (existing) {
          send("ERROR", `"${existing.title}" is already in your library.`);
          controller.close();
          return;
        }

        const sizeMB = (file.size / 1024 / 1024).toFixed(1);

        send("PROGRESS", `Reading "${title}" (${sizeMB} MB)...`);

        const buffer = await file.arrayBuffer();
        let text: string;
        let pages: BookPage[] = [];
        let epubCover: { buffer: Buffer; mimeType: string } | undefined;
        let author: string | undefined;

        switch (ext) {
          case "pdf": {
            send("PROGRESS", "Extracting text from PDF...");
            const pdfResult = await extractPdf(buffer);
            text = pdfResult.text;
            pages = pdfResult.pages;
            send("PROGRESS", `Extracted ${pages.length} pages`);
            break;
          }
          case "epub": {
            send("PROGRESS", "Extracting chapters from EPUB...");
            const epubResult = await extractEpub(buffer, (msg) => send("PROGRESS", msg));
            text = epubResult.text;
            pages = epubResult.pages;
            epubCover = epubResult.cover;
            author = epubResult.author;
            if (epubCover) send("PROGRESS", "Found cover image");
            if (author) send("PROGRESS", `Author: ${author}`);
            send("PROGRESS", `Extracted ${pages.length} chapters`);
            break;
          }
          case "txt": {
            send("PROGRESS", "Reading text file...");
            const txtResult = extractTxt(buffer);
            text = txtResult.text;
            pages = txtResult.pages;
            break;
          }
          default:
            send("ERROR", "Unsupported file type. Use PDF, EPUB, or TXT.");
            controller.close();
            return;
        }

        if (!text.trim()) {
          send("ERROR", "Could not extract any text from this file.");
          controller.close();
          return;
        }

        const wordCount = text.split(/\s+/).filter(Boolean).length;
        send(
          "PROGRESS",
          `Extracted ${wordCount.toLocaleString()} words. Splitting into chunks...`
        );

        const chunkSize = 512;
        const estimatedChunks = Math.ceil(text.length / (chunkSize * 3));
        send(
          "PROGRESS",
          `Creating ~${estimatedChunks} chunks and generating embeddings with Bedrock...`
        );
        send("PROGRESS", "This may take a minute for large books — the AI is reading your book");

        let seriesId: string | undefined;
        const detectedSeriesName = detectSeriesName(file.name);
        if (detectedSeriesName) {
          const existingSeries = listSeries().find(
            (s) => s.name.toLowerCase() === detectedSeriesName.toLowerCase()
          );
          if (existingSeries) {
            seriesId = existingSeries.id;
          } else {
            const created = saveSeries({ name: detectedSeriesName, bookIds: [] });
            seriesId = created.id;
          }
          send("PROGRESS", `Detected series: ${detectedSeriesName}`);
        }

        const book = await addBook(title, file.name, text, wordCount, {
          hasCover: !!epubCover,
          author,
          fileType: ext?.toUpperCase(),
          seriesId,
        });

        saveBookPages(book.id, pages);
        rebuildKnowledgeForBook({ bookId: book.id, bookTitle: book.title, pages });
        await buildSpecialistProfile(book.id, book.title, pages, (msg) =>
          send("PROGRESS", msg)
        );

        if (epubCover) {
          saveCover(book.id, epubCover.buffer, epubCover.mimeType);
        }

        send("PROGRESS", "Done! Opening chat...");
        send("DONE", JSON.stringify({ id: book.id, title: book.title, wordCount }));
        controller.close();
      } catch (error) {
        console.error("Extraction error:", error);
        const msg = error instanceof Error ? error.message : "Unknown error";

        send("ERROR", "Failed to process the file: " + msg);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}
