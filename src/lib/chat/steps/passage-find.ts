import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { findSmartPassages, formatPassageFindAnswer } from "@/lib/chat/passage-find";
import { dedupeSources } from "@/lib/chat/theme-survey";

/** Passage / recipe / "find that thing": a short answer plus clickable sources. */
export function passageFindStep(ctx: ChatContext): boolean {
  if (ctx.route.kind !== "passage_find") return false;

  ctx.announceScope();
  const hits = findSmartPassages({ question: ctx.question, bookId: ctx.bookId, maxHits: 3 });
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
