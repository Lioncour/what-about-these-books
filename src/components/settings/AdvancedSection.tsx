"use client";

import { useState } from "react";
import type { AISettings, SectionProps } from "@/components/settings/types";

/** Count mode and model routing overrides. */
export default function AdvancedSection({ settings, update }: SectionProps) {
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
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs"
          >
            <option value="whole_word">Count mode: whole word</option>
            <option value="phrase">Count mode: exact phrase</option>
            <option value="loose">Count mode: loose substring</option>
          </select>
          <input
            value={settings.modelRouting?.specialistModelId || ""}
            onChange={(e) =>
              update((p) => ({
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
              update((p) => ({
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
              update((p) => ({
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
  );
}
