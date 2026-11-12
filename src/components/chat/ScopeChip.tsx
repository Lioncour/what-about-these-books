"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { askingHint, formatAskingLine, type ScopeInfo } from "@/components/chat/format";
import type { LibraryBook } from "@/hooks/useLibrary";

/**
 * Above the question field: which books the question will be asked against, and a
 * picker to change that before sending. Nothing picked means the whole library, one
 * book is a focus book, two or more are read together and nothing else is.
 */
export default function ScopeChip({
  preview,
  books,
  selectedIds,
  onApply,
}: {
  preview: ScopeInfo;
  books: LibraryBook[];
  /** The focus book or the picked set, as the picker's starting point. */
  selectedIds: string[];
  onApply: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape or a click outside; an open picker is a small modal moment.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const out: Array<{ series: string; books: LibraryBook[] }> = [];
    for (const book of books) {
      if (needle && !`${book.title} ${book.series || ""}`.toLowerCase().includes(needle)) continue;
      const series = book.series || "";
      const last = out[out.length - 1];
      if (last && last.series === series) last.books.push(book);
      else out.push({ series, books: [book] });
    }
    return out;
  }, [books, filter]);

  const toggle = (id: string) =>
    setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleGroup = (ids: string[]) =>
    setDraft((prev) =>
      ids.every((id) => prev.includes(id))
        ? prev.filter((id) => !ids.includes(id))
        : [...new Set([...prev, ...ids])]
    );

  const apply = (ids: string[]) => {
    // Keep shelf order, whatever order the boxes were ticked in.
    onApply(books.filter((b) => ids.includes(b.id)).map((b) => b.id));
    setOpen(false);
  };

  const hint = askingHint(preview);
  const draftLabel =
    draft.length === 0
      ? "Ask the whole library"
      : draft.length === 1
        ? "Ask this book"
        : `Ask these ${draft.length} books`;

  return (
    <div className="relative mb-1.5" ref={panelRef}>
      <button
        type="button"
        onClick={() => {
          if (!open) {
            setDraft(selectedIds);
            setFilter("");
          }
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Choose which books to ask"
        className="group flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-muted transition-colors hover:text-foreground"
      >
        <span className="truncate">
          <span className="border-b border-transparent group-hover:border-primary/35">
            {formatAskingLine(preview)}
          </span>
          {hint && <span className="text-muted/70"> · {hint}</span>}
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose which books to ask"
          className="absolute bottom-full left-0 z-30 mb-2 flex max-h-[min(60vh,26rem)] w-[min(26rem,calc(100vw-3rem))] flex-col rounded-xl border border-border bg-surface shadow-2xl animate-fade-in"
        >
          <div className="border-b border-border/70 px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted/90">
              Ask which books?
            </p>
            {books.length > 8 && (
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by title or series…"
                className="mt-2 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted/70 focus:border-primary/60"
              />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            {groups.length === 0 && (
              <p className="px-2 py-3 text-[13px] text-muted">No book matches that.</p>
            )}
            {groups.map((group) => {
              const ids = group.books.map((b) => b.id);
              const allOn = ids.every((id) => draft.includes(id));
              return (
                <div key={group.series || "standalone"} className="mb-1">
                  {group.series && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(ids)}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-muted/90 hover:bg-surface-hover/70 hover:text-foreground"
                      title={allOn ? "Untick the whole series" : "Tick the whole series"}
                    >
                      <span className="truncate">{group.series}</span>
                      <span className="ml-2 shrink-0 normal-case tracking-normal text-muted/70">
                        {allOn ? "none" : "all"}
                      </span>
                    </button>
                  )}
                  {group.books.map((book) => {
                    const on = draft.includes(book.id);
                    return (
                      <label
                        key={book.id}
                        className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-surface-hover/70 ${
                          on ? "text-foreground" : "text-muted"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(book.id)}
                          className="h-3.5 w-3.5 shrink-0 accent-[var(--primary)]"
                        />
                        <span className="truncate">{book.title}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2.5">
            <button
              type="button"
              onClick={() => apply([])}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              Whole library
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => apply(draft)}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-[var(--on-primary)] transition-colors hover:bg-primary-hover"
            >
              {draftLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
