"use client";

import { useState } from "react";

export interface Source {
  book: string;
  excerpt: string;
  position?: string;
  bookId?: string;
}

export interface SpecialistReport {
  bookTitle: string;
  confidence: "high" | "medium" | "low";
  numericEstimate: number | null;
  directAnswer: string;
  findingsCount: number;
  topFindings: { finding: string; location: string }[];
  caveats: string[];
  reasked?: boolean;
  scorecard?: { precisionEstimate: number; recallEstimate: number; total: number };
}

export interface WhyInfo {
  groundedMode: boolean;
  sourceCount: number;
  specialistModelId: string;
  orchestratorModelId: string;
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

export function SpecialistReportsList({ reports }: { reports: SpecialistReport[] }) {
  const [expanded, setExpanded] = useState(false);
  const high = reports.filter((r) => r.confidence === "high").length;
  const med = reports.filter((r) => r.confidence === "medium").length;
  const low = reports.filter((r) => r.confidence === "low").length;

  return (
    <div className="rounded-xl border border-border/80 bg-surface/60 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-xs text-muted transition-colors hover:text-foreground"
      >
        <span className="font-medium text-foreground/90">
          How I looked this up · {reports.length} books (high {high}, med {med}, low {low})
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {reports.map((r) => (
            <div key={r.bookTitle} className="rounded-lg border border-border bg-background/50 px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{r.bookTitle}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    r.confidence === "high"
                      ? "bg-success/15 text-success"
                      : r.confidence === "medium"
                        ? "bg-warning/15 text-warning"
                        : "bg-danger/15 text-danger"
                  }`}
                >
                  {r.confidence}
                </span>
                {r.numericEstimate !== null && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    estimate: {r.numericEstimate}
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted">{r.directAnswer}</p>
              {r.reasked && (
                <p className="mt-1 text-[11px] text-warning">Looked again because confidence was low.</p>
              )}
              {r.topFindings.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-muted">
                  {r.topFindings.map((f, i) => (
                    <li key={i}>
                      – {f.finding} <span className="text-[10px]">({f.location})</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.caveats.length > 0 && (
                <p className="mt-1 text-[11px] text-muted">Caveats: {r.caveats.join("; ")}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WhyPanel({ why }: { why: WhyInfo }) {
  return (
    <div className="rounded-xl border border-border/80 bg-surface/60 px-3 py-2 text-xs text-muted">
      <p className="font-medium text-foreground/90">Why this answer</p>
      <p>Grounded mode: {why.groundedMode ? "strict" : "off"}</p>
      <p>Sources used: {why.sourceCount}</p>
      <p className="truncate">Models: {why.specialistModelId} → {why.orchestratorModelId}</p>
    </div>
  );
}
