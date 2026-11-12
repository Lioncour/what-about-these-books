/**
 * Pure formatting helpers for the chat UI (no React, no DOM), so they can be
 * unit-tested and shared between hooks and components.
 */

export type ScopeReason = "named" | "focus" | "series" | "semantic" | "all";

/** Which books an answer was drawn from (`SCOPE` stream line). */
export interface ScopeInfo {
  books: Array<{ id: string; title: string }>;
  reason: ScopeReason;
  /** Books in scope beyond the ones listed in `books`. */
  more?: number;
}

/** What one request cost (`USAGE` stream line). */
export interface UsageInfo {
  claudeCalls: number;
  inputTokens: number;
  outputTokens: number;
  embedCalls: number;
  ms: number;
}

const SCOPE_REASONS: ScopeReason[] = ["named", "focus", "series", "semantic", "all"];
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
    default:
      return "whole library";
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

/** "2 calls · 10.5k tokens in · 1.2k out · 12 s" (never a price). */
export function formatUsageLine(usage: UsageInfo): string {
  const time = formatDuration(usage.ms);
  if (usage.claudeCalls <= 0) {
    return usage.embedCalls > 0
      ? `No AI answer calls · ${usage.embedCalls} meaning search${usage.embedCalls === 1 ? "" : "es"} · ${time}`
      : `No AI calls · exact text search · ${time}`;
  }
  return [
    `${usage.claudeCalls} call${usage.claudeCalls === 1 ? "" : "s"}`,
    `${formatTokenCount(usage.inputTokens)} tokens in`,
    `${formatTokenCount(usage.outputTokens)} out`,
    time,
  ].join(" · ");
}

/** The tidy preview's "N chapter labels in M books" (empty when nothing changes). */
export function formatLabelSummary(labels: Array<{ changed: number }>): string {
  const books = labels.filter((l) => l.changed > 0);
  const total = books.reduce((sum, l) => sum + l.changed, 0);
  if (!total) return "";
  return `${total} chapter label${total === 1 ? "" : "s"} in ${books.length} book${books.length === 1 ? "" : "s"}`;
}
