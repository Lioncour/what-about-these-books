import {
  countAllBooksKeywordMentions,
  countBookKeywordMentions,
  getBookById,
  listBooks,
  listSeries,
  queryAllBooks,
  queryBook,
  querySeriesBooks,
  searchAllBooksKeyword,
  searchBookKeyword,
  searchExactQuoteAllBooks,
  searchExactQuoteInBook,
  searchExactQuoteInSeries,
  searchSeriesKeyword,
  type CountMode,
  type SeriesEntry,
} from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { extractBookCountScope } from "@/lib/chat/intent";
import {
  collectMentionSources,
  countMentionsInOrderedBooks,
  describeBookCountScope,
  resolveSeriesForMentionCount,
} from "@/lib/chat/mention-count";
import { bookText, libraryText, seriesText, type ScopeText } from "@/lib/chat/scope-text";
import {
  findNamedBooksInQuestion,
  seedPassagesByTitle,
  selectLibrarySpecialists,
  selectSeriesSpecialists,
  type BookRef,
  type LibrarySpecialistSelection,
} from "@/lib/chat/specialist-limits";
import { MAX_LIBRARY_SPECIALIST_BOOKS } from "@/lib/chat/constants";
import type { ChatSource } from "@/lib/chat/types";

export type ScopeKind = "all" | "series" | "book";

/** Why these books answer the question (the SCOPE stream line). */
export type ScopeReason = "named" | "focus" | "series" | "semantic" | "all" | "picked";

/** Most books a reader may pick for one question. */
const MAX_PICKED_BOOKS = 40;

export interface ScopedPassage {
  bookTitle: string;
  text: string;
  location: string;
}

export interface ScopedMatch {
  bookTitle: string;
  label: string;
  snippet: string;
}

export interface MentionCount {
  /** What was counted in: a series, one book, or the library. */
  kind: ScopeKind;
  /** For the STATUS line: `in series "X"`, `in "Title"`, `across your library`. */
  where: string;
  /** For the answer sentence. */
  scopeLabel: string;
  total: number;
  byBook: Array<[string, number]>;
  includedTitles?: string[];
  sources: ChatSource[];
  /** The books the count ran over. */
  books: BookRef[];
  reason: ScopeReason;
}

export interface SpecialistSelection {
  books: BookRef[];
  namedBooks: BookRef[];
  /** Passages of the request's one seed query, per book title (empty: specialists query themselves). */
  seedByTitle: Map<string, { text: string; location: string }[]>;
  reason: ScopeReason;
}

/**
 * What a question is asked against: the whole library, a series, or one book. Built
 * once per request; the pipeline only talks to this, never to `bookId` prefixes.
 */
export interface Scope {
  kind: ScopeKind;
  /** "your library", the series name, or the book title. */
  label: string;
  /** The series in focus (series scope only; null when its id is unknown). */
  series: SeriesEntry | null;
  /** Catalog books in scope. */
  books: BookRef[];
  /** SCOPE reason when an answer draws on all of `books`. */
  reason: ScopeReason;
  /** True when the reader picked these books by hand (kind stays "all": a small library). */
  picked: boolean;
  /** Whether a book belongs to this scope (for helpers that search by `bookId`). */
  includes(bookId: string): boolean;
  text: ScopeText;
  semantic(question: string, max: number): Promise<ScopedPassage[]>;
  keyword(words: string[], max: number): ScopedMatch[];
  exactQuote(quote: string): ScopedMatch[];
  /** Exact count; a series or book the question names wins over the focus. */
  countMentions(target: string, mode: CountMode): MentionCount;
  /** Series an exact count would run over, if the question or focus points at one. */
  mentionSeries(): SeriesEntry | null;
  selectSpecialistBooks(question: string): Promise<SpecialistSelection>;
}

const MAX_COUNT_SOURCES = 40;

export const matchToSource = (m: ScopedMatch): ChatSource => ({
  book: m.bookTitle,
  excerpt: m.snippet,
  position: m.label,
});

function toSelection(sel: LibrarySpecialistSelection, fallback: ScopeReason): SpecialistSelection {
  const namedIds = new Set(sel.namedBooks.map((b) => b.id));
  const onlyNamed = sel.books.length > 0 && sel.books.every((b) => namedIds.has(b.id));
  return {
    books: sel.books,
    namedBooks: sel.namedBooks,
    seedByTitle: seedPassagesByTitle(sel.seedPassages),
    reason: onlyNamed ? "named" : fallback,
  };
}

