"use client";

import { useState } from "react";
import type { AISettings, ModelRoutingStatus, SectionProps } from "@/components/settings/types";

type LibrarianMode = "auto" | "main" | "custom";

const INPUT = "w-full rounded-xl border border-border bg-background px-3 py-2 text-xs";

function checkedOn(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : ` · checked ${date.toLocaleDateString()}`;
}

/** Which model the librarians (one per book) run on: auto, the main model, or a custom id. */
function LibrarianModel({
  settings,
  update,
  routing,
  onRecheck,
}: SectionProps & { routing: ModelRoutingStatus | null; onRecheck: () => Promise<unknown> }) {
  const fixed = settings.modelRouting?.specialistModelId?.trim() || "";
  const mainModelId = routing?.mainModelId || "";
  const [customOpen, setCustomOpen] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const mode: LibrarianMode = customOpen ? "custom" : !fixed ? "auto" : fixed === mainModelId ? "main" : "custom";

  const setFixed = (specialistModelId: string) =>
    update((p) => ({ ...p, modelRouting: { ...(p.modelRouting || {}), specialistModelId } }));
  const choose = (next: LibrarianMode) => {
    setCustomOpen(next === "custom");
    if (next === "auto") setFixed("");
    if (next === "main") setFixed(mainModelId);
  };

  const saved = routing?.specialist;
  // The status describes what is saved; a choice made here applies once it is saved.
  const savedMode: LibrarianMode | null = !saved
    ? null
    : saved.mode === "auto"
      ? "auto"
      : saved.modelId === mainModelId
        ? "main"
        : "custom";
  const pending = savedMode !== null && (savedMode !== mode || (mode === "custom" && saved?.modelId !== fixed));

  return (
    <div className="space-y-2 rounded-xl border border-border/60 p-3">
      <p className="text-xs font-medium">Librarians’ model</p>
      <p className="text-xs text-muted">
        {saved
          ? saved.mode === "auto"
            ? `Librarians: auto — using ${saved.modelId}`
            : `Librarians: fixed — using ${saved.modelId}`
          : "Librarians: status unavailable"}
        {pending ? " (your change applies after Save settings)" : ""}
      </p>
      <select value={mode} onChange={(e) => choose(e.target.value as LibrarianMode)} className={INPUT}>
        <option value="auto">Auto: a cheaper model when your account has one, else the main model</option>
        <option value="main" disabled={!mainModelId}>
          Use main model for everything{mainModelId ? ` (${mainModelId})` : ""}
        </option>
        <option value="custom">Custom model ID</option>
      </select>
      {mode === "custom" && (
        <input
          value={fixed}
          onChange={(e) => setFixed(e.target.value)}
          className={INPUT}
          placeholder="Librarian model ID, e.g. eu.anthropic.claude-haiku-4-5-20251001-v1:0"
        />
      )}
      {saved?.mode === "auto" && (
        <>
          {saved.tried.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted">
              {saved.tried.map((t) => (
                <li key={t.modelId}>
                  <span className={t.usable ? "text-primary" : ""}>{t.usable ? "Usable" : "Not usable"}</span>
                  {": "}
                  <span className="break-all">{t.modelId}</span>
                  {checkedOn(t.checkedAt)}
                  {!t.usable && t.reason ? <span className="block break-words pl-3">{t.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No cheaper model tried yet; the next open question tries one.</p>
          )}
          <button
            type="button"
            disabled={rechecking}
            onClick={() => {
              setRechecking(true);
              void onRecheck().finally(() => setRechecking(false));
            }}
            className="rounded-xl border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50"
          >
            {rechecking ? "Re-checking…" : "Re-check"}
          </button>
        </>
      )}
    </div>
  );
}

/** Count mode and model routing overrides. */
export default function AdvancedSection({
  settings,
  update,
  routing,
  onRecheck,
}: SectionProps & { routing: ModelRoutingStatus | null; onRecheck: () => Promise<unknown> }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
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
              update((p) => ({
                ...p,
                countMode: e.target.value as AISettings["countMode"],
              }))
            }
            className={INPUT}
          >
            <option value="whole_word">Count mode: whole word</option>
            <option value="phrase">Count mode: exact phrase</option>
            <option value="loose">Count mode: loose substring</option>
          </select>
          <LibrarianModel settings={settings} update={update} routing={routing} onRecheck={onRecheck} />
          <input
            value={settings.modelRouting?.orchestratorModelId || ""}
            onChange={(e) =>
              update((p) => ({
                ...p,
                modelRouting: { ...(p.modelRouting || {}), orchestratorModelId: e.target.value },
              }))
            }
            className={INPUT}
            placeholder="Orchestrator model ID (empty: main model)"
          />
          <input
            value={settings.modelRouting?.extractionModelId || ""}
            onChange={(e) =>
              update((p) => ({
                ...p,
                modelRouting: { ...(p.modelRouting || {}), extractionModelId: e.target.value },
              }))
            }
            className={INPUT}
            placeholder="Extraction model ID (empty: main model)"
          />
        </div>
      )}
    </section>
  );
}
