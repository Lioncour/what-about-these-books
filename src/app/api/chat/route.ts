import { NextRequest } from "next/server";
import { Ollama } from "ollama";
import { queryBook, queryAllBooks } from "@/lib/book-store";

const ollama = new Ollama({ host: "http://127.0.0.1:11434" });

export const maxDuration = 120;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const { bookId, bookTitle, messages } = (await request.json()) as {
      bookId: string;
      bookTitle: string;
      messages: ChatMessage[];
    };

    if (!bookId || !messages?.length) {
      return Response.json(
        { error: "Missing book ID or messages" },
        { status: 400 }
      );
    }

    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMessage) {
      return Response.json({ error: "No user message" }, { status: 400 });
    }

    const readable = new ReadableStream({
      async start(controller) {
        const send = (type: string, data: string) => {
          controller.enqueue(encoder.encode(`${type}:${data}\n`));
        };

        try {
          let systemPrompt: string;

          interface Source {
            book: string;
            excerpt: string;
          }
          const sources: Source[] = [];

          if (bookId === "all") {
            send("STATUS", "Searching across your entire library...");

            const passages = await queryAllBooks(lastUserMessage.content, 10);

            if (passages.length) {
              const bookNames = [...new Set(passages.map((p) => p.bookTitle))];
              send(
                "STATUS",
                `Found ${passages.length} relevant passages from ${bookNames.length === 1 ? `"${bookNames[0]}"` : `${bookNames.length} books: ${bookNames.map((n) => `"${n}"`).join(", ")}`}`
              );
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            const context = passages.length
              ? passages
                  .map((p, i) => {
                    sources.push({
                      book: p.bookTitle,
                      excerpt: p.text.slice(0, 120).replace(/\s+/g, " ").trim(),
                    });
                    return `[Passage ${i + 1} — from "${p.bookTitle}"]\n${p.text}`;
                  })
                  .join("\n\n---\n\n")
              : "(No relevant passages found across your library.)";

            systemPrompt = `You are a helpful book assistant. The user has a library of books and wants to ask questions across all of them.

IMPORTANT: You MUST cite your sources. When you use information from a passage, reference it like this: (Passage 1, "Book Title"). Always tell the user which book the information comes from.

Answer questions accurately based ONLY on the provided passages. Be conversational but precise.

If the passages don't contain enough information to answer the question, say so honestly.

Relevant passages from the user's library:

${context}`;
          } else {
            send("STATUS", `Searching "${bookTitle}" for relevant passages...`);

            const relevantChunks = await queryBook(bookId, lastUserMessage.content, 8);

            if (relevantChunks.length) {
              send("STATUS", `Found ${relevantChunks.length} relevant passages`);
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            const context = relevantChunks.length
              ? relevantChunks
                  .map((text, i) => {
                    sources.push({
                      book: bookTitle,
                      excerpt: text.slice(0, 120).replace(/\s+/g, " ").trim(),
                    });
                    return `[Passage ${i + 1}]\n${text}`;
                  })
                  .join("\n\n---\n\n")
              : "(No relevant passages found for this question.)";

            systemPrompt = `You are a helpful book assistant. The user has uploaded a book titled "${bookTitle}" and wants to discuss it with you.

IMPORTANT: You MUST cite your sources. When you use information from a passage, reference it like this: (Passage 1). This helps the user find the relevant section in their book.

Answer questions accurately based ONLY on the provided passages. Be conversational but precise.

If the passages don't contain enough information to answer the question, say so honestly.

Relevant passages from "${bookTitle}":

${context}`;
          }

          send("STATUS", "Thinking...");

          const ollamaMessages = [
            { role: "system" as const, content: systemPrompt },
            ...messages.map((m) => ({
              role: m.role === "user" ? ("user" as const) : ("assistant" as const),
              content: m.content,
            })),
          ];

          const stream = await ollama.chat({
            model: "llama3.1:8b",
            messages: ollamaMessages,
            stream: true,
          });

          let firstChunk = true;
          for await (const chunk of stream) {
            const text = chunk.message?.content;
            if (text) {
              if (firstChunk) {
                send("STATUS", "Writing response...");
                firstChunk = false;
              }
              controller.enqueue(encoder.encode(`TEXT:${text}\n`));
            }
          }

          if (sources.length) {
            send("SOURCES", JSON.stringify(sources));
          }

          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          const msg = error instanceof Error ? error.message : String(error);

          if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
            send("ERROR", "Cannot connect to Ollama. Make sure Ollama is running.");
          } else {
            send("ERROR", "Failed to generate response. " + msg);
          }
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Chat error:", error);
    const msg = error instanceof Error ? error.message : String(error);

    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      return Response.json(
        { error: "Cannot connect to Ollama. Make sure Ollama is running." },
        { status: 503 }
      );
    }

    return Response.json(
      { error: "Failed to generate response. " + msg },
      { status: 500 }
    );
  }
}
