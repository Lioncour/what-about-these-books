"use client";

import { useState } from "react";
import type { AISettings, SectionProps } from "@/components/settings/types";

/** Language, tone, instructions, answer style, memory, grounding, focus areas. */
export default function PersonalitySection({ settings, update }: SectionProps) {
  const [focusAreaInput, setFocusAreaInput] = useState("");

  const addFocusArea = () => {
    const value = focusAreaInput.trim();
    if (!value || settings.focusAreas.includes(value)) return;
    update((prev) => ({ ...prev, focusAreas: [...prev.focusAreas, value] }));
    setFocusAreaInput("");
  };

  return (
    <section className="space-y-8 rounded-[1.75rem] border border-border/50 bg-surface p-9">
      <h2 className="font-display text-base font-semibold">Personality</h2>
      <div className={settings.companionMode === false ? "pointer-events-none opacity-40" : ""}>
        <label className="mb-1 block text-xs font-medium text-muted">Language</label>
        <select
          className="mb-3 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
          value={settings.language}
          onChange={(e) => update((p) => ({ ...p, language: e.target.value }))}
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
          onChange={(e) => update((p) => ({ ...p, tone: e.target.value }))}
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
          onChange={(e) => update((p) => ({ ...p, customInstructions: e.target.value }))}
          rows={3}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
          placeholder="Anything you want me to keep in mind…"
        />
      </div>

      <label className="mb-1 block text-xs font-medium text-muted">Answer style</label>
      <select
        value={settings.answerMode || "Evidence-heavy"}
        onChange={(e) =>
          update((p) => ({
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
            update((p) => ({ ...p, useConversationMemory: e.target.checked }))
          }
        />
        Remember this conversation for follow-ups
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(settings.groundedMode)}
          onChange={(e) => update((p) => ({ ...p, groundedMode: e.target.checked }))}
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
                  update((p) => ({
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
  );
}
