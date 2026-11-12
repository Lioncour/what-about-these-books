"use client";

import { useCallback, useEffect, useState } from "react";
import { mergePlan, seriesFixLines } from "@/components/library/shelf";
import type { Book, DuplicateGroup, Series } from "@/components/library/types";

function send(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The shelves' data and every change the library rail can make to it (no dialogs here). */
export function useBookShelf(onChanged?: () => void) {
  const [books, setBooks] = useState<Book[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  // Per book: bumped after a cover upload so its image URL changes.
  const [coverVersions, setCoverVersions] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const [booksRes, seriesRes] = await Promise.all([fetch("/api/books"), fetch("/api/series")]);
      const booksData = await booksRes.json();
      const seriesData = await seriesRes.json();
      setBooks(booksData.books || []);
      setSeries(seriesData.series || []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Re-read the shelves and tell the page (its picker and counts read the same data). */
  const reload = useCallback(async () => {
    await refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  const removeBook = useCallback(
    async (bookId: string) => {
      await send("/api/books", "DELETE", { bookId });
      setBooks((prev) => prev.filter((b) => b.id !== bookId));
      onChanged?.();
    },
    [onChanged]
  );

  const createSeries = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      await send("/api/series", "POST", { name: name.trim(), bookIds: [] });
      await reload();
    },
    [reload]
  );

  const renameSeries = useCallback(
    async (seriesId: string, name: string) => {
      const s = series.find((x) => x.id === seriesId);
      if (!s || !name.trim()) return;
      await send("/api/series", "POST", { id: s.id, name: name.trim(), bookIds: s.bookIds });
      await reload();
    },
    [series, reload]
  );

  const deleteSeries = useCallback(
    async (seriesId: string) => {
      await send("/api/series", "DELETE", { seriesId });
      await reload();
    },
    [reload]
  );

  const assignBookToSeries = useCallback(
    async (bookId: string, targetSeriesId: string) => {
      const current = series.find((s) => s.bookIds.includes(bookId));
      if (current && current.id !== targetSeriesId) {
        await send("/api/series", "POST", {
          id: current.id,
          name: current.name,
          bookIds: current.bookIds.filter((id) => id !== bookId),
        });
      }
      if (targetSeriesId !== "none") {
        const target = series.find((s) => s.id === targetSeriesId);
        if (target && !target.bookIds.includes(bookId)) {
          await send("/api/series", "POST", {
            id: target.id,
            name: target.name,
            bookIds: [...target.bookIds, bookId],
          });
        }
      }
      await reload();
    },
    [series, reload]
  );

  /** "Fix series grouping": returns the notice to show. */
  const fixSeries = useCallback(async (): Promise<{ title: string; lines: string[] }> => {
    const res = await send("/api/series", "POST", { action: "reconcile", allowRemote: true });
    const data = await res.json();
    if (!res.ok) {
      return { title: "Couldn’t fix the series", lines: [data.error || "Series fix failed."] };
    }
    await reload();
    return { title: "Series grouping fixed", lines: seriesFixLines(data) };
  }, [reload]);

  /** Look for duplicate books; resolves to how many groups were found. */
  const scanDuplicates = useCallback(async (): Promise<number> => {
    const res = await send("/api/books", "POST", { action: "duplicates" });
    const data = await res.json();
    const groups: DuplicateGroup[] = data.groups || [];
    setDuplicateGroups(groups);
    return groups.length;
  }, []);

  const mergeDuplicates = useCallback(
    async (group: DuplicateGroup) => {
      const plan = mergePlan(group);
      if (!plan) return;
      for (const dupe of plan.remove) {
        await send("/api/books", "POST", {
          action: "merge-duplicate",
          primaryBookId: plan.keep.id,
          duplicateBookId: dupe.id,
        });
      }
      await reload();
      await scanDuplicates();
    },
    [reload, scanDuplicates]
  );

  const bumpCover = useCallback((bookId: string) => {
    setCoverVersions((prev) => ({ ...prev, [bookId]: Date.now() }));
  }, []);

  return {
    books,
    series,
    loading,
    duplicateGroups,
    coverVersions,
    refresh,
    reload,
    removeBook,
    createSeries,
    renameSeries,
    deleteSeries,
    assignBookToSeries,
    fixSeries,
    scanDuplicates,
    mergeDuplicates,
    bumpCover,
  };
}

export type BookShelf = ReturnType<typeof useBookShelf>;
