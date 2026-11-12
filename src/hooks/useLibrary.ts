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
}

/** The library as the page needs it: how many books, recent titles, the focus book. */
export function useLibrary() {
  const libraryRef = useRef<BookLibraryHandle>(null);
  const [bookCount, setBookCount] = useState(0);
  const [recentTitles, setRecentTitles] = useState<string[]>([]);
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
        const seriesNames = new Map<string, string>(
          (Array.isArray(seriesData.series) ? seriesData.series : []).map(
            (s: { id: string; name: string }) => [s.id, s.name]
          )
        );
        setBookCount(books.length);
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
    focus,
    setFocus,
    toggleFocus,
    clearFocus,
    refresh,
    reloadSummary,
  };
}
