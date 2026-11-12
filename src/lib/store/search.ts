/** Exact-text retrieval over the stored page maps: keyword snippets, mention counts, quotes. */
import { loadCatalog } from "./catalog";
import { loadBookPages } from "./pages";

export interface PageMatch {
  label: string;
  snippet: string;
}

function createSnippet(text: string, idx: number, len: number): string {
  const snippetStart = Math.max(0, idx - 60);
  const snippetEnd = Math.min(text.length, idx + len + 140);
  return (snippetStart > 0 ? "..." : "") +
    text.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim() +
    (snippetEnd < text.length ? "..." : "");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type CountMode = "whole_word" | "phrase" | "loose";

function countMatchesInText(text: string, keyword: string, mode: CountMode): number {
  const normalized = keyword.trim();
  if (!normalized) return 0;
  if (mode === "loose") {
    let count = 0;
    const lowerText = text.toLowerCase();
    const lowerKeyword = normalized.toLowerCase();
    let startIdx = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerKeyword, startIdx);
      if (idx === -1) break;
      count++;
      startIdx = idx + lowerKeyword.length;
    }
    return count;
  }
  if (mode === "phrase") {
    const re = new RegExp(escapeRegex(normalized), "gi");
    return (text.match(re) || []).length;
  }
  // Whole words; the spaces of a phrase match any run of whitespace (line breaks in PDF text).
  const re = new RegExp(`\\b${escapeRegex(normalized).replace(/\s+/g, "\\s+")}\\b`, "gi");
  return (text.match(re) || []).length;
}

export interface ExactQuoteMatch {
  label: string;
  snippet: string;
  bookTitle: string;
  bookId: string;
}

/** A keyword hit from a multi-book search; `bookTitle` is the catalog's current title. */
export type BookPageMatch = PageMatch & { bookTitle: string; bookId: string };

export function searchBookKeyword(
  bookId: string,
  keywords: string[],
  maxMatches = 300
): PageMatch[] {
  const pages = loadBookPages(bookId);
  if (!pages) return [];

  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  const matches: PageMatch[] = [];
  const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

  for (const page of pages) {
    const lowerText = page.text.toLowerCase();
    for (const kw of lowerKeywords) {
      // Whole-word match for plain words ("ship" must not hit "relationship");
      // phrases with punctuation are matched as substrings.
      const wholeWord = /^[\p{L}\p{N}_]+$/u.test(kw);
      let startIdx = 0;
      while (true) {
        const idx = lowerText.indexOf(kw, startIdx);
        if (idx === -1) break;
        startIdx = idx + kw.length;
        if (
          wholeWord &&
          (isWordChar(lowerText[idx - 1]) || isWordChar(lowerText[idx + kw.length]))
        ) {
          continue;
        }
        matches.push({ label: page.label, snippet: createSnippet(page.text, idx, kw.length) });
        if (matches.length >= maxMatches) return matches;
      }
    }
  }

  return matches;
}

export function countBookKeywordMentions(
  bookId: string,
  keyword: string,
  mode: CountMode = "whole_word"
): number {
  const pages = loadBookPages(bookId);
  if (!pages) return 0;
  return pages.reduce((sum, page) => sum + countMatchesInText(page.text, keyword, mode), 0);
}

export function countAllBooksKeywordMentions(
  keyword: string,
  mode: CountMode = "whole_word"
): Array<{ bookId: string; bookTitle: string; count: number }> {
  const catalog = loadCatalog();
  const rows = catalog.books.map((book) => ({
    bookId: book.id,
    bookTitle: book.title,
    count: countBookKeywordMentions(book.id, keyword, mode),
  }));
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
}

export function countSeriesKeywordMentions(
  seriesId: string,
  keyword: string,
  mode: CountMode = "whole_word"
): Array<{ bookId: string; bookTitle: string; count: number }> {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];
  const rows = catalog.books
    .filter((book) => series.bookIds.includes(book.id))
    .map((book) => ({
      bookId: book.id,
      bookTitle: book.title,
      count: countBookKeywordMentions(book.id, keyword, mode),
    }));
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
}

