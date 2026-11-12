"use client";

import {
  formatScopeLine,
  formatUsageLine,
  scopeReasonHint,
  type ScopeInfo,
  type UsageInfo,
} from "@/components/chat/format";

export interface Source {
  book: string;
  excerpt: string;
  position?: string;
  bookId?: string;
}

export function SourcesList({
  sources,
  onOpenPassage,
}: {
  sources: Source[];
  onOpenPassage?: (source: Source) => void;
}) {
  // Collapse repeated references to the same place in the same book: a count
  // answer lists every matching chunk, which used to show one chapter four times.
  const merged: Array<{ source: Source; count: number }> = [];
  const byKey = new Map<string, number>();
  for (const source of sources) {
    const key = `${source.bookId || source.book}|${source.position || ""}`;
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, merged.length);
      merged.push({ source, count: 1 });
    } else {
      merged[at].count += 1;
    }
  }
  return (
    <div className="mt-1 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted/90">
        On the page
      </p>
      <div className="flex flex-col items-start gap-1.5">
        {merged.map(({ source, count }, i) => {
          const label = source.position
            ? `${source.book} · ${source.position}`
            : source.book;
          const snippet = (source.excerpt || "").replace(/\s+/g, " ").trim();
          return (
            <button
              key={`${i}-${source.book}-${source.position || "ref"}`}
              type="button"
              onClick={() => onOpenPassage?.(source)}
              className="group text-left text-[13px] text-muted transition-colors hover:text-foreground"
              title={snippet ? snippet.slice(0, 300) : "Open full passage"}
            >
              <span className="mr-2 font-mono text-[11px] text-accent group-hover:text-primary">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="border-b border-transparent group-hover:border-primary/35">
                {label}
              </span>
              {count > 1 && (
                <span className="ml-2 text-[11px] text-muted/80">×{count}</span>
              )}
              {snippet && (
                <span className="ml-2 text-[12px] text-muted/70">
                  “{snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet}”
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Which books the answer was read from, and why those. */
export function ScopeLine({ scope }: { scope: ScopeInfo }) {
  const all = scope.books.map((b) => b.title).join("\n");
  return (
    <p className="text-[13px] text-muted" title={scope.books.length > 1 ? all : undefined}>
      {formatScopeLine(scope)}
      <span className="ml-2 text-[12px] text-muted/70">· {scopeReasonHint(scope.reason)}</span>
    </p>
  );
}

/** What the answer took: calls, tokens, time. Never a price. */
export function UsageLine({ usage }: { usage: UsageInfo }) {
  return <p className="text-[12px] tabular-nums text-muted/70">{formatUsageLine(usage)}</p>;
}