/**
 * Books the reader picked by hand, as catalog entries. Unknown ids are dropped; fewer
 * than two is not a picked scope (one book is plain book focus).
 */
function resolvePickedBooks(ids: unknown): BookRef[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const books: BookRef[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const book = getBookById(id);
    if (book) books.push({ id: book.id, title: book.title });
    if (books.length >= MAX_PICKED_BOOKS) break;
  }
  return books;
}

/**
 * A hand-picked set of books: the library scope narrowed to exactly these. Every
 * search, count and specialist runs over them and nothing else, whatever the question
 * names, because the reader said so explicitly.
 */
function pickedScope(picked: BookRef[], question: string): Scope {
  const ids = new Set(picked.map((b) => b.id));
  const label = `the ${picked.length} books you picked`;
  const base = libraryText();
  const perBook = (max: number) => Math.max(2, Math.ceil(max / picked.length) + 1);
  return {
    kind: "all",
    label,
    series: null,
    books: picked,
    reason: "picked",
    picked: true,
    includes: (id) => ids.has(id),
    text: { ...base, searching: `Searching ${label} (semantic search)...` },
    semantic: async (q, max) => {
      const rows = await Promise.all(
        picked.map(async (b) => (await queryBook(b.id, q, perBook(max))).map((p) => ({ ...p, bookTitle: b.title })))
      );
      // Interleave so every picked book is heard before any gets a second passage.
      const out: ScopedPassage[] = [];
      for (let i = 0; out.length < max && rows.some((r) => i < r.length); i++) {
        for (const r of rows) if (i < r.length && out.length < max) out.push(r[i]);
      }
      return out;
    },
    keyword: (words, max) =>
      picked
        .flatMap((b) => searchBookKeyword(b.id, words, perBook(max)).map((m) => ({ ...m, bookTitle: b.title })))
        .slice(0, max),
    exactQuote: (quote) =>
      picked.flatMap((b) => searchExactQuoteInBook(b.id, quote, 30).map((m) => ({ ...m, bookTitle: b.title }))),
    countMentions: (target, mode) => {
      const rows = picked
        .map((b) => ({ book: b, count: countBookKeywordMentions(b.id, target, mode) }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count);
      const scopeLabel = `in ${label}`;
      return {
        kind: "all",
        where: scopeLabel,
        scopeLabel,
        total: rows.reduce((sum, r) => sum + r.count, 0),
        byBook: rows.map((r) => [r.book.title, r.count] as [string, number]),
        sources: picked
          .flatMap((b) => searchBookKeyword(b.id, [target], 4).map((m) => matchToSource({ ...m, bookTitle: b.title })))
          .slice(0, MAX_COUNT_SOURCES),
        books: picked,
        reason: "picked",
      };
    },
    mentionSeries: () => null,
    selectSpecialistBooks: async (q) => {
      const namedBooks = findNamedBooksInQuestion(question).filter((b) => ids.has(b.id));
      // Within the librarian limit every picked book is read, in the order picked.
      if (picked.length <= MAX_LIBRARY_SPECIALIST_BOOKS) {
        return { books: picked, namedBooks, seedByTitle: new Map(), reason: "picked" };
      }
      const ranked = await rankPickedBooks(picked, namedBooks, q || question);
      return {
        books: ranked.slice(0, MAX_LIBRARY_SPECIALIST_BOOKS),
        namedBooks,
        seedByTitle: new Map(),
        reason: "picked",
      };
    },
  };
}

/** Passages fetched to rank a large pick: enough for every book of a big library to show up. */
const PICKED_RANKING_PASSAGES = 240;

/**
 * More books picked than the librarians read: order them by how close each comes to
 * the question. One semantic query over the library (one embedding of the question);
 * its passages come back best first, so the first passage of a book is that book's best
 * score, and the picked books are read in that order. Books the question names go
 * first; picked books without any passage near the question keep their shelf order at
 * the end. A failed query (index missing, Bedrock down) falls back to shelf order.
 */
export async function rankPickedBooks(picked: BookRef[], named: BookRef[], question: string): Promise<BookRef[]> {
  const ids = new Set(picked.map((b) => b.id));
  const order: string[] = [];
  const add = (id: string) => {
    if (ids.has(id) && !order.includes(id)) order.push(id);
  };
  for (const b of named) add(b.id);
  if (question.trim()) {
    try {
      for (const passage of await queryAllBooks(question, PICKED_RANKING_PASSAGES)) add(passage.bookId);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
    }
  }
  for (const b of picked) add(b.id);
  const byId = new Map(picked.map((b) => [b.id, b]));
  return order.map((id) => byId.get(id)!);
}

/** What the SCOPE line will most likely say for this question, without any Bedrock call. */
export interface ScopePreview {
  books: BookRef[];
  reason: ScopeReason;
  /** Books in scope beyond the listed ones. */
  more?: number;
}

const MAX_PREVIEW_BOOKS = 20;

/**
 * The books a question would be asked against, for the composer's scope chip. Exact for
 * picked books, a focus book and named books; for an open library question the closest
 * books are only chosen when the question is embedded, so it says "all" with the size.
 */
export function previewScope(input: {
  bookId: string;
  bookTitle: string;
  question: string;
  pickedIds?: unknown;
}): ScopePreview {
  const clean = (books: BookRef[]): ScopePreview["books"] =>
    books.slice(0, MAX_PREVIEW_BOOKS).map((b) => ({ id: b.id, title: cleanBookDisplayTitle(b.title) }));
  const withMore = (books: BookRef[], reason: ScopeReason): ScopePreview => {
    const more = books.length - Math.min(books.length, MAX_PREVIEW_BOOKS);
    return { books: clean(books), reason, ...(more > 0 ? { more } : {}) };
  };

  const picked = resolvePickedBooks(input.pickedIds);
  if (picked.length >= 2) return withMore(picked, "picked");
  if (picked.length === 1) return withMore(picked, "focus");

  const scope = buildScope(input.bookId, input.bookTitle, input.question);
  if (scope.kind === "book") return withMore(scope.books, "focus");

  const named = input.question.trim() ? findNamedBooksInQuestion(input.question) : [];
  if (scope.kind === "series") {
    const inSeries = named.filter((b) => scope.includes(b.id));
    return inSeries.length ? withMore(inSeries, "named") : withMore(scope.books, "series");
  }
  if (named.length) return withMore(named, "named");
  return { books: [], reason: "all", ...(scope.books.length ? { more: scope.books.length } : {}) };
}

/**
 * `countQuestion`: the question whose wording decides where an exact count runs (a named
 * book, "the first 7 books", a named series). It differs from `question` only for a
 * follow-up like "and Joe?", which counts where the count question before it did.
 */
export function buildScope(
  bookId: string,
  bookTitle: string,
  question: string,
  pickedIds?: unknown,
  countQuestion: string = question
): Scope {
  const pickedBooks = resolvePickedBooks(pickedIds);
  if (pickedBooks.length >= 2) return pickedScope(pickedBooks, question);
  if (pickedBooks.length === 1) {
    bookId = pickedBooks[0].id;
    bookTitle = pickedBooks[0].title;
  }
  const kind: ScopeKind = bookId === "all" ? "all" : bookId.startsWith("series:") ? "series" : "book";
  const seriesId = kind === "series" ? bookId.slice("series:".length) : "";
  const series = kind === "series" ? listSeries().find((s) => s.id === seriesId) || null : null;
  const refs = (books: Array<{ id: string; title: string }>): BookRef[] =>
    books.map((b) => ({ id: b.id, title: b.title }));

  let mentionSeries: SeriesEntry | null | undefined;
  const resolveMentionSeries = () => {
    if (mentionSeries === undefined) mentionSeries = resolveSeriesForMentionCount(countQuestion, bookId);
    return mentionSeries;
  };

  const countInSeries = (counted: SeriesEntry, target: string, mode: CountMode): MentionCount => {
    const bookCountScope = extractBookCountScope(countQuestion);
    const result = countMentionsInOrderedBooks({
      seriesId: counted.id,
      keyword: target,
      countMode: mode,
      scope: bookCountScope,
    });
    return {
      kind: "series",
      where: `in series "${counted.name}"`,
      scopeLabel: describeBookCountScope(bookCountScope, counted.name),
      total: result.total,
      byBook: result.rows.map((r) => [r.bookTitle, r.count] as [string, number]),
      includedTitles: bookCountScope.kind !== "all" ? result.includedTitles : undefined,
      sources: collectMentionSources(result.rows.map((r) => r.bookId), target, 4),
      books: result.rows.map((r) => ({ id: r.bookId, title: getBookById(r.bookId)?.title || r.bookTitle })),
      reason: "series",
    };
  };

  const countInBook = (target: string, mode: CountMode): MentionCount => {
    const total = countBookKeywordMentions(bookId, target, mode);
    return {
      kind: "book",
      where: `in "${bookTitle}"`,
      scopeLabel: `in **${bookTitle}**`,
      total,
      byBook: total > 0 ? [[bookTitle, total]] : [],
      sources: searchBookKeyword(bookId, [target], MAX_COUNT_SOURCES).map((m) => matchToSource({ ...m, bookTitle })),
      books: [{ id: bookId, title: bookTitle }],
      reason: "focus",
    };
  };

  /** "…in Columbus Day?" counts only the books named in the question; otherwise the library. */
  const countInLibrary = (target: string, mode: CountMode): MentionCount => {
    const named = findNamedBooksInQuestion(countQuestion);
    const namedIds = new Set(named.map((b) => b.id));
    const scopeLabel = named.length
      ? `in ${named.map((b) => cleanBookDisplayTitle(b.title)).join(", ")}`
      : "across your library";
    const rows = countAllBooksKeywordMentions(target, mode).filter((r) => !namedIds.size || namedIds.has(r.bookId));
    const matches: ScopedMatch[] = named.length
      ? named.flatMap((b) =>
          searchBookKeyword(b.id, [target], MAX_COUNT_SOURCES).map((m) => ({ ...m, bookTitle: b.title }))
        )
      : searchAllBooksKeyword([target], MAX_COUNT_SOURCES);
    return {
      kind: "all",
      where: scopeLabel,
      scopeLabel,
      total: rows.reduce((sum, r) => sum + r.count, 0),
      byBook: rows.map((r) => [r.bookTitle, r.count] as [string, number]),
      sources: matches.slice(0, MAX_COUNT_SOURCES).map(matchToSource),
      books: named.length ? named : refs(listBooks()),
      reason: named.length ? "named" : "all",
    };
  };

  const countMentions = (target: string, mode: CountMode): MentionCount => {
    const counted = resolveMentionSeries();
    if (counted) return countInSeries(counted, target, mode);
    return kind === "book" ? countInBook(target, mode) : countInLibrary(target, mode);
  };

  if (kind === "all") {
    return {
      kind,
      label: "your library",
      series: null,
      books: refs(listBooks()),
      reason: "all",
      picked: false,
      includes: () => true,
      text: libraryText(),
      semantic: (q, max) => queryAllBooks(q, max),
      keyword: (words, max) => searchAllBooksKeyword(words, max),
      exactQuote: (quote) => searchExactQuoteAllBooks(quote, 120),
      countMentions,
      mentionSeries: resolveMentionSeries,
      selectSpecialistBooks: async (q) => toSelection(await selectLibrarySpecialists(q), "semantic"),
    };
  }

  if (kind === "series") {
    const seriesName = series?.name || bookTitle;
    return {
      kind,
      label: seriesName,
      series,
      books: refs(listBooks().filter((b) => series?.bookIds.includes(b.id))),
      reason: "series",
      picked: false,
      includes: (id) => !!series?.bookIds.includes(id),
      text: seriesText(seriesName, series),
      semantic: (q, max) => querySeriesBooks(seriesId, q, max),
      keyword: (words, max) => searchSeriesKeyword(seriesId, words, max),
      exactQuote: (quote) => searchExactQuoteInSeries(seriesId, quote, 90),
      countMentions,
      mentionSeries: resolveMentionSeries,
      selectSpecialistBooks: async (q) =>
        series
          ? toSelection(await selectSeriesSpecialists(series, q), "series")
          : { books: [], namedBooks: [], seedByTitle: new Map(), reason: "series" },
    };
  }

  // One book in focus. Its title is the one the client sent, as shown in the library.
  const focus: BookRef = { id: bookId, title: bookTitle };
  return {
    kind,
    label: bookTitle,
    series: null,
    books: [focus],
    reason: "focus",
    picked: false,
    includes: (id) => id === bookId,
    text: bookText(bookId, bookTitle),
    semantic: async (q, max) => (await queryBook(bookId, q, max)).map((p) => ({ ...p, bookTitle })),
    keyword: (words, max) => searchBookKeyword(bookId, words, max).map((m) => ({ ...m, bookTitle })),
    exactQuote: (quote) => searchExactQuoteInBook(bookId, quote, 70).map((m) => ({ ...m, bookTitle })),
    countMentions,
    mentionSeries: resolveMentionSeries,
    // The focused book is read whatever else the question names.
    selectSpecialistBooks: async () => ({ books: [focus], namedBooks: [], seedByTitle: new Map(), reason: "focus" }),
  };
}

