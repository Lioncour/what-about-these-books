import { DEFAULT_BEDROCK_MODEL_ID } from "@/lib/bedrock-client";
import { listBooks, listSeries, loadSettings, type AISettings, type CountMode, type SeriesEntry } from "@/lib/book-store";
import { logChatEvent } from "@/lib/chat-debug";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import {
  buildRecentConversation,
  buildSeriesContinuityHint,
  countScopeQuestion,
  extractRetryQuestion,
  normalizeUserQuestion,
  resolveCountTarget,
  resolveQuoteMode,
} from "@/lib/chat/intent";
import { listOrderedSeriesBooks } from "@/lib/chat/mention-count";
import { looksLikeThinAnswer } from "@/lib/chat/orchestrator";
import { presenceStatus } from "@/lib/chat/presence";
import { buildPersonalityInstructions } from "@/lib/chat/response-formatting";
import { routeChatQuestion, type ChatRoute } from "@/lib/chat/router";
import { buildScope, type Scope, type ScopeReason } from "@/lib/chat/scope";
import type { BookRef } from "@/lib/chat/specialist-limits";
import type { StreamWriter } from "@/lib/chat/stream-writer";
import type { ChatMessage, ChatSource } from "@/lib/chat/types";

/** Sources sent per answer, and books listed in a SCOPE line. */
const MAX_SOURCES_PER_ANSWER = 40;
const MAX_SCOPE_BOOKS = 20;

export interface ChatSettings {
  ai: AISettings;
  /** A fixed librarian model from Settings; undefined is auto (cheaper models first). */
  specialistModelId?: string;
  orchestratorModelId: string;
  groundedMode: boolean;
  countMode: CountMode;
  answerMode: string;
  companionMode: boolean;
  /** The user's personality settings as prompt lines. */
  personality(): string;
}

/** Everything a pipeline step needs: the question, where it is asked, and the stream. */
export interface ChatContext {
  bookId: string;
  bookTitle: string;
  messages: ChatMessage[];
  lastUserMessage: ChatMessage;
  /** The normalised question (a retry request restored to the original question). */
  question: string;
  settings: ChatSettings;
  signal: AbortSignal;
  scope: Scope;
  route: ChatRoute;
  /** Who/what an exact count is for, when the message asks for one (or follows one up). */
  mentionTarget: string | null;
  /** Text for an exact-quote lookup, when the message is one. */
  quoteMode: string | null;
  recentConversation: string;
  continuityHint: string;

  /** Raw line: the payload must be single-line (JSON). */
  send(type: string, payload: string): void;
  /** Progress line (mapped to presence copy in companion mode). */
  status(text: string): void;
  error(message: string): void;
  emitAnswer(text: string, meta?: Record<string, unknown>): void;
  emitToken(delta: string): void;
  sendSources(rows: ChatSource[]): void;
  /** SCOPE line: the books this answer is drawn from. Only the first call counts. */
  announceScope(books?: BookRef[], reason?: ScopeReason): void;
  /** A second SCOPE line when more books are read than first announced (the last one wins). */
  widenScope(books: BookRef[], reason: ScopeReason): void;
  /** Stop here if the request was cancelled. */
  checkpoint(): void;
}

/** A pipeline step: true when it answered the request. */
export type ChatStep = (ctx: ChatContext) => Promise<boolean> | boolean;

function readSettings(): ChatSettings {
  const ai = loadSettings();
  const answerMode = ai.answerMode || "Evidence-heavy";
  const companionMode = ai.companionMode !== false;
  return {
    ai,
    specialistModelId: ai.modelRouting?.specialistModelId?.trim() || undefined,
    orchestratorModelId: ai.modelRouting?.orchestratorModelId || DEFAULT_BEDROCK_MODEL_ID,
    groundedMode: Boolean(ai.groundedMode),
    countMode: ai.countMode || "whole_word",
    answerMode,
    companionMode,
    personality: () =>
      buildPersonalityInstructions({
        language: ai.language,
        tone: ai.tone,
        focusAreas: ai.focusAreas,
        customInstructions: ai.customInstructions,
        answerMode,
        companionMode,
      }),
  };
}

/** The series whose reading order open-ended answers should respect. */
function seriesForContinuity(scope: Scope, bookId: string, counted: SeriesEntry | null): SeriesEntry | null {
  if (counted) return counted;
  if (scope.kind === "series") return scope.series;
  if (scope.kind === "book") return listSeries().find((s) => s.bookIds.includes(bookId)) || null;
  return null;
}

