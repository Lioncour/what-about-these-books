"use client";

import { useEffect, useState } from "react";

export type PassageReaderTarget = {
  bookId?: string;
  book: string;
  position?: string;
  excerpt?: string;
};

type PassagePayload = {
  bookId: string;
  bookTitle: string;
  position: string;
  text: string;
  neighbors: Array<{ position: string; preview: string }>;
};

export default function PassageReader({
  target,
  onClose,
  onAskAbout,
}: {
  target: PassageReaderTarget | null;
  onClose: () => void;
  onAskAbout?: (prompt: string) => void;
}) {
  const [data, setData] = useState<PassagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (target.bookId) params.set("bookId", target.bookId);
    params.set("book", target.book);
    if (target.position) params.set("position", target.position);

    fetch(`/api/passage?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not open that passage");
        return res.json() as Promise<PassagePayload>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) {
          setData(null);
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-[2px]">
      <button type="button" className="flex-1 cursor-default" aria-label="Close" onClick={onClose} />
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl animate-fade-in">
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Passage</p>
            <h2 className="mt-0.5 truncate font-display text-base font-semibold">
              {data?.bookTitle || target.book}
            </h2>
            <p className="truncate text-sm text-muted">
              {data?.position || target.position || "…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-foreground"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading && <p className="text-sm text-muted">Opening the page…</p>}
          {error && (
            <div className="space-y-2">
              <p className="text-sm text-danger">{error}</p>
              {target.excerpt && (
                <p className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted">
                  &ldquo;{target.excerpt}&rdquo;
                </p>
              )}
            </div>
          )}
          {!loading && !error && data && (
            <article className="space-y-4">
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/95">
                {data.text}
              </p>
              {target.excerpt && (
                <p className="text-[11px] text-muted">
                  Matched from citation — scroll the chapter for full context.
                </p>
              )}
              {data.neighbors.length > 0 && (
                <div className="border-t border-border pt-3">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">
                    Nearby
                  </p>
                  <ul className="space-y-2">
                    {data.neighbors.map((n) => (
                      <li key={n.position} className="rounded-xl border border-border/80 px-3 py-2 text-xs text-muted">
                        <span className="font-medium text-foreground/80">{n.position}</span>
                        <p className="mt-0.5 line-clamp-2">{n.preview}…</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          )}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <button
            type="button"
            className="w-full rounded-xl border border-border px-3 py-2 text-sm text-muted transition-colors hover:border-primary/40 hover:text-foreground"
            onClick={() => {
              const label = `${data?.bookTitle || target.book}${
                data?.position || target.position
                  ? ` · ${data?.position || target.position}`
                  : ""
              }`;
              onAskAbout?.(`Tell me more about this passage from ${label}.`);
              onClose();
            }}
          >
            Ask about this passage
          </button>
        </footer>
      </aside>
    </div>
  );
}
