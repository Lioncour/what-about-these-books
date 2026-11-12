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

/**
 * "How many times is X mentioned?", and "and Joe?" right after one — runs first, before
 * anything is embedded.
 */
export function exactCountStep(ctx: ChatContext): boolean {
  if (ctx.route.kind !== "mention_count") return false;
  if (ctx.mentionTarget) return answerCount(ctx, ctx.mentionTarget);

  ctx.emitAnswer("I can count mentions exactly in your indexed text — who should I count?", {
    reason: "missing_mention_target",
  });
  logChatEvent("mention_count_missing_target", { bookId: ctx.bookId, input: ctx.question.slice(0, 180) });
  return true;
}

/** "Which books mention X?" — the books, with exact counts, straight from the stored text. */
export function booksMentioningStep(ctx: ChatContext): boolean {
  if (ctx.route.kind !== "books_mentioning" || !ctx.route.target) return false;
  const target = ctx.route.target;
  const { countMode } = ctx.settings;
  const count = ctx.scope.countMentions(target, countMode);
  ctx.status(`Checking which books mention "${target}" ${count.where}...`);
  ctx.announceScope(count.books, count.reason);

  const searched = count.books.length;
  const method = `exact text search, **${countMode.replace(/_/g, " ")}** match, not an AI estimate`;
  const lines: string[] = [];
  if (!count.byBook.length) {
    lines.push(
      `No — **${target}** isn't mentioned ${count.scopeLabel} (${method}). I checked ${searched} book${searched === 1 ? "" : "s"}.`
    );
  } else {
    const hits = count.byBook.length;
    lines.push(
      `**${target}** is mentioned in **${hits} of ${searched}** book${searched === 1 ? "" : "s"} ${count.scopeLabel} (${method}):`,
      ""
    );
    for (const [title, n] of count.byBook.slice(0, 40)) {
      lines.push(`- **${title}**: ${n.toLocaleString()} time${n === 1 ? "" : "s"}`);
    }
    const hitTitles = new Set(count.byBook.map(([title]) => title));
    const without = count.books.map((b) => b.title).filter((title) => !hitTitles.has(title));
    if (without.length && without.length <= 20) {
      lines.push("", `Not mentioned in: ${without.join(", ")}.`);
    }
  }
  logChatEvent("books_mentioning_answered", {
    scope: count.kind,
    target,
    books: searched,
    hits: count.byBook.length,
  });
  ctx.emitAnswer(lines.join("\n"), { reason: "books_mentioning", scope: count.kind });
  ctx.sendSources(count.sources);
  return true;
}
