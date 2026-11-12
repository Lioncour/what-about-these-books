import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { matchToSource } from "@/lib/chat/scope";
import { synthesizeWhoIsAnswer } from "@/lib/chat/specialist";

/** "Who is Skippy?" — keyword hits for the name, summarised by one Claude call. */
export async function whoIsStep(ctx: ChatContext): Promise<boolean> {
  const target = ctx.route.kind === "who_is" ? ctx.route.target : null;
  if (!target) return false;

  const { scope } = ctx;
  ctx.status(scope.text.whoIs.status(target));
  const matches = scope.keyword([target], 120);
  const sources = matches.slice(0, 30).map(matchToSource);

  const perBook = new Map<string, number>();
  for (const m of matches) perBook.set(m.bookTitle, (perBook.get(m.bookTitle) || 0) + 1);
  const topBook = [...perBook.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  ctx.announceScope();
  const summary = await synthesizeWhoIsAnswer({
    target,
    scopeLabel: scope.text.whoIs.label(topBook),
    snippets: sources.map((s) => ({ book: s.book, label: s.position || "Unknown location", snippet: s.excerpt })),
    conversationContext: ctx.recentConversation,
    modelId: ctx.settings.orchestratorModelId,
    signal: ctx.signal,
  });
  ctx.emitAnswer(summary, { reason: "who_is", scope: scope.kind });
  ctx.sendSources(sources);
  logChatEvent("who_is_answered", { scope: scope.kind, whoTarget: target, matches: matches.length });
  return true;
}
