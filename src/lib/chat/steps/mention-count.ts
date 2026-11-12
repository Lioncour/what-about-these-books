import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { formatExactMentionAnswer } from "@/lib/chat/mention-count";

/** Exact tally over the stored text — never specialists, never an estimate. */
function answerCount(ctx: ChatContext, target: string): boolean {
  const { countMode } = ctx.settings;
  const count = ctx.scope.countMentions(target, countMode);
  ctx.status(`Counting exact mentions of "${target}" ${count.where}...`);
  ctx.announceScope(count.books, count.reason);
  const text = formatExactMentionAnswer({
    target,
    total: count.total,
    byBook: count.byBook,
    scopeLabel: count.scopeLabel,
    countMode,
    includedTitles: count.includedTitles,
  });
  logChatEvent("mention_count_answered", {
    scope: count.kind,
    focus: ctx.bookId,
    mentionTarget: target,
    total: count.total,
    books: count.books.length,
    exact: true,
  });
  ctx.emitAnswer(text, { reason: "exact_mention_count", scope: count.kind });
  ctx.sendSources(count.sources);
  return true;
}

/** "How many times is X mentioned?" — runs first, before anything is embedded. */
export function exactCountStep(ctx: ChatContext): boolean {
  if (ctx.route.kind !== "mention_count") return false;
  if (ctx.mentionTarget) return answerCount(ctx, ctx.mentionTarget);

  ctx.emitAnswer("I can count mentions exactly in your indexed text — who should I count?", {
    reason: "missing_mention_target",
  });
  logChatEvent("mention_count_missing_target", { bookId: ctx.bookId, input: ctx.question.slice(0, 180) });
  return true;
}

/** "and Joe?" after a count: routed as an open question, but it has a count target. */
export function followUpCountStep(ctx: ChatContext): boolean {
  return ctx.mentionTarget ? answerCount(ctx, ctx.mentionTarget) : false;
}
