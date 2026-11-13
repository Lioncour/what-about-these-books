/**
 * Pure decisions for the "check the other books" action under an answer (no React,
 * no DOM): whether the answer's scope left books unread, and what asking the same
 * question again against those would be.
 */
import type { ScopeInfo } from "@/components/chat/format";
import {
  seriesIdOfFocus,
  type ScopeBook,
  type ScopeRequest,
  type ScopeSeries,
} from "@/components/chat/scope";

/** What a question was asked against, kept on the user message when it is sent. */
export interface AskedScope {
  /** "all", a book id or "series:<id>". */
  bookId?: string;
  /** The books it was narrowed to (a hand-picked set, or a follow-up's remaining books). */
  bookIds?: string[];
  /** The question was a "check the other books" follow-up, not typed in the composer. */
  followUp?: boolean;
}

export type FollowUpKind = "others" | "series" | "picked" | "library";

/** The action under an answer: its wording and the one-off scope of the repeated question. */
export interface FollowUpAction {
  label: string;
  kind: FollowUpKind;
  /** Two or more books to read, exactly those. */
  bookIds?: string[];
  /** A single remaining book: asked as a focus book. */
  focusId?: string;
  focusTitle?: string;
  /** Ask the whole library. */
  library?: true;
}

/** A scope for one request only; the composer's own scope is left alone. */
export type OneOffScope = { bookId: string; bookTitle: string } | { bookIds: string[] };

const LIBRARY_SCOPE: OneOffScope = { bookId: "all", bookTitle: "All Books" };

/** The scope fields of a chat request for a one-off scope. */
export function oneOffRequest(scope: OneOffScope): ScopeRequest {
  if ("bookIds" in scope) return { ...(LIBRARY_SCOPE as ScopeRequest), bookIds: scope.bookIds };
  return { bookId: scope.bookId || "all", bookTitle: scope.bookTitle || "All Books" };
}

/** The one-off scope a follow-up action asks with. */
export function followUpScope(action: FollowUpAction): OneOffScope {
  if (action.focusId) return { bookId: action.focusId, bookTitle: action.focusTitle || action.focusId };
  if (action.bookIds?.length) return { bookIds: action.bookIds };
  return LIBRARY_SCOPE;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The remaining books as an action: several are read together, one is a focus book, none is nothing. */
function remaining(
  rest: ScopeBook[],
  kind: FollowUpKind,
  label: string
): FollowUpAction | null {
  if (rest.length === 0) return null;
  if (rest.length === 1) return { label, kind, focusId: rest[0].id, focusTitle: rest[0].title };
  return { label, kind, bookIds: rest.map((b) => b.id) };
}

/**
 * Which "check more" action an answer gets, or null when its scope already covered
 * what the reader could have meant.
 *
 * - closest matches in the library → the library's other books
 * - a series read in part → the rest of the series
 * - a pick read in part → the other picked books
 * - a named or focus book → the whole library
 */
export function followUpAction(
  scope: ScopeInfo | null | undefined,
  library: { books: ScopeBook[]; series: ScopeSeries[] },
  asked?: AskedScope | null
): FollowUpAction | null {
  if (!scope) return null;
  const read = new Set(scope.books.map((b) => b.id));
  const unread = (ids: string[]) => {
    const wanted = new Set(ids);
    // Shelf order, and only books that are still on the shelves.
    return library.books.filter((b) => wanted.has(b.id) && !read.has(b.id));
  };

  switch (scope.reason) {
    case "semantic": {
      // Nothing listed means we cannot tell which books were read.
      if (read.size === 0) return null;
      const rest = library.books.filter((b) => !read.has(b.id));
      return remaining(rest, "others", `Check the other ${plural(rest.length, "book")}`);
    }
    case "series": {
      if (read.size === 0) return null;
      const askedSeries = seriesIdOfFocus(asked?.bookId);
      const own =
        library.series.find((s) => s.id === askedSeries) ||
        // A series named in the question: the one that holds every book read.
        library.series.find((s) => [...read].every((id) => s.bookIds.includes(id)));
      if (!own) return null;
      return remaining(unread(own.bookIds), "series", "Check the rest of the series");
    }
    case "picked": {
      if (read.size === 0) return null;
      const rest = unread(asked?.bookIds ?? []);
      // A follow-up's books were not picked by hand: they are simply "the other books".
      const noun = asked?.followUp ? "book" : "picked book";
      return remaining(rest, "picked", `Check the other ${plural(rest.length, noun)}`);
    }
    case "named":
    case "focus": {
      // The last book of a "check the others" chain: the library has been through.
      if (asked?.followUp) return null;
      if (!library.books.some((b) => !read.has(b.id))) return null;
      return { label: "Ask the whole library instead", kind: "library", library: true };
    }
    default:
      return null;
  }
}

/** The question an answer at `index` belongs to: the nearest user message before it. */
export function questionIndexFor(messages: Array<{ role: string }>, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}
