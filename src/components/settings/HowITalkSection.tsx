"use client";

import type { SectionProps } from "@/components/settings/types";

/** Companion voice or raw answers. */
export default function HowITalkSection({ settings, update }: SectionProps) {
  return (
    <section className="rounded-[1.75rem] border border-border/50 bg-surface p-7">
      <h2 className="font-display text-base font-semibold">How I talk</h2>
      <p className="mt-1 text-sm text-muted">
        Companion mode feels like a friend who knows your books. Raw mode skips welcome, presence
        copy, and personality — just the answer.
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => update((p) => ({ ...p, companionMode: true }))}
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
          onClick={() => update((p) => ({ ...p, companionMode: false }))}
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
  );
}