export function searchAllBooksKeyword(
  keywords: string[],
  maxMatches = 500
): BookPageMatch[] {
  const catalog = loadCatalog();
  const allMatches: BookPageMatch[] = [];

  for (const book of catalog.books) {
    const remaining = Math.max(0, maxMatches - allMatches.length);
    if (remaining <= 0) break;
    const bookMatches = searchBookKeyword(book.id, keywords, remaining);
    for (const m of bookMatches) {
      allMatches.push({ ...m, bookTitle: book.title, bookId: book.id });
    }
  }

  return allMatches;
}

export function searchSeriesKeyword(
  seriesId: string,
  keywords: string[],
  maxMatches = 400
): BookPageMatch[] {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];

  const booksInSeries = catalog.books.filter((b) => series.bookIds.includes(b.id));
  const matches: BookPageMatch[] = [];

  for (const book of booksInSeries) {
    const remaining = Math.max(0, maxMatches - matches.length);
    if (remaining <= 0) break;
    const bookMatches = searchBookKeyword(book.id, keywords, remaining);
    for (const m of bookMatches) {
      matches.push({ ...m, bookTitle: book.title, bookId: book.id });
    }
  }

  return matches;
}

export function searchExactQuoteInBook(
  bookId: string,
  quote: string,
  maxMatches = 40
): PageMatch[] {
  const pages = loadBookPages(bookId);
  if (!pages) return [];

  const cleanedQuote = quote.trim();
  if (!cleanedQuote) return [];

  const lowerQuote = cleanedQuote.toLowerCase();
  const quoteTokens = cleanedQuote.match(/[A-Za-z0-9]+/g) || [];
  const fuzzyRegex =
    quoteTokens.length >= 4
      ? new RegExp(quoteTokens.map((w) => escapeRegex(w)).join("[\\W_]+"), "i")
      : null;

  const matches: PageMatch[] = [];
  for (const page of pages) {
    const lowerText = page.text.toLowerCase();
    const exactIdx = lowerText.indexOf(lowerQuote);
    if (exactIdx !== -1) {
      matches.push({
        label: page.label,
        snippet: createSnippet(page.text, exactIdx, cleanedQuote.length),
      });
      if (matches.length >= maxMatches) break;
      continue;
    }
    if (fuzzyRegex) {
      const fuzzy = fuzzyRegex.exec(page.text);
      if (fuzzy?.index !== undefined) {
        matches.push({
          label: page.label,
          snippet: createSnippet(page.text, fuzzy.index, fuzzy[0].length),
        });
        if (matches.length >= maxMatches) break;
      }
    }
  }
  return matches;
}

export function searchExactQuoteAllBooks(
  quote: string,
  maxMatches = 80
): ExactQuoteMatch[] {
  const catalog = loadCatalog();
  const allMatches: ExactQuoteMatch[] = [];
  for (const book of catalog.books) {
    const remaining = Math.max(0, maxMatches - allMatches.length);
    if (remaining <= 0) break;
    const matches = searchExactQuoteInBook(book.id, quote, remaining);
    for (const m of matches) {
      allMatches.push({
        label: m.label,
        snippet: m.snippet,
        bookTitle: book.title,
        bookId: book.id,
      });
    }
  }
  return allMatches;
}

export function searchExactQuoteInSeries(
  seriesId: string,
  quote: string,
  maxMatches = 60
): ExactQuoteMatch[] {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];
  const allMatches: ExactQuoteMatch[] = [];
  const booksInSeries = catalog.books.filter((b) => series.bookIds.includes(b.id));
  for (const book of booksInSeries) {
    const remaining = Math.max(0, maxMatches - allMatches.length);
    if (remaining <= 0) break;
    const matches = searchExactQuoteInBook(book.id, quote, remaining);
    for (const m of matches) {
      allMatches.push({
        label: m.label,
        snippet: m.snippet,
        bookTitle: book.title,
        bookId: book.id,
      });
    }
  }
  return allMatches;
}
