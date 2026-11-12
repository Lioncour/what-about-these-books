"use client";

import { useCallback, useEffect, useState } from "react";

type UsageBucket = {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  claudeCalls: number;
  embeddingCalls: number;
  claudeTokens: number;
};

type TokenUsageSummary = {
  totals: UsageBucket;
  today: UsageBucket;
  last7Days: UsageBucket;
  byModel: Array<{
    kind: "claude" | "embedding";
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    embeddingTokens: number;
    calls: number;
    tokens: number;
  }>;
  recent: Array<{
    id: string;
    at: string;
    kind: "claude" | "embedding";
    modelId: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  updatedAt?: string;
};

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function shortModelId(modelId: string): string {
  const parts = modelId.split("/");
  const last = parts[parts.length - 1] || modelId;
  return last.length > 42 ? `${last.slice(0, 40)}…` : last;
}

/** Local count of Claude and embedding tokens; loads and resets itself. */
export default function TokenUsageSection() {
  const [open, setOpen] = useState(true);
  const [usage, setUsage] = useState<TokenUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const res = await fetch("/api/token-usage");
      if (res.ok) setUsage(await res.json());
    } catch {
      /* ignore */
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const resetUsage = useCallback(async () => {
    if (!window.confirm("Reset all local token usage counters?")) return;
    await fetch("/api/token-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    await loadUsage();
  }, [loadUsage]);

  return (
    <section className="rounded-[1.75rem] border border-border/50 bg-surface p-7">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <h2 className="font-display text-base font-semibold">Token usage</h2>
          <p className="mt-1 text-sm text-muted">
            Local count of Claude + embedding tokens via AWS Bedrock.
          </p>
        </div>
        <span className="text-xs text-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {usageLoading && !usage ? (
            <p className="text-sm text-muted">Loading usage…</p>
          ) : usage ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-border bg-background px-3 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted">All time</p>
                  <p className="mt-1 font-display text-xl font-semibold tabular-nums">
                    {formatTokens(usage.totals.claudeTokens + usage.totals.embeddingTokens)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatTokens(usage.totals.inputTokens)} in ·{" "}
                    {formatTokens(usage.totals.outputTokens)} out ·{" "}
                    {formatTokens(usage.totals.embeddingTokens)} embed
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-background px-3 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted">Today</p>
                  <p className="mt-1 font-display text-xl font-semibold tabular-nums">
                    {formatTokens(usage.today.claudeTokens + usage.today.embeddingTokens)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {usage.today.claudeCalls} Claude · {usage.today.embeddingCalls} embed
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-background px-3 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted">Last 7 days</p>
                  <p className="mt-1 font-display text-xl font-semibold tabular-nums">
                    {formatTokens(
                      usage.last7Days.claudeTokens + usage.last7Days.embeddingTokens
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {usage.last7Days.claudeCalls} Claude · {usage.last7Days.embeddingCalls}{" "}
                    embed
                  </p>
                </div>
              </div>

              {usage.byModel.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-muted">By model</p>
                  <ul className="space-y-1.5">
                    {usage.byModel.slice(0, 6).map((row) => (
                      <li
                        key={`${row.kind}:${row.modelId}`}
                        className="flex items-baseline justify-between gap-3 rounded-lg border border-border/70 px-3 py-2 text-xs"
                      >
                        <span className="min-w-0 truncate text-muted">
                          <span className="text-foreground">{row.kind}</span> ·{" "}
                          {shortModelId(row.modelId)}
                        </span>
                        <span className="shrink-0 tabular-nums text-foreground">
                          {formatTokens(row.tokens)} · {row.calls} calls
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {usage.recent.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-muted">Recent calls</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted">
                    {usage.recent.slice(0, 12).map((ev) => (
                      <li key={ev.id} className="flex justify-between gap-2 tabular-nums">
                        <span className="truncate">
                          {new Date(ev.at).toLocaleString()} · {ev.kind}
                        </span>
                        <span className="shrink-0">
                          {ev.kind === "embedding"
                            ? `${formatTokens(ev.inputTokens)} embed`
                            : `${formatTokens(ev.inputTokens)} / ${formatTokens(ev.outputTokens)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void loadUsage()}
                  className="rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-foreground"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void resetUsage()}
                  className="rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-foreground"
                >
                  Reset counters
                </button>
              </div>
              <p className="text-[11px] text-muted">
                Starts from when tracking was added. Exact-count / keyword answers that skip Claude
                don’t use tokens.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">Couldn’t load usage yet.</p>
          )}
        </div>
      )}
    </section>
  );
}
