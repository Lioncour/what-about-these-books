"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";

interface AISettings {
  language: string;
  tone: string;
  customInstructions: string;
  focusAreas: string[];
  groundedMode?: boolean;
  answerMode?: "Quick" | "Evidence-heavy" | "Exact count" | "Compare books";
  useConversationMemory?: boolean;
  countMode?: "whole_word" | "phrase" | "loose";
  companionMode?: boolean;
  modelRouting?: {
    specialistModelId?: string;
    orchestratorModelId?: string;
    extractionModelId?: string;
  };
}

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

const DEFAULTS: AISettings = {
  language: "Auto",
  tone: "Casual",
  customInstructions: "",
  focusAreas: [],
  groundedMode: false,
  answerMode: "Evidence-heavy",
  useConversationMemory: true,
  countMode: "whole_word",
  companionMode: true,
  modelRouting: {},
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

export default function SettingsPage() {
  const [settings, setSettings] = useState<AISettings>(DEFAULTS);
  const [focusAreaInput, setFocusAreaInput] = useState("");
  const [workspaceNote, setWorkspaceNote] = useState("");
  const [saved, setSaved] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(true);
  const [loading, setLoading] = useState(true);
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
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings({
          ...DEFAULTS,
          ...data,
          companionMode: data.companionMode !== false,
          modelRouting: data.modelRouting || {},
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    void loadUsage();
  }, [loadUsage]);

  const save = useCallback(async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }, [settings]);

  const resetUsage = useCallback(async () => {
    if (!window.confirm("Reset all local token usage counters?")) return;
    await fetch("/api/token-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    await loadUsage();
  }, [loadUsage]);

  const addFocusArea = () => {
    const value = focusAreaInput.trim();
    if (!value || settings.focusAreas.includes(value)) return;
    setSettings((prev) => ({ ...prev, focusAreas: [...prev.focusAreas, value] }));
    setFocusAreaInput("");
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="app-chrome-header border-b border-border/50 bg-surface/90 px-6 pb-4 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link
            href="/"
            className="rounded-xl border border-border/60 px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
          >
            ← Back
          </Link>
          <BrandMark className="h-8 w-8 shrink-0" />
          <h1 className="font-display text-xl font-semibold tracking-tight">Settings</h1>
          {saved && <span className="text-xs text-primary">Saved</span>}
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-10 px-8 py-12">
        <section className="rounded-[1.75rem] border border-border/50 bg-surface p-7">
          <h2 className="font-display text-base font-semibold">How I talk</h2>
          <p className="mt-1 text-sm text-muted">
            Companion mode feels like a friend who knows your books. Raw mode skips welcome, presence
            copy, and personality — just the answer.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setSettings((p) => ({ ...p, companionMode: true }))}
              className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                settings.companionMode !== false
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border hover:bg-surface-hover"
              }`}
            >
              <p className="text-sm font-medium">Companion</p>
              <p className="mt-0.5 text-xs text-muted">Warm voice, welcome, “remember with me”</p>
            </button>
            <button
              type="button"
              onClick={() => setSettings((p) => ({ ...p, companionMode: false }))}
              className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                settings.companionMode === false
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border hover:bg-surface-hover"
              }`}
            >
              <p className="text-sm font-medium">Raw answers</p>
              <p className="mt-0.5 text-xs text-muted">No chatty extras — evidence only</p>
            </button>
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-border/50 bg-surface p-7">
          <button
            type="button"
            onClick={() => setUsageOpen((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <div>
              <h2 className="font-display text-base font-semibold">Token usage</h2>
              <p className="mt-1 text-sm text-muted">
                Local count of Claude + embedding tokens via AWS Bedrock.
              </p>
            </div>
            <span className="text-xs text-muted">{usageOpen ? "Hide" : "Show"}</span>
          </button>

          {usageOpen && (
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

        <section className="space-y-6 rounded-[1.75rem] border border-border/50 bg-surface p-7">
          <h2 className="font-display text-base font-semibold">Personality</h2>
          <div className={settings.companionMode === false ? "pointer-events-none opacity-40" : ""}>
            <label className="mb-1 block text-xs font-medium text-muted">Language</label>
            <select
              className="mb-3 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              value={settings.language}
              onChange={(e) => setSettings((p) => ({ ...p, language: e.target.value }))}
            >
              {["Auto", "English", "Norwegian", "Spanish", "French", "German"].map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>

            <label className="mb-1 block text-xs font-medium text-muted">Tone</label>
            <select
              className="mb-3 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              value={settings.tone}
              onChange={(e) => setSettings((p) => ({ ...p, tone: e.target.value }))}
            >
              {["Casual", "Scientific", "Teacher-like", "Concise", "Custom"].map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>

            <label className="mb-1 block text-xs font-medium text-muted">Custom instructions</label>
            <textarea
              value={settings.customInstructions}
              onChange={(e) => setSettings((p) => ({ ...p, customInstructions: e.target.value }))}
              rows={3}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              placeholder="Anything you want me to keep in mind…"
            />
          </div>

          <label className="mb-1 block text-xs font-medium text-muted">Answer style</label>
          <select
            value={settings.answerMode || "Evidence-heavy"}
            onChange={(e) =>
              setSettings((p) => ({
                ...p,
                answerMode: e.target.value as AISettings["answerMode"],
              }))
            }
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
          >
            {["Quick", "Evidence-heavy", "Exact count", "Compare books"].map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.useConversationMemory !== false}
              onChange={(e) =>
                setSettings((p) => ({ ...p, useConversationMemory: e.target.checked }))
              }
            />
            Remember this conversation for follow-ups
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(settings.groundedMode)}
              onChange={(e) => setSettings((p) => ({ ...p, groundedMode: e.target.checked }))}
            />
            Strict grounded mode (refuse uncited answers)
          </label>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Focus areas</label>
            <div className="mb-2 flex flex-wrap gap-2">
              {settings.focusAreas.map((area) => (
                <span
                  key={area}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs text-primary"
                >
                  {area}
                  <button
                    type="button"
                    onClick={() =>
                      setSettings((p) => ({
                        ...p,
                        focusAreas: p.focusAreas.filter((a) => a !== area),
                      }))
                    }
                    className="rounded p-0.5 hover:bg-primary/20"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={focusAreaInput}
                onChange={(e) => setFocusAreaInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addFocusArea();
                  }
                }}
                className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm"
                placeholder="Add a focus…"
              />
              <button
                type="button"
                onClick={addFocusArea}
                className="rounded-xl border border-border px-3 py-2 text-sm text-muted hover:text-foreground"
              >
                Add
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-border/50 bg-surface p-7">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <h2 className="font-display text-base font-semibold">Advanced</h2>
            <span className="text-xs text-muted">{advancedOpen ? "Hide" : "Show"}</span>
          </button>
          {advancedOpen && (
            <div className="mt-4 space-y-2">
              <select
                value={settings.countMode || "whole_word"}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    countMode: e.target.value as AISettings["countMode"],
                  }))
                }
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs"
              >
                <option value="whole_word">Count mode: whole word</option>
                <option value="phrase">Count mode: exact phrase</option>
                <option value="loose">Count mode: loose substring</option>
              </select>
              <input
                value={settings.modelRouting?.specialistModelId || ""}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    modelRouting: { ...(p.modelRouting || {}), specialistModelId: e.target.value },
                  }))
                }
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs"
                placeholder="Specialist model ID"
              />
              <input
                value={settings.modelRouting?.orchestratorModelId || ""}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    modelRouting: { ...(p.modelRouting || {}), orchestratorModelId: e.target.value },
                  }))
                }
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs"
                placeholder="Orchestrator model ID"
              />
              <input
                value={settings.modelRouting?.extractionModelId || ""}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    modelRouting: { ...(p.modelRouting || {}), extractionModelId: e.target.value },
                  }))
                }
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs"
                placeholder="Extraction model ID"
              />
            </div>
          )}
        </section>

        <section className="rounded-[1.75rem] border border-border/50 bg-surface p-7">
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <h2 className="font-display text-base font-semibold">Library tools</h2>
            <span className="text-xs text-muted">{toolsOpen ? "Hide" : "Show"}</span>
          </button>
          {toolsOpen && (
            <div className="mt-4 space-y-3">
              <textarea
                value={workspaceNote}
                onChange={(e) => setWorkspaceNote(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                placeholder="Quick research note…"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const text = workspaceNote.trim();
                    if (!text) return;
                    await fetch("/api/workspace", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ text, source: "Settings" }),
                    });
                    setWorkspaceNote("");
                  }}
                  className="rounded-xl border border-border px-3 py-2 text-left text-xs"
                >
                  Save note
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetch("/api/workspace?mode=export");
                    const data = await res.json();
                    if (data?.markdown) await navigator.clipboard.writeText(data.markdown);
                  }}
                  className="rounded-xl border border-border px-3 py-2 text-left text-xs"
                >
                  Copy workspace export
                </button>
                <button
                  type="button"
                  onClick={() => fetch("/api/reindex", { method: "POST" })}
                  className="rounded-xl border border-border px-3 py-2 text-left text-xs"
                >
                  Re-index library
                </button>
                <button
                  type="button"
                  onClick={() =>
                    fetch("/api/safety", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "backup" }),
                    })
                  }
                  className="rounded-xl border border-border px-3 py-2 text-left text-xs"
                >
                  Backup now
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="flex justify-end gap-2 pb-10">
          <Link
            href="/"
            className="rounded-xl border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </Link>
          <button
            type="button"
            onClick={() => void save()}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-[#e8ddd0] hover:bg-primary-hover"
          >
            Save settings
          </button>
        </div>
      </main>
    </div>
  );
}
