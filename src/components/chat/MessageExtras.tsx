"use client";

import type { ReactNode } from "react";
import {
  formatScopeLine,
  formatUsageParts,
  scopeReasonHint,
  usageTooltip,
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

/**
 * Which books the answer was read from, and why those; `action` (the "check the
 * other books" button) sits on the same line. The pieces wrap as whole pieces and
 * a wrapped line never starts with a separator (`.dot-row` in globals.css).
 */
export function ScopeLine({
  scope,
  action,
  followUp,
}: {
  scope: ScopeInfo;
  action?: ReactNode;
  /** This answer came from "Check the other books": the app chose these, not the reader. */
  followUp?: boolean;
}) {
  const all = scope.books.map((b) => b.title).join("\n");
  return (
    <div className="dot-row text-[13px] text-muted">
      <div>
        <span title={scope.books.length > 1 ? all : undefined}>{formatScopeLine(scope)}</span>
        <span className="text-[12px] text-muted/70">{followUp && scope.reason === "picked" ? "next closest of the rest" : scopeReasonHint(scope.reason)}
        </span>
        {action}
      </div>
    </div>
  );
}

/** The quiet action on the scope line; "Checked" once it has been used. */
export function ScopeAction({
  label,
  used,
  disabled,
  onClick,
}: {
  label: string;
  used: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  if (used) return <span className="text-[12px] text-muted/70">Checked</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? "Wait for the answer to finish"
          : "Ask the same question again against these books"
      }
      className="text-left text-[12px] font-medium text-primary/90 underline decoration-primary/30 underline-offset-[3px] transition-colors hover:text-primary hover:decoration-primary/70 focus-visible:decoration-primary focus-visible:outline-none disabled:cursor-default disabled:text-muted/60 disabled:no-underline"
    >
      {label}
    </button>
  );
}

/** What the answer took: calls, tokens, a rough cost when known, time. */
export function UsageLine({ usage }: { usage: UsageInfo }) {
  return (
    <div className="dot-row text-[12px] tabular-nums text-muted/70" title={usageTooltip(usage)}>
      <div>
        {formatUsageParts(usage).map((part, i) => (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ))}
      </div>
    </div>
  );
}
