/**
 * Pure formatting helpers for the chat UI (no React, no DOM), so they can be
 * unit-tested and shared between hooks and components.
 */
import { MAX_LIBRARY_SPECIALIST_BOOKS } from "@/lib/chat/constants";

export type ScopeReason = "named" | "focus" | "series" | "semantic" | "all" | "picked";

/** Which books an answer was drawn from (`SCOPE` stream line). */
export interface ScopeInfo {
  books: Array<{ id: string; title: string }>;
  reason: ScopeReason;
  /** Books in scope beyond the ones listed in `books`. */
  more?: number;
  /** A name for the whole set (the series name), for the composer chip. */
  label?: string;
}

/** What one request cost (`USAGE` stream line). */
export interface UsageInfo {
  claudeCalls: number;
  inputTokens: number;
  outputTokens: number;
  embedCalls: number;
  ms: number;
  /** Rough cost in US dollars at list prices; absent or null when unknown. */
  costUsd?: number | null;
}

/** Librarians read at most this many books per question (the server's specialist cap). */
const LIBRARIANS_READ_LIMIT = MAX_LIBRARY_SPECIALIST_BOOKS;

const SCOPE_REASONS: ScopeReason[] = ["named", "focus", "series", "semantic", "all", "picked"];
const SCOPE_TITLES_SHOWN = 3;

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Validate a decoded SCOPE payload (or one read back from a saved chat). */
export function normalizeScope(value: unknown): ScopeInfo | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { books?: unknown; reason?: unknown; more?: unknown };
  if (!Array.isArray(raw.books)) return null;
  const books = raw.books
    .filter((b): b is { id?: unknown; title?: unknown } => !!b && typeof b === "object")
    .map((b) => ({ id: String(b.id ?? ""), title: String(b.title ?? "").trim() }))
    .filter((b) => b.title);
  const reason = SCOPE_REASONS.includes(raw.reason as ScopeReason)
    ? (raw.reason as ScopeReason)
    : "all";
  const more = Math.floor(count(raw.more));
  if (!books.length && !more && reason !== "all") return null;
  return { books, reason, ...(more > 0 ? { more } : {}) };
}

/** Validate a decoded USAGE payload (or one read back from a saved chat). */
export function normalizeUsage(value: unknown): UsageInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!("claudeCalls" in raw) && !("ms" in raw)) return null;
  return {
    claudeCalls: Math.floor(count(raw.claudeCalls)),
    inputTokens: Math.floor(count(raw.inputTokens)),
    outputTokens: Math.floor(count(raw.outputTokens)),
    embedCalls: Math.floor(count(raw.embedCalls)),
    ms: count(raw.ms),
    ...(typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd >= 0
      ? { costUsd: raw.costUsd }
      : {}),
  };
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function parseScope(data: string): ScopeInfo | null {
  return normalizeScope(parseJson(data));
}

