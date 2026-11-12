"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BookLibraryHandle } from "@/components/BookLibrary";
import { cleanDisplayTitle } from "@/components/chat/format";
import type { FocusBook } from "@/components/chat/messages";

interface BookRow {
  id?: string;
  title?: string;
  author?: string;
  seriesId?: string;
  seriesOrder?: number;
}

/** A book as the scope picker lists it. */
export interface LibraryBook {
  id: string;
  /** Display title. */
  title: string;
  series?: string;
  seriesId?: string;
}

/** A series as the page needs it: its books that are on the shelves, in reading order. */
export interface LibrarySeries {
  id: string;
  name: string;
  bookIds: string[];
}

/** The library as the page needs it: how many books, recent titles, series, the focus (a book or a series). */
export function useLibrary() {
  const libraryRef = useRef<BookLibraryHandle>(null);
  const [bookCount, setBookCount] = useState(0);
  const [recentTitles, setRecentTitles] = useState<string[]>([]);
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [series, setSeries] = useState<LibrarySeries[]>([]);
  // False until the first read of the shelves has landed.
  const [loaded, setLoaded] = useState(false);
  const [focus, setFocus] = useState<FocusBook | null>(null);

  const reloadSummary = useCallback(() => {
    Promise.all([
      fetch("/api/books").then((r) => r.json()),
      fetch("/api/series")
        .then((r) => r.json())
        .catch(() => ({})),
    ])
      .then(([booksData, seriesData]) => {
        const books: BookRow[] = Array.isArray(booksData.books) ? booksData.books : [];
        const seriesRows: Array<{ id: string; name: string; bookIds?: string[] }> = Array.isArray(
          seriesData.series
        )
          ? seriesData.series
          : [];
        const seriesNames = new Map<string, string>(seriesRows.map((s) => [s.id, s.name]));
        setBookCount(books.length);
        const rows = books
          .filter((b) => b.id)
          .map((b) => {
            const series = b.seriesId ? seriesNames.get(b.seriesId) : undefined;
            return {
              id: String(b.id),
              title: cleanDisplayTitle(String(b.title || ""), { author: b.author, series }),
              series,
              seriesId: series ? b.seriesId : undefined,
              order: typeof b.seriesOrder === "number" ? b.seriesOrder : Number.MAX_SAFE_INTEGER,
            };
          });
        // Series together and in reading order; standalone books after, by title.
        rows.sort(
          (a, b) =>
            (a.series ? 0 : 1) - (b.series ? 0 : 1) ||
            (a.series || "").localeCompare(b.series || "") ||
            a.order - b.order ||
            a.title.localeCompare(b.title)
        );
        setBooks(rows.map(({ id, title, series, seriesId }) => ({ id, title, series, seriesId })));
        // Membership is the series' own list (what the server reads), in shelf order.
        setSeries(
          seriesRows.map((s) => {
            const own = new Set(Array.isArray(s.bookIds) ? s.bookIds : []);
            return {
              id: s.id,
              name: s.name,
              bookIds: rows.filter((b) => own.has(b.id)).map((b) => b.id),
            };
          })
        );
        setLoaded(true);
        setRecentTitles(
          books
            .slice(0, 3)
            .map((b) =>
              cleanDisplayTitle(String(b.title || ""), {
                author: b.author,
                series: b.seriesId ? seriesNames.get(b.seriesId) : undefined,
              })
            )
            .filter(Boolean)
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    reloadSummary();
  }, [reloadSummary]);

  /** Re-read the shelves and the summary (after uploads, tidy, chat commands). */
  const refresh = useCallback(() => {
    libraryRef.current?.refresh();
    reloadSummary();
  }, [reloadSummary]);

  /** Clicking the focused book again lets go of it. */
  const toggleFocus = useCallback((book: FocusBook) => {
    setFocus((prev) => (prev?.id === book.id ? null : { id: book.id, title: book.title }));
  }, []);

  const clearFocus = useCallback(() => setFocus(null), []);

  return {
    libraryRef,
    bookCount,
    recentTitles,
    books,
    series,
    loaded,
    focus,
    setFocus,
    toggleFocus,
    clearFocus,
    refresh,
    reloadSummary,
  };
}
