/**
 * Pure scope decisions for the chat UI (no React, no DOM): what a ticked set of
 * books means, what is sent with a question, what is saved with a chat and how
 * it is read back.
 */
import type { ScopeInfo } from "@/components/chat/format";
import type { FocusBook } from "@/components/chat/messages";

const SERIES_FOCUS_PREFIX = "series:";

/** A book as the scope picker and these helpers need it. */
export interface ScopeBook {
  id: string;
  title: string;
}

/** A series with the books of it that are on the shelves, in reading order. */
export interface ScopeSeries {
  id: string;
  name: string;
  bookIds: string[];
}

/** What the next question is asked against. */
export type AskScope =
  | { kind: "all" }
  | { kind: "book"; focus: FocusBook }
  | { kind: "series"; focus: FocusBook }
  | { kind: "picked"; ids: string[] };

/** The series id inside a series focus ("series:<id>"), or null for a book focus. */
export function seriesIdOfFocus(focusId: string | null | undefined): string | null {
  if (!focusId || !focusId.startsWith(SERIES_FOCUS_PREFIX)) return null;
  return focusId.slice(SERIES_FOCUS_PREFIX.length) || null;
}

function seriesFocus(series: { id: string; name: string }): FocusBook {
  return { id: `${SERIES_FOCUS_PREFIX}${series.id}`, title: series.name };
}

/**
 * The series whose books are exactly the ticked set (all of them, nothing else).
 * A one-book series is not a match: that is simply a focus book.
 */
export function exactSeriesFor(ids: string[], series: ScopeSeries[]): ScopeSeries | null {
  const ticked = new Set(ids);
  if (ticked.size < 2) return null;
  return (
    series.find((s) => {
      const own = new Set(s.bookIds);
      return own.size === ticked.size && [...own].every((id) => ticked.has(id));
    }) || null
  );
}

/** The picker's answer: nothing = whole library, one = focus book, a whole series = series, more = picked set. */
export function scopeFromTicked(ids: string[], books: ScopeBook[], series: ScopeSeries[]): AskScope {
  const known = books.filter((b) => ids.includes(b.id));
  if (known.length === 0) return { kind: "all" };
  if (known.length === 1) return { kind: "book", focus: { id: known[0].id, title: known[0].title } };
  const whole = exactSeriesFor(
    known.map((b) => b.id),
    series
  );
  if (whole) return { kind: "series", focus: seriesFocus(whole) };
  return { kind: "picked", ids: known.map((b) => b.id) };
}

/** Which boxes are ticked when the picker opens. */
export function tickedIdsFor(
  focus: FocusBook | null,
  pickedIds: string[],
  series: ScopeSeries[]
): string[] {
  if (!focus) return pickedIds;
  const seriesId = seriesIdOfFocus(focus.id);
  if (!seriesId) return [focus.id];
  return series.find((s) => s.id === seriesId)?.bookIds ?? [];
}

/** The scope fields of a chat request (and of a saved chat). */
export interface ScopeRequest {
  bookId: string;
  bookTitle: string;
  bookIds?: string[];
}

export function scopeToRequest(focus: FocusBook | null, pickedIds: string[]): ScopeRequest {
  return {
    bookId: focus?.id || "all",
    bookTitle: focus?.title || "All Books",
    ...(!focus && pickedIds.length >= 2 ? { bookIds: pickedIds } : {}),
  };
}

/** The scope as it is stored with a saved chat. */
export interface SavedScope {
  bookId: string;
  bookTitle: string;
  pickedIds?: string[];
}

export function scopeToSaved(focus: FocusBook | null, pickedIds: string[]): SavedScope {
  const request = scopeToRequest(focus, pickedIds);
  return {
    bookId: request.bookId,
    bookTitle: request.bookIds ? `${request.bookIds.length} picked books` : request.bookTitle,
    ...(request.bookIds ? { pickedIds: request.bookIds } : {}),
  };
}

/**
 * Read a saved chat's scope back. Chats saved before picks were kept still load
 * (focus book, series or whole library). With the library known, books and series
 * that are gone are dropped; with `library` null (not loaded yet) ids are kept as
 * saved and filtered when it arrives.
 */
export function restoreSavedScope(
  raw: unknown,
  library: { books: ScopeBook[]; series: ScopeSeries[] } | null
): { focus: FocusBook | null; pickedIds: string[] } {
  const none = { focus: null, pickedIds: [] };
  if (!raw || typeof raw !== "object") return none;
  const saved = raw as { bookId?: unknown; bookTitle?: unknown; pickedIds?: unknown };
  const bookId = typeof saved.bookId === "string" ? saved.bookId : "";
  const bookTitle = typeof saved.bookTitle === "string" ? saved.bookTitle : "";

  if (bookId && bookId !== "all") {
    if (!library) return { focus: { id: bookId, title: bookTitle || bookId }, pickedIds: [] };
    const seriesId = seriesIdOfFocus(bookId);
    if (seriesId) {
      const series = library.series.find((s) => s.id === seriesId);
      return series ? { focus: seriesFocus(series), pickedIds: [] } : none;
    }
    return library.books.some((b) => b.id === bookId)
      ? { focus: { id: bookId, title: bookTitle || bookId }, pickedIds: [] }
      : none;
  }

  const ids = Array.isArray(saved.pickedIds)
    ? [...new Set(saved.pickedIds.filter((id): id is string => typeof id === "string" && !!id))]
    : [];
  if (!library) return { focus: null, pickedIds: ids.length >= 2 ? ids : [] };
  const scope = scopeFromTicked(ids, library.books, library.series);
  if (scope.kind === "picked") return { focus: null, pickedIds: scope.ids };
  if (scope.kind === "all") return none;
  return { focus: scope.focus, pickedIds: [] };
}

/** The composer chip's preview when the scope is known in the browser; null = ask the server. */
export function localScopePreview(
  focus: FocusBook | null,
  pickedIds: string[],
  books: ScopeBook[],
  series: ScopeSeries[]
): ScopeInfo | null {
  const titled = (ids: string[]) =>
    ids
      .map((id) => books.find((b) => b.id === id))
      .filter((b): b is ScopeBook => !!b)
      .map((b) => ({ id: b.id, title: b.title }));
  if (focus) {
    const seriesId = seriesIdOfFocus(focus.id);
    if (!seriesId) return { books: [{ id: focus.id, title: focus.title }], reason: "focus" };
    const own = series.find((s) => s.id === seriesId);
    return { books: titled(own?.bookIds ?? []), reason: "series", label: own?.name || focus.title };
  }
  if (pickedIds.length >= 2) return { books: titled(pickedIds), reason: "picked" };
  return null;
}
