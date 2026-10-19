import { NextRequest } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import EPub from "epub2";
import { DEFAULT_BEDROCK_MODEL_ID } from "@/lib/bedrock-client";
import { callClaudeText, extractJsonObject } from "@/lib/bedrock-claude";
import {
  detectSeriesName,
  normalizeTextId,
  normalizeSeriesKey,
  cleanSeriesDisplayName,
  titleFromFilename,
} from "@/lib/series-detection";
import { resolveSeriesName } from "@/lib/series-lookup";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  addBook,
  loadSettings,
  saveCover,
  findBookByFilename,
  saveBookPages,
  listBooks,
  listSeries,
  saveSeries,
  saveBookSpecialistProfile,
} from "@/lib/book-store";
import type { BookPage } from "@/lib/book-store";
import { rebuildKnowledgeForBook } from "@/lib/knowledge-store";

export const maxDuration = 300;

function findLikelyDuplicate(params: { filename: string; title: string; author?: string }): { id: string; title: string } | null {
  const existing = findBookByFilename(params.filename);
  if (existing) return { id: existing.id, title: existing.title };
  const books = listBooks();
  const incomingTitle = normalizeTextId(params.title);
  const incomingFileTitle = normalizeTextId(titleFromFilename(params.filename));
  const incomingAuthor = params.author?.toLowerCase().trim();
  for (const book of books) {
    const bookTitle = normalizeTextId(book.title);
    const bookFileTitle = normalizeTextId(titleFromFilename(book.filename));
    const authorMatch =
      !incomingAuthor || !book.author || book.author.toLowerCase().trim() === incomingAuthor;
    const titleMatch =
      incomingTitle === bookTitle ||
      incomingTitle === bookFileTitle ||
      incomingFileTitle === bookTitle ||
      incomingFileTitle === bookFileTitle;
    if (authorMatch && titleMatch) return { id: book.id, title: book.title };
  }
  return null;
}

