import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { isSoftRecipeQuestion } from "@/lib/chat/intent";
import { findSmartPassages, formatPassageFindAnswer } from "@/lib/chat/passage-find";
import { dedupeSources } from "@/lib/chat/theme-survey";

/** Passage / recipe / "find that thing": a short answer plus clickable sources. */
export function passageFindStep(ctx: ChatContext): boolean {
  if (ctx.route.kind !== "passage_find") return false;

  // Hand-picked books search the library and keep only hits inside the pick.
  const hits = ctx.scope.picked
    ? findSmartPassages({ question: ctx.question, bookId: ctx.bookId, maxHits: 40 })
        .filter((hit) => ctx.scope.includes(hit.bookId))
        .slice(0, 3)
    : findSmartPassages({ question: ctx.question, bookId: ctx.bookId, maxHits: 3 });
  // "How do you make X?" without the word recipe: only a passage about X that lists
  // things is a recipe. Anything else is a reading question; the later steps answer it.
  if (isSoftRecipeQuestion(ctx.question) && !(hits[0]?.items?.length && hits[0].aboutAll)) {
    logChatEvent("passage_find_passed", { bookId: ctx.bookId, hits: hits.length });
    return false;
  }
  ctx.announceScope();
  // Primary hit first; at most one related reference.
  const sources = hits.slice(0, 2).map((hit) => ({
    book: cleanBookDisplayTitle(hit.bookTitle),
    excerpt: hit.snippet,
    position: hit.label,
    bookId: hit.bookId,
  }));
  logChatEvent("passage_find_answered", {
    bookId: ctx.bookId,
    hits: hits.length,
    topScore: hits[0]?.score ?? 0,
    topReason: hits[0]?.reason ?? null,
    topBook: hits[0]?.bookTitle ?? null,
  });
  ctx.emitAnswer(formatPassageFindAnswer({ question: ctx.question, hits }), {
    reason: "passage_find",
    hits: hits.length,
  });
  ctx.sendSources(dedupeSources(sources));
  return true;
}
