import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { isDryRun } from "@/lib/chat/request-context";
import { ROUTER_MAX_TOKENS, resolveRouteWithModel } from "@/lib/chat/router";
import { callSpecialistClaude } from "@/lib/chat/specialist-model";
import { ensureKnowledgeCurrent } from "@/lib/knowledge-rebuild";
import { knownCharacterNames } from "@/lib/knowledge-store";

/** "Is this a character the books know?" The graph is read once, and only when asked. */
function characterLookup(): (name: string) => boolean {
  let names: Set<string> | null = null;
  return (name) => {
    if (!names) {
      try {
        ensureKnowledgeCurrent();
        names = knownCharacterNames();
      } catch {
        names = new Set();
      }
    }
    return names.has(name.toLowerCase().replace(/’/g, "'"));
  };
}

/**
 * When no rule claimed the question (`open_rag`) and it looks like it might be a job
 * for a tool after all, the cheap librarian model picks the route: one short call, at
 * most once per request, never for a question a rule already routed. Never answers;
 * it only changes where the pipeline goes next.
 */
export async function routeFallbackStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.routerAsked || ctx.route.kind !== "open_rag") return false;
  // A bare quoted line and a count follow-up are claimed by a rule although the route says open_rag.
  if (ctx.quoteMode || ctx.mentionTarget) return false;

  const result = await resolveRouteWithModel({
    route: ctx.route,
    question: ctx.question,
    isKnownName: characterLookup(),
    signal: ctx.signal,
    dryRun: isDryRun(),
    ask: async (prompt, signal) =>
      (
        await callSpecialistClaude(prompt, ROUTER_MAX_TOKENS, 0, {
          fixedModelId: ctx.settings.specialistModelId,
          signal,
        })
      ).text,
  });
  ctx.routerAsked = result.asked;
  if (!result.asked) return false;

  const changed = result.route.kind !== "open_rag";
  if (changed) {
    ctx.route = result.route;
    // The steps read the count target and the quote from the context, as the rules set them.
    if (result.route.kind === "mention_count") ctx.mentionTarget = result.route.target || null;
    if (result.route.kind === "quote_lookup") ctx.quoteMode = result.route.target || null;
  }
  logChatEvent("chat_route_fallback", {
    bookId: ctx.bookId,
    question: ctx.question.slice(0, 200),
    outcome: result.outcome,
    kind: result.route.kind,
    target: result.route.target || null,
    changed,
  });
  return false;
}