export function parseUsage(data: string): UsageInfo | null {
  return normalizeUsage(parseJson(data));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tidy a stored book title for display: drops file-format tags, extensions and
 * the author/series tails that filenames carry. Client-side counterpart of the
 * server's cleaner, which lives in a module that reads the disk.
 */
export function cleanDisplayTitle(
  title: string,
  hints: { author?: string; series?: string } = {}
): string {
  const original = String(title || "").replace(/\s+/g, " ").trim();
  let t = original.replace(/_/g, " ");
  t = t.replace(/\.(?:epub|pdf|txt|mobi)$/i, "");
  t = t.replace(/\s*[([](?:epub|pdf|txt|mobi)[)\]]\s*/gi, " ");
  const author = hints.author?.trim();
  const dropAuthor = (text: string) =>
    author
      ? text.replace(new RegExp(`\\s*[-–—,]?\\s+(?:by\\s+)?${escapeRegExp(author)}\\s*$`, "i"), "")
      : text;
  t = dropAuthor(t);
  const series = hints.series?.trim();
  if (series) {
    const s = escapeRegExp(series);
    t = t.replace(new RegExp(`\\s*\\(${s}[^)]*\\)`, "gi"), " ");
    // "Title Series Book 3…"
    t = t.replace(
      new RegExp(`(\\S)\\s*[-–—:,]?\\s+${s}\\s*,?\\s*(?:book|vol(?:ume)?\\.?|#)\\s*\\d.*$`, "i"),
      "$1"
    );
    // "Title - Series": a bare trailing name needs a separator, so that
    // "Children of Dune" survives in the series "Dune".
    t = t.replace(new RegExp(`(\\S)\\s*[-–—:,]\\s*${s}\\s*$`, "i"), "$1");
  }
  t = t.replace(/\s*\((?:book|vol(?:ume)?\.?)\s*\d+(?:\.\d+)?\)\s*/gi, " ");
  t = dropAuthor(t);
  t = t.replace(/\s*[-–—:,]\s*$/g, "").replace(/\s+/g, " ").trim();
  return t || original;
}

/** "A", "A and B", "A, B…" — the welcome panel's "Lately that includes" list. */
export function formatTitlesPhrase(titles: string[]): string {
  const list = titles.map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list[0]}, ${list[1]}…`;
}

/** "Read from Columbus Day" / "Read from 6 books: A, B, C +3". */
export function formatScopeLine(scope: ScopeInfo): string {
  const titles = scope.books.map((b) => cleanDisplayTitle(b.title));
  const total = titles.length + (scope.more ?? 0);
  if (total === 0) return "Read from the whole library";
  if (titles.length === 0) return `Read from ${total} book${total === 1 ? "" : "s"}`;
  if (total === 1) return `Read from ${titles[0]}`;
  const shown = titles.slice(0, SCOPE_TITLES_SHOWN);
  const rest = total - shown.length;
  return `Read from ${total} books: ${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/** Why those books: the short hint after the scope line. */
export function scopeReasonHint(reason: ScopeReason): string {
  switch (reason) {
    case "named":
      return "named in your question";
    case "focus":
      return "your focus book";
    case "series":
      return "this series";
    case "semantic":
      return "closest matches";
    case "picked":
      return "the books you picked";
    default:
      return "whole library";
  }
}

/**
 * The composer's scope chip, before a question is sent: what it will be asked against.
 * "Asking Columbus Day" / "Asking 3 books: A, B, C" / "Asking the whole library";
 * a series goes by its name: "Asking Expeditionary Force".
 */
export function formatAskingLine(scope: ScopeInfo): string {
  if (scope.reason === "series" && scope.label?.trim()) return `Asking ${scope.label.trim()}`;
  const titles = scope.books.map((b) => cleanDisplayTitle(b.title));
  const total = titles.length + (scope.more ?? 0);
  if (scope.reason === "all" || total === 0) {
    return total > 1 ? `Asking the whole library · ${total} books` : "Asking the whole library";
  }
  if (total === 1 && titles.length === 1) return `Asking ${titles[0]}`;
  if (titles.length === 0) return `Asking ${total} books`;
  const shown = titles.slice(0, SCOPE_TITLES_SHOWN);
  const rest = total - shown.length;
  return `Asking ${total} books: ${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/** Why the chip says that, when it is worth saying. */
export function askingHint(scope: ScopeInfo): string {
  switch (scope.reason) {
    case "named":
      return "named in your question";
    case "focus":
      return "your focus book";
    case "series":
      return "this series";
    case "picked":
      // Counts and searches use every picked book; the librarians stop at the cap.
      return scope.books.length + (scope.more ?? 0) > LIBRARIANS_READ_LIMIT
        ? `picked by you · librarians read the first ${LIBRARIANS_READ_LIMIT}`
        : "picked by you";
    case "all":
      return "the closest books are chosen when you ask";
    default:
      return "";
  }
}

/** 850 → "850", 10500 → "10.5k", 1200000 → "1.2M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (n >= 999_950) return `${trim(n / 1_000_000)}M`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(Math.round(n));
}

/** 300 → "0.3 s", 12000 → "12 s", 75000 → "1 min 15 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  const seconds = ms / 1000;
  if (seconds < 9.95) return `${Math.max(0.1, seconds).toFixed(1)} s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const rest = whole % 60;
  return rest ? `${Math.floor(whole / 60)} min ${rest} s` : `${Math.floor(whole / 60)} min`;
}

/** The usage line's pieces: "2 calls", "10.5k tokens in", "1.2k out", "≈ $0.04", "12 s". */
export function formatUsageParts(usage: UsageInfo): string[] {
  const time = formatDuration(usage.ms);
  if (usage.claudeCalls <= 0) {
    return usage.embedCalls > 0
      ? [
          "No AI answer calls",
          `${usage.embedCalls} meaning search${usage.embedCalls === 1 ? "" : "es"}`,
          time,
        ]
      : ["No AI calls", "exact text search", time];
  }
  const cost = typeof usage.costUsd === "number" && usage.costUsd > 0 ? formatCost(usage.costUsd) : "";
  return [
    `${usage.claudeCalls} call${usage.claudeCalls === 1 ? "" : "s"}`,
    `${formatTokenCount(usage.inputTokens)} tokens in`,
    `${formatTokenCount(usage.outputTokens)} out`,
    ...(cost ? [cost] : []),
    time,
  ];
}

/** "2 calls · 10.5k tokens in · 1.2k out · ≈ $0.04 · 12 s". */
export function formatUsageLine(usage: UsageInfo): string {
  return formatUsageParts(usage).join(" · ");
}

/** Tooltip of the usage line when it shows a cost. */
const COST_TOOLTIP = "List price estimate, not your AWS bill";

/** The usage line's tooltip: only when the answer came with a cost. */
export function usageTooltip(usage: UsageInfo): string | undefined {
  return typeof usage.costUsd === "number" ? COST_TOOLTIP : undefined;
}

/**
 * A rough dollar amount: "≈ $0.04", "≈ $1.20", and "< $0.01" for the small change. The
 * "≈" is part of it: these are list prices, not the bill.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "";
  if (usd < 0.01) return "< $0.01";
  return `≈ $${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;
}

/**
 * A saved chat's scope in words, for the Past notes drawer: "Whole library", the
 * book's title, "<Series name> series", "3 picked books". Chats saved before the
 * scope fields existed fall back to their stored `bookTitle`.
 */
export function savedScopeWords(chat: {
  bookId?: unknown;
  bookTitle?: unknown;
  pickedIds?: unknown;
}): string {
  const bookId = typeof chat.bookId === "string" ? chat.bookId : "";
  const bookTitle = typeof chat.bookTitle === "string" ? chat.bookTitle.trim() : "";
  const picked = Array.isArray(chat.pickedIds)
    ? new Set(chat.pickedIds.filter((id) => typeof id === "string" && id)).size
    : 0;
  if (!bookId) return bookTitle || "Whole library";
  if (bookId === "all") {
    if (picked >= 2) return `${picked} picked books`;
    // The chat list carries only the title of a pick ("3 picked books").
    return /^\d+ picked books$/.test(bookTitle) ? bookTitle : "Whole library";
  }
  if (bookId.startsWith("series:")) {
    if (!bookTitle) return "A series";
    return /\bseries$/i.test(bookTitle) ? bookTitle : `${bookTitle} series`;
  }
  return bookTitle ? cleanDisplayTitle(bookTitle) : "One book";
}

/** The tidy preview's "N chapter labels in M books" (empty when nothing changes). */
export function formatLabelSummary(labels: Array<{ changed: number }>): string {
  const books = labels.filter((l) => l.changed > 0);
  const total = books.reduce((sum, l) => sum + l.changed, 0);
  if (!total) return "";
  return `${total} chapter label${total === 1 ? "" : "s"} in ${books.length} book${books.length === 1 ? "" : "s"}`;
}

/** The picker's footer note once more books are ticked than the librarians read. */
export function pickedLimitNote(tickedCount: number): string {
  if (tickedCount <= LIBRARIANS_READ_LIMIT) return "";
  return `Counts and searches use all ${tickedCount}; the librarians read the first ${LIBRARIANS_READ_LIMIT}.`;
}

/** The welcome panel's starter questions. */
export function welcomeSuggestions(
  focus: "book" | "series" | null,
  bookCount: number,
  firstTitle?: string
): string[] {
  if (focus === "series") {
    return [
      "What's this series about?",
      "Who matters most across these books?",
      "How does the story change from the first book to the last?",
      "Find a memorable quote",
    ];
  }
  if (focus) {
    return [
      "What's this one about?",
      "Who matters most here?",
      "Any pop-culture references?",
      "Find a memorable quote",
    ];
  }
  if (bookCount > 0) {
    const title = firstTitle?.trim();
    return [
      "Any pop culture references in the books?",
      // Naming a book in the question scopes it, no picker needed.
      ...(title ? [`In ${title}, what happens first?`] : []),
      "Who shows up across the series?",
      "Help me pick what to reread",
      "How many times is Skippy mentioned in the first 7 books?",
    ];
  }
  return ["What can you do?", "How do I add a book?"];
}
