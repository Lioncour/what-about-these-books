"use client";

import { useCallback, useEffect, useState } from "react";

interface CharacterApiResponse {
  character: string;
  found: boolean;
  type?: string;
  mentions?: number;
  books?: string[];
  relations?: Array<{ from: string; to: string; relation: string; location: string }>;
  snippets?: Array<{ bookTitle: string; location: string; snippet: string }>;
}

type RunLocal = (question: string, answer: () => Promise<string>, failure: string) => Promise<void>;

async function characterPage(name: string): Promise<string> {
  const res = await fetch(`/api/knowledge?mode=character&character=${encodeURIComponent(name)}`);
  const data = (await res.json()) as CharacterApiResponse;
  if (!data.found) return `I couldn't find a character profile for **${name}** yet.`;
  return [
    `## Character Page: ${data.character}`,
    "",
    `- Type: **${data.type || "unknown"}**`,
    `- Mentions tracked: **${data.mentions ?? 0}**`,
    `- Books in graph: **${data.books?.length ?? 0}**`,
    "",
    "### Relationship edges",
    ...(data.relations
      ?.slice(0, 8)
      .map((r) => `- ${r.from} -> ${r.to} (${r.relation}, ${r.location})`) || [
      "- No relationships available yet.",
    ]),
    "",
    "### Evidence snippets",
    ...(data.snippets
      ?.slice(0, 8)
      .map((s) => `- **${s.bookTitle}** (${s.location}): ${s.snippet}`) || [
      "- No snippets available yet.",
    ]),
  ].join("\n");
}

async function contradictions(topic: string): Promise<string> {
  const res = await fetch(`/api/knowledge?mode=contradictions&q=${encodeURIComponent(topic)}`);
  const data = (await res.json()) as { contradictions?: string[] };
  const rows = data.contradictions || [];
  return rows.length
    ? `## Cross-book contradictions for ${topic}\n\n${rows.map((r) => `- ${r}`).join("\n")}`
    : `I didn't detect obvious contradictions for **${topic}** across the indexed books.`;
}

/**
 * The Ctrl+K command box: `new`, `all`, `character:Name`, `contradictions:Topic`.
 */
export function useQuickActions({
  runLocal,
  onNewChat,
  onClearFocus,
}: {
  runLocal: RunLocal;
  onNewChat: () => void;
  onClearFocus: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const run = useCallback(
    (command: string) => {
      setOpen(false);
      const trimmed = command.trim();
      const lower = trimmed.toLowerCase();
      const argument = trimmed.split(":").slice(1).join(":").trim();

      if (trimmed === "new") {
        onNewChat();
      } else if (trimmed === "all") {
        onClearFocus();
        onNewChat();
      } else if (lower.startsWith("character:") && argument) {
        void runLocal(
          `Show character page for ${argument}`,
          () => characterPage(argument),
          "Failed to load character page"
        );
      } else if (lower.startsWith("contradictions:") && argument) {
        void runLocal(
          `Check contradictions for ${argument}`,
          () => contradictions(argument),
          "Failed to run contradiction check"
        );
      }
    },
    [runLocal, onNewChat, onClearFocus]
  );

  return { open, close, run };
}
