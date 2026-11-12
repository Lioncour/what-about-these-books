import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { claudeNaturalAnswer } from "@/lib/chat/orchestrator";
import { matchToSource } from "@/lib/chat/scope";
import { deriveMainCharacters } from "@/lib/chat/specialist";
import type { ChatSource } from "@/lib/chat/types";

/** "Who are the main characters?" — from entity prominence in the knowledge graph. */
export async function mainCharactersStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.route.kind !== "main_characters") return false;

  const { scope } = ctx;
  const copy = scope.text.mainCharacters;
  const mains = deriveMainCharacters(scope.books.map((b) => b.id));
  const lines: string[] = [];
  const sources: ChatSource[] = [];
  if (mains.length) {
    lines.push(copy.found(mains.length), "", "## Likely main characters");
    for (const m of mains) lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
    for (const m of mains.slice(0, 5)) sources.push(...scope.keyword([m.name], 4).map(matchToSource));
  } else {
    lines.push(copy.none);
  }
  logChatEvent("main_character_answered", { scope: scope.kind, count: mains.length });

  ctx.announceScope();
  // A structured list goes out as is; only the one-line "nobody yet" is rephrased.
  const text = await claudeNaturalAnswer({
    userQuestion: ctx.question,
    factualAnswer: lines.join("\n"),
    modelId: ctx.settings.orchestratorModelId,
    companionMode: ctx.settings.companionMode,
    signal: ctx.signal,
  });
  ctx.emitAnswer(text, { reason: "main_character", scope: scope.kind, usedSpecialists: false });
  ctx.sendSources(sources);
  return true;
}
