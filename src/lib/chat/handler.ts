import { NextRequest } from "next/server";
import { isAbortError } from "@/lib/bedrock-client";
import { logChatEvent } from "@/lib/chat-debug";
import { buildChatContext, type ChatContext, type ChatStep } from "@/lib/chat/context";
import { emptyUsage, runWithRequestContext, type RequestUsage } from "@/lib/chat/request-context";
import { describeRoute } from "@/lib/chat/router";
import { haveYouReadStep, libraryCountStep } from "@/lib/chat/steps/catalog-facts";
import { entityGraphStep, timelineConflictsStep } from "@/lib/chat/steps/knowledge";
import { libraryCommandStep } from "@/lib/chat/steps/library-command";
import { mainCharactersStep } from "@/lib/chat/steps/main-characters";
import { exactCountStep, followUpCountStep } from "@/lib/chat/steps/mention-count";
import { passageFindStep } from "@/lib/chat/steps/passage-find";
import { quoteLookupStep } from "@/lib/chat/steps/quote-lookup";
import { ragStep } from "@/lib/chat/steps/rag";
import { smallTalkStep } from "@/lib/chat/steps/small-talk";
import { specialistsStep } from "@/lib/chat/steps/specialists";
import { themeSurveyStep } from "@/lib/chat/steps/theme-survey";
import { whoIsStep } from "@/lib/chat/steps/who-is";
import { createStreamWriter, type StreamWriter } from "@/lib/chat/stream-writer";
import type { ChatMessage } from "@/lib/chat/types";

export const maxDuration = 120;

/** Progress lines between the steps; they never answer. */
const announceRoute: ChatStep = (ctx) => {
  ctx.status(describeRoute(ctx.route));
  return false;
};
const announceSearch: ChatStep = (ctx) => {
  ctx.status(ctx.scope.text.searching);
  return false;
};

/**
 * The one pipeline, for every scope (library / series / book — see `Scope`). Steps run
 * in order; the first that returns true has answered. Deterministic tools come first,
 * then the Claude paths; `ragStep` always answers.
 */
const PIPELINE: ChatStep[] = [
  libraryCommandStep,
  exactCountStep,
  announceRoute,
  passageFindStep,
  themeSurveyStep,
  entityGraphStep,
  timelineConflictsStep,
  announceSearch,
  haveYouReadStep,
  libraryCountStep,
  whoIsStep,
  smallTalkStep,
  mainCharactersStep,
  followUpCountStep,
  specialistsStep,
  quoteLookupStep,
  ragStep,
];

interface ChatRequest {
  bookId: string;
  bookTitle: string;
  messages: ChatMessage[];
  lastUserMessage: ChatMessage;
}

/** USAGE: what this request spent, sent right before the stream closes. */
function sendUsage(writer: StreamWriter, usage: RequestUsage, startedAt: number): void {
  writer.field("USAGE", JSON.stringify({ ...usage, ms: Date.now() - startedAt }));
}

async function runPipeline(input: ChatRequest, writer: StreamWriter, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const usage = emptyUsage();
  let ctx: ChatContext | null = null;
  try {
    await runWithRequestContext({ signal, usage }, async () => {
      ctx = buildChatContext({ ...input, signal, writer });
      for (const step of PIPELINE) {
        ctx.checkpoint();
        if (await step(ctx)) break;
      }
      // Answers that read no book (commands, small talk, graph lookups) say so: no books.
      ctx.announceScope([]);
    });
    sendUsage(writer, usage, startedAt);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      logChatEvent("chat_stream_aborted", { bookId: input.bookId });
      return;
    }
    console.error("Stream error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    logChatEvent("chat_stream_error", { bookId: input.bookId, error: msg });
    const authProblem = /ExpiredToken|credentials|Unable to locate credentials|Forbidden|AccessDenied/i.test(msg);
    writer.field(
      "ERROR",
      authProblem
        ? "Failed to generate response. AWS credentials or Bedrock permissions are invalid/expired. Run AWS login again and verify model access."
        : "Failed to generate response. " + msg
    );
    sendUsage(writer, usage, startedAt);
  } finally {
    writer.close();
  }
}

export async function POST(request: NextRequest) {
  try {
    const { bookId, bookTitle, messages } = (await request.json()) as {
      bookId: string;
      bookTitle: string;
      messages: ChatMessage[];
    };
    if (!bookId || !messages?.length) {
      return Response.json({ error: "Missing book ID or messages" }, { status: 400 });
    }
    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMessage) {
      return Response.json({ error: "No user message" }, { status: 400 });
    }
    logChatEvent("chat_request_received", {
      bookId,
      bookTitle,
      messageCount: messages.length,
      lastUserMessage: lastUserMessage.content.slice(0, 300),
    });

    // One abort signal for the whole pipeline: the client's Stop (request.signal) or the
    // stream being cancelled stops every Bedrock call still in flight, embeddings included.
    const abort = new AbortController();
    const onRequestAbort = () => abort.abort();
    if (request.signal.aborted) abort.abort();
    else request.signal.addEventListener("abort", onRequestAbort, { once: true });

    let writer: StreamWriter | null = null;
    const readable = new ReadableStream<Uint8Array>({
      cancel() {
        writer?.markClosed();
        abort.abort();
      },
      async start(controller) {
        writer = createStreamWriter(controller);
        try {
          await runPipeline({ bookId, bookTitle, messages, lastUserMessage }, writer, abort.signal);
        } finally {
          request.signal.removeEventListener("abort", onRequestAbort);
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
    logChatEvent("chat_request_error", { error: msg });
    return Response.json({ error: "Failed to generate response. " + msg }, { status: 500 });
  }
}
