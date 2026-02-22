import { NextRequest } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import EPub from "epub2";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { addBook, saveCover, findBookByFilename } from "@/lib/book-store";

export const maxDuration = 300;

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

async function extractPdf(buffer: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf);
  return text.join("\n\n");
}

interface EpubResult {
  text: string;
  cover?: { buffer: Buffer; mimeType: string };
}

async function extractEpub(buffer: ArrayBuffer): Promise<EpubResult> {
  const dir = await mkdtemp(join(tmpdir(), "epub-"));
  const filePath = join(dir, "book.epub");
  await writeFile(filePath, Buffer.from(buffer));

  try {
    const epub = await EPub.createAsync(filePath);
    const chapters: string[] = [];

    for (const item of epub.flow) {
      if (item.id) {
        try {
          const text = await epub.getChapterAsync(item.id);
          const plainText = text
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (plainText) chapters.push(plainText);
        } catch {
          // Skip unreadable chapters
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

    return { text: chapters.join("\n\n"), cover };
  } finally {
    await unlink(filePath).catch(() => {});
  }
}

function extractTxt(buffer: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(buffer);
}

export async function POST(request: NextRequest) {
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
        let epubCover: { buffer: Buffer; mimeType: string } | undefined;

        switch (ext) {
          case "pdf":
            send("PROGRESS", "Extracting text from PDF...");
            text = await extractPdf(buffer);
            break;
          case "epub": {
            send("PROGRESS", "Extracting chapters from EPUB...");
            const epubResult = await extractEpub(buffer);
            text = epubResult.text;
            epubCover = epubResult.cover;
            if (epubCover) send("PROGRESS", "Found cover image");
            break;
          }
          case "txt":
            send("PROGRESS", "Reading text file...");
            text = extractTxt(buffer);
            break;
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
          `Creating ~${estimatedChunks} chunks and generating embeddings with Ollama...`
        );
        send("PROGRESS", "This may take a minute for large books — the AI is reading your book");

        const book = await addBook(title, file.name, text, wordCount, !!epubCover);

        if (epubCover) {
          saveCover(book.id, epubCover.buffer, epubCover.mimeType);
        }

        send("PROGRESS", "Done! Opening chat...");
        send("DONE", JSON.stringify({ id: book.id, title: book.title, wordCount }));
        controller.close();
      } catch (error) {
        console.error("Extraction error:", error);
        const msg = error instanceof Error ? error.message : "Unknown error";

        if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
          send(
            "ERROR",
            "Cannot connect to Ollama. Make sure Ollama is running (open the Ollama app or run 'ollama serve')."
          );
        } else {
          send("ERROR", "Failed to process the file: " + msg);
        }
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