export function buildChatContext(input: {
  bookId: string;
  bookTitle: string;
  /** Books the reader picked by hand for this question (two or more narrow the scope). */
  bookIds?: string[];
  messages: ChatMessage[];
  lastUserMessage: ChatMessage;
  signal: AbortSignal;
  writer: StreamWriter;
}): ChatContext {
  const { bookId, bookTitle, messages, lastUserMessage, signal, writer } = input;
  const settings = readSettings();

  const retry = extractRetryQuestion(lastUserMessage.content);
  const question = normalizeUserQuestion(retry?.question || lastUserMessage.content);
  if (retry) {
    logChatEvent("chat_retry_requested", {
      bookId,
      step: retry.step,
      originalInput: lastUserMessage.content.slice(0, 220),
      restoredQuestion: question.slice(0, 220),
    });
  }

  const mentionTarget = resolveCountTarget(question, messages);
  // "and Joe?" counts where the count before it did ("…in Columbus Day?"), unless the
  // follow-up says where itself.
  const countQuestion = mentionTarget ? countScopeQuestion(question, messages.slice(0, -1)) : question;
  const scope = buildScope(bookId, bookTitle, question, input.bookIds, countQuestion);

  let recentConversation = settings.ai.useConversationMemory === false ? "" : buildRecentConversation(messages);
  const ordered = seriesForContinuity(scope, bookId, mentionTarget ? scope.mentionSeries() : null);
  const continuityHint = buildSeriesContinuityHint({
    orderedTitles: ordered ? listOrderedSeriesBooks(ordered.id).map((r) => cleanBookDisplayTitle(r.book.title)) : [],
    focusTitle: bookTitle,
  });
  if (continuityHint) {
    recentConversation = recentConversation ? `${continuityHint}\n\n${recentConversation}` : continuityHint;
  }

  const route = routeChatQuestion({ question, messages, answerMode: settings.answerMode });
  logChatEvent("chat_routed", {
    bookId,
    kind: route.kind,
    reason: route.reason,
    usesTool: route.usesTool,
    target: route.target || null,
    mentionTarget,
    retryStep: retry?.step || null,
  });

  let scopeAnnounced = false;

  return {
    bookId,
    bookTitle,
    messages,
    lastUserMessage,
    question,
    settings,
    signal,
    scope,
    route,
    mentionTarget,
    quoteMode: resolveQuoteMode(question),
    recentConversation,
    continuityHint,

    send: (type, payload) => writer.line(type, payload),
    status: (text) => writer.line("STATUS", presenceStatus(text, settings.companionMode)),
    error: (message) => writer.field("ERROR", message),
    emitAnswer(text, meta) {
      writer.field("TEXT", text);
      logChatEvent("chat_answer_emitted", { bookId, chars: text.length, thin: looksLikeThinAnswer(text), ...meta });
    },
    emitToken(delta) {
      if (delta) writer.field("TOKEN", delta);
    },
    sendSources(rows) {
      if (!rows.length) return;
      // Citations carry the book's id so the reader can open them after a retitle.
      const idByTitle = new Map(listBooks().map((b) => [b.title, b.id]));
      const withIds = rows
        .slice(0, MAX_SOURCES_PER_ANSWER)
        .map((r) => (r.bookId || !idByTitle.has(r.book) ? r : { ...r, bookId: idByTitle.get(r.book) }));
      writer.line("SOURCES", JSON.stringify(withIds));
    },
    widenScope(books, reason) {
      scopeAnnounced = true;
      const listed = books.slice(0, MAX_SCOPE_BOOKS).map((b) => ({ id: b.id, title: cleanBookDisplayTitle(b.title) }));
      const more = books.length - listed.length;
      writer.field("SCOPE", JSON.stringify({ books: listed, reason, ...(more > 0 ? { more } : {}) }));
    },
    announceScope(books = scope.books, reason = scope.reason) {
      if (scopeAnnounced) return;
      scopeAnnounced = true;
      const listed = books.slice(0, MAX_SCOPE_BOOKS).map((b) => ({ id: b.id, title: cleanBookDisplayTitle(b.title) }));
      const more = books.length - listed.length;
      writer.field("SCOPE", JSON.stringify({ books: listed, reason, ...(more > 0 ? { more } : {}) }));
    },
    checkpoint: () => signal.throwIfAborted(),
  };
}
