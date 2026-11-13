"use client";

import { useState } from "react";

/** Research notes, workspace export, re-index, backup. */
export default function LibraryToolsSection() {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [workspaceNote, setWorkspaceNote] = useState("");

  return (
    <section className="rounded-[1.75rem] border border-border/50 bg-surface p-9">
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
  );
}