function inferSeriesIdFromAuthor(author?: string): string | undefined {
  if (!author) return undefined;
  const authorKey = author.toLowerCase().trim();
  const books = listBooks();
  const series = listSeries();
  const counts = new Map<string, number>();
  for (const s of series) {
    let count = 0;
    for (const bookId of s.bookIds) {
      const book = books.find((b) => b.id === bookId);
      if (book?.author?.toLowerCase().trim() === authorKey) count++;
    }
    if (count > 0) counts.set(s.id, count);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return undefined;
  return best[0];
}

async function buildSpecialistProfile(
  bookId: string,
  title: string,
  pages: BookPage[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const settings = loadSettings();
  const extractionModelId = settings.modelRouting?.extractionModelId || DEFAULT_BEDROCK_MODEL_ID;
  const combined = pages
    .slice(0, 40)
    .map((p) => `[${p.label}]\n${p.text}`)
    .join("\n\n---\n\n")
    .slice(0, 30000);

  if (!combined.trim()) return;
  onProgress?.("Training specialist AI profile for this book...");

  try {
    const prompt =
      "You are creating a specialist memory profile for one book. Return strict JSON only with keys: summary (string), keyTopics (string[]), notableEntities (string[]), styleNotes (string[]), keyCharacters (string[]), keyLocations (string[]), glossary (string[]), timelineHighlights (string[]).";
    const raw = await callClaudeText(
      `${prompt}\n\nBook: ${title}\n\nExtracted passages:\n${combined}`,
      1200,
      0.2,
      extractionModelId
    );
    const json = extractJsonObject(raw);
    if (!json) throw new Error("No JSON in response");
    const parsed = JSON.parse(json) as {
      summary?: string;
      keyTopics?: string[];
      notableEntities?: string[];
      styleNotes?: string[];
      keyCharacters?: string[];
      keyLocations?: string[];
      glossary?: string[];
      timelineHighlights?: string[];
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
      keyCharacters: Array.isArray(parsed.keyCharacters) ? parsed.keyCharacters.map(String).slice(0, 20) : [],
      keyLocations: Array.isArray(parsed.keyLocations) ? parsed.keyLocations.map(String).slice(0, 20) : [],
      glossary: Array.isArray(parsed.glossary) ? parsed.glossary.map(String).slice(0, 30) : [],
      timelineHighlights: Array.isArray(parsed.timelineHighlights)
        ? parsed.timelineHighlights.map(String).slice(0, 20)
        : [],
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
      keyCharacters: [],
      keyLocations: [],
      glossary: [],
      timelineHighlights: [],
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

/** Scale timeouts for large EPUBs (full novels often exceed 30s just to open). */
function getEpubTimeouts(fileSizeBytes: number) {
  const mb = fileSizeBytes / (1024 * 1024);
  const openMs = Math.min(300_000, Math.round(120_000 + mb * 30_000));
  const chapterMs = Math.min(120_000, Math.round(30_000 + mb * 8_000));
  const fullMs = Math.min(280_000, Math.round(240_000 + mb * 45_000));
  return { openMs, chapterMs, fullMs };
}

interface EpubFlowItem {
  id?: string;
}

interface EpubBook {
  flow: EpubFlowItem[];
  metadata?: { cover?: string; creator?: string };
  getChapterAsync(id: string): Promise<string>;
  getImageAsync(id: string): Promise<[Buffer, string]>;
}

async function extractEpubInner(
  filePath: string,
  timeouts: ReturnType<typeof getEpubTimeouts>,
  onProgress?: (msg: string) => void
): Promise<EpubResult> {
  onProgress?.(
    `Opening EPUB structure (up to ${Math.ceil(timeouts.openMs / 60_000)} min for large files)...`
  );
  const epub = (await withTimeout(
    EPub.createAsync(filePath),
    timeouts.openMs,
    "EPUB parsing"
  )) as EpubBook;

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
          timeouts.chapterMs,
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

  const timeouts = getEpubTimeouts(buffer.byteLength);

  try {
    return await withTimeout(
      extractEpubInner(filePath, timeouts, onProgress),
      timeouts.fullMs,
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

        const existing = findLikelyDuplicate({ filename: file.name, title, author: undefined });
        if (existing) {
          send(
            "ERROR",
            `DUPLICATE:You have this book already ("${existing.title}").`
          );
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

        const dedupeAfterExtract = findLikelyDuplicate({ filename: file.name, title, author });
        if (dedupeAfterExtract) {
          send(
            "ERROR",
            `DUPLICATE:You have this book already ("${dedupeAfterExtract.title}").`
          );
          controller.close();
          return;
        }

        let seriesId: string | undefined;
        send("PROGRESS", "Checking series metadata (Open Library + title patterns)...");
        const seriesHint = await resolveSeriesName({
          filename: file.name,
          title,
          author,
          allowRemote: true,
        });
        const detectedSeriesName =
          seriesHint?.name || detectSeriesName(file.name, title, author);
        if (detectedSeriesName) {
          const cleaned = cleanSeriesDisplayName(detectedSeriesName) || detectedSeriesName;
          const key = normalizeSeriesKey(cleaned);
          const existingSeries = listSeries().find((s) => {
            const sk = normalizeSeriesKey(cleanSeriesDisplayName(s.name) || s.name);
            return sk === key || (sk.length >= 8 && key.length >= 8 && (sk.includes(key) || key.includes(sk)));
          });
          if (existingSeries) {
            seriesId = existingSeries.id;
            saveSeries({
              id: existingSeries.id,
              name: cleaned,
              bookIds: [...new Set([...existingSeries.bookIds])],
            });
          } else {
            const created = saveSeries({ name: cleaned, bookIds: [] });
            seriesId = created.id;
          }
          send(
            "PROGRESS",
            `Series: ${cleaned}${seriesHint?.source === "openlibrary" ? " (Open Library)" : ""}`
          );
        } else {
          const inferredSeriesId = inferSeriesIdFromAuthor(author);
          if (inferredSeriesId) {
            seriesId = inferredSeriesId;
            const inferred = listSeries().find((s) => s.id === inferredSeriesId);
            if (inferred) {
              send("PROGRESS", `Inferred series by author: ${inferred.name}`);
            }
          }
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
