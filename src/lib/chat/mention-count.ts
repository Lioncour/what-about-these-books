import {
  countBookKeywordMentions,
  getBookById,
  listBooks,
  listSeries,
  searchBookKeyword,
  type CountMode,
  type SeriesEntry,
} from "@/lib/book-store";
import { extractBookCountScope, type BookCountScope } from "@/lib/chat/intent";
import { cleanBookDisplayTitle } from "@/lib/chat/passage-find";
import {
  compareSeriesBooks,
  formatSeriesOrderLabel,
  resolveLocalSeriesOrder,
} from "@/lib/series-order";
import type { ChatSource } from "@/lib/chat/types";

export type MentionCountBookRow = {
  bookId: string;
  bookTitle: string;
  count: number;
  order: number | null;
};

export function resolveSeriesForMentionCount(
  questionText: string,
  bookId: string
): SeriesEntry | null {
  const allSeries = listSeries();
  if (!allSeries.length) return null;

  if (bookId.startsWith("series:")) {
    const seriesId = bookId.slice("series:".length);
    return allSeries.find((s) => s.id === seriesId) || null;
  }

  const scope = extractBookCountScope(questionText);
  const wantsMultiBook =
    scope.kind !== "all" ||
    /\bin\s+(?:the\s+)?series\b|\bacross\s+(?:the\s+)?series\b|\bfirst\s+(?:\d+|ten|eleven|twelve)\s+books?\b|\d+\s+first\s+books?\b|\bbooks?\s+\d+\s*(?:-|–|—|to|through)\s*\d+\b/i.test(
      questionText
    );

  if (!wantsMultiBook) return null;

  const named = allSeries.find((s) =>
    questionText.toLowerCase().includes(s.name.toLowerCase())
  );
  if (named) return named;

  if (bookId !== "all") {
    const book = getBookById(bookId);
    if (book?.seriesId) {
      return allSeries.find((s) => s.id === book.seriesId) || null;
    }
  }

  if (allSeries.length === 1) return allSeries[0];
  return [...allSeries].sort((a, b) => b.bookIds.length - a.bookIds.length)[0] || null;
}

export function listOrderedSeriesBooks(seriesId: string) {
  const series = listSeries().find((s) => s.id === seriesId);
  if (!series) return [];
  const books = listBooks().filter((b) => series.bookIds.includes(b.id));
  return books
    .map((book) => ({
      book,
      order: resolveLocalSeriesOrder({
        title: book.title,
        filename: book.filename,
        author: book.author,
        seriesName: series.name,
        seriesOrder: book.seriesOrder,
      }),
      year: book.publishedYear ?? null,
    }))
    .sort((a, b) =>
      compareSeriesBooks(
        { order: a.order, year: a.year, title: a.book.title },
        { order: b.order, year: b.year, title: b.book.title }
      )
    );
}

export function applyBookCountScope<T extends { order: number | null }>(
  ordered: T[],
  scope: BookCountScope
): T[] {
  if (scope.kind === "all") return ordered;
  if (scope.kind === "first_n") return ordered.slice(0, scope.n);
  return ordered.filter((row) => {
    if (row.order == null) return false;
    return row.order >= scope.from && row.order <= scope.to;
  });
}

export function describeBookCountScope(scope: BookCountScope, seriesName?: string): string {
  const seriesBit = seriesName ? `**${seriesName}**` : "your library";
  if (scope.kind === "first_n") {
    return `in the first **${scope.n}** books of ${seriesBit}`;
  }
  if (scope.kind === "range") {
    return `in books **${scope.from}–${scope.to}** of ${seriesBit}`;
  }
  return seriesName ? `in **${seriesName}**` : "across your library";
}

export function countMentionsInOrderedBooks(opts: {
  seriesId: string;
  keyword: string;
  countMode: CountMode;
  scope: BookCountScope;
}): {
  rows: MentionCountBookRow[];
  total: number;
  includedTitles: string[];
  scopedBookCount: number;
} {
  const ordered = listOrderedSeriesBooks(opts.seriesId);
  const scoped = applyBookCountScope(ordered, opts.scope);
  const rows: MentionCountBookRow[] = scoped.map(({ book, order }) => {
    const label = formatSeriesOrderLabel(order);
    const bookTitle = label ? `${label} · ${book.title}` : book.title;
    return {
      bookId: book.id,
      bookTitle,
      count: countBookKeywordMentions(book.id, opts.keyword, opts.countMode),
      order,
    };
  });
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return {
    rows,
    total,
    includedTitles: rows.map((r) => r.bookTitle),
    scopedBookCount: rows.length,
  };
}

export function collectMentionSources(
  bookIds: string[],
  keyword: string,
  maxPerBook = 6
): ChatSource[] {
  const sources: ChatSource[] = [];
  for (const id of bookIds) {
    const book = getBookById(id);
    if (!book) continue;
    const matches = searchBookKeyword(id, [keyword], maxPerBook);
    for (const m of matches) {
      sources.push({
        book: cleanBookDisplayTitle(book.title),
        bookId: id,
        excerpt: m.snippet,
        position: m.label,
      });
    }
  }
  return sources;
}

export function formatExactMentionAnswer(opts: {
  target: string;
  total: number;
  byBook: Array<[string, number]>;
  scopeLabel: string;
  countMode: string;
  includedTitles?: string[];
}): string {
  const lines = [
    `Exact count from your **full indexed text** (not an AI estimate): **${opts.target}** appears **${opts.total.toLocaleString()}** times ${opts.scopeLabel}.`,
    "",
    `Count method: **${opts.countMode.replace(/_/g, " ")}** match over every stored page/chapter.`,
  ];
  if (opts.includedTitles?.length) {
    lines.push("");
    lines.push(`## Books counted (${opts.includedTitles.length})`);
    for (const title of opts.includedTitles) {
      lines.push(`- ${title}`);
    }
  }
  lines.push("", "## Breakdown by book");
  if (!opts.byBook.length) {
    lines.push(`- No matches for **${opts.target}** in the indexed text.`);
  } else {
    for (const [title, count] of opts.byBook.slice(0, 40)) {
      lines.push(`- **${title}**: ${count.toLocaleString()}`);
    }
  }
  return lines.join("\n");
}
