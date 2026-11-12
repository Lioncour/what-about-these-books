"use client";

import { useEffect, useState } from "react";
import { normalizeScope, type ScopeInfo } from "@/components/chat/format";
import type { FocusBook } from "@/components/chat/messages";
import type { LibraryBook } from "@/hooks/useLibrary";

const DEBOUNCE_MS = 300;

/**
 * What the next question will be asked against, for the composer's scope chip.
 *
 * A focus book and hand-picked books are known here. With the whole library in play
 * the server is asked (debounced) whether the question names a book; that reads the
 * catalog only, no AI call.
 */
export function useScopePreview({
  question,
  focus,
  pickedIds,
  books,
}: {
  question: string;
  focus: FocusBook | null;
  pickedIds: string[];
  books: LibraryBook[];
}): ScopeInfo {
  // The server's answer, tagged with the question it was for, so a stale answer
  // is never shown and nothing has to be reset inside the effect.
  const [named, setNamed] = useState<{ question: string; scope: ScopeInfo } | null>(null);

  const trimmed = question.trim();
  const local = pickedIds.length >= 2 || focus !== null;
  const worthAsking = !local && trimmed.length >= 4 && books.length > 0;

  useEffect(() => {
    if (!worthAsking) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/chat/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: "all", bookTitle: "All Books", question: trimmed }),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const scope = normalizeScope(data);
          if (scope) setNamed({ question: trimmed, scope });
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [worthAsking, trimmed]);

  if (pickedIds.length >= 2) {
    const picked = pickedIds
      .map((id) => books.find((b) => b.id === id))
      .filter((b): b is LibraryBook => !!b)
      .map((b) => ({ id: b.id, title: b.title }));
    return { books: picked, reason: "picked" };
  }
  if (focus) return { books: [{ id: focus.id, title: focus.title }], reason: "focus" };
  if (worthAsking && named?.question === trimmed && named.scope.reason === "named") return named.scope;
  return { books: [], reason: "all", ...(books.length ? { more: books.length } : {}) };
}
