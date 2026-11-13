import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { matchToSource } from "@/lib/chat/scope";
import { synthesizeWhoIsAnswer } from "@/lib/chat/specialist";
import { ensureKnowledgeCurrent } from "@/lib/knowledge-rebuild";
import { lookupEntity, type KnownEntity } from "@/lib/knowledge-store";

/** What the entity graph knows about the name; a graph that can't be read is no reason to fail. */
function knownEntity(target: string, bookIds: string[]): KnownEntity | null {
  try {
    ensureKnowledgeCurrent();
    return lookupEntity(target, bookIds);
  } catch (error) {
    logChatEvent("who_is_graph_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * The forms of a name worth searching for. A form that contains another one as whole
 * words is dropped, because the shorter finds the same places and more: "Hans Chotek"
 * with the aliases "Hans" and "Chotek" is searched as "Hans" and "Chotek".
 */
export function whoIsSearchTerms(target: string, entity: KnownEntity | null): string[] {
  const forms: string[] = [];
  for (const form of [target, entity?.name, ...(entity?.aliases || [])]) {
    const clean = form?.trim();
    if (clean && !forms.some((f) => f.toLowerCase() === clean.toLowerCase())) forms.push(clean);
  }
  const words = (s: string) => s.toLowerCase().split(/\s+/);
  const covers = (short: string, long: string) => {
    const s = words(short);
    const l = words(long);
    return s.length < l.length && l.some((_, i) => s.every((w, j) => l[i + j] === w));
  };
  return forms.filter((form) => !forms.some((other) => other !== form && covers(other, form))).slice(0, 6);
}

/**
 * "Who is Skippy?" / "Who are the Kristang?": keyword hits for the name and the other
 * forms the entity graph knows it by, summarised by one Claude call that is told what
 * kind of thing the name is (a person, a group, a place).
 */
export async function whoIsStep(ctx: ChatContext): Promise<boolean> {
  const target = ctx.route.kind === "who_is" ? ctx.route.target : null;
  if (!target) return false;

  const { scope } = ctx;
  ctx.status(scope.text.whoIs.status(target));
  const entity = knownEntity(
    target,
    scope.books.map((b) => b.id)
  );
  const terms = whoIsSearchTerms(target, entity);
  const matches = scope.keyword(terms, 120);
  const sources = matches.slice(0, 30).map(matchToSource);

  const perBook = new Map<string, number>();
  for (const m of matches) perBook.set(m.bookTitle, (perBook.get(m.bookTitle) || 0) + 1);
  const topBook = [...perBook.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  ctx.announceScope();
  const summary = await synthesizeWhoIsAnswer({
    target: entity?.name || target,
    question: ctx.question,
    entity,
    scopeLabel: scope.text.whoIs.label(topBook),
    snippets: sources.map((s) => ({ book: s.book, label: s.position || "Unknown location", snippet: s.excerpt })),
    conversationContext: ctx.recentConversation,
    modelId: ctx.settings.orchestratorModelId,
    signal: ctx.signal,
  });
  ctx.emitAnswer(summary, { reason: "who_is", scope: scope.kind });
  ctx.sendSources(sources);
  logChatEvent("who_is_answered", {
    scope: scope.kind,
    whoTarget: target,
    entity: entity?.name || null,
    entityType: entity?.type || null,
    terms,
    matches: matches.length,
  });
  return true;
}
