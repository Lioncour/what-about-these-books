"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FocusBook } from "@/components/chat/messages";
import {
  restoreSavedScope,
  scopeFromTicked,
  scopeToSaved,
  tickedIdsFor,
} from "@/components/chat/scope";
import type { LibraryBook, LibrarySeries } from "@/hooks/useLibrary";

const NO_BOOKS: string[] = [];

/**
 * What the next question is asked against: the focus (a book or a series) or the
 * books picked by hand. Owns the picked set, turns the picker's ticks into a scope,
 * and saves/restores the scope with a conversation.
 */
export function useAskScope({
  books,
  series,
  loaded,
  focus,
  setFocus,
  toggleFocus,
}: {
  books: LibraryBook[];
  series: LibrarySeries[];
  /** The shelves have been read at least once. */
  loaded: boolean;
  focus: FocusBook | null;
  setFocus: (focus: FocusBook | null) => void;
  toggleFocus: (book: FocusBook) => void;
}) {
  // Books picked by hand for the next questions; two or more override the library scope.
  const [rawPicked, setRawPicked] = useState<string[]>([]);

  // Only books still on the shelves count as picked (a book may have been removed).
  const known = rawPicked.filter((id) => books.some((b) => b.id === id));
  const active = !focus && known.length >= 2 ? known : NO_BOOKS;
  const key = active.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, not identity
  const pickedIds = useMemo(() => active, [key]);

  /** The picker's answer: nothing = whole library, one = focus book, a whole series = that series, more = picked set. */
  const applyTicked = useCallback(
    (ids: string[]) => {
      const scope = scopeFromTicked(ids, books, series);
      setRawPicked(scope.kind === "picked" ? scope.ids : []);
      setFocus(scope.kind === "book" || scope.kind === "series" ? scope.focus : null);
    },
    [books, series, setFocus]
  );

  /** A single focus (an uploaded book): it replaces a picked set. */
  const focusOn = useCallback(
    (book: FocusBook) => {
      setRawPicked([]);
      setFocus({ id: book.id, title: book.title });
    },
    [setFocus]
  );

  /** Clicking a book or series on the shelves: focus it, or let go if it already is. */
  const toggleShelfFocus = useCallback(
    (book: FocusBook) => {
      setRawPicked([]);
      toggleFocus(book);
    },
    [toggleFocus]
  );

  /** Back to the whole library. */
  const askAll = useCallback(() => {
    setRawPicked([]);
    setFocus(null);
  }, [setFocus]);

  const tickedIds = useMemo(() => tickedIdsFor(focus, pickedIds, series), [focus, pickedIds, series]);
  const saved = useMemo(() => scopeToSaved(focus, pickedIds), [focus, pickedIds]);

  // The library as a restore sees it; null until the shelves have been read.
  const libraryRef = useRef<{ books: LibraryBook[]; series: LibrarySeries[] } | null>(null);
  useEffect(() => {
    libraryRef.current = loaded ? { books, series } : null;
  }, [loaded, books, series]);

  /** Put back the scope a saved chat was having (books that are gone are dropped). */
  const restore = useCallback(
    (raw: unknown) => {
      const scope = restoreSavedScope(raw, libraryRef.current);
      setRawPicked(scope.pickedIds);
      setFocus(scope.focus);
    },
    [setFocus]
  );

  return { pickedIds, tickedIds, saved, applyTicked, focusOn, toggleShelfFocus, askAll, restore };
}
