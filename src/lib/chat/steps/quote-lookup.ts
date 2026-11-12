import type { ChatContext } from "@/lib/chat/context";
import { matchToSource, type ScopedMatch } from "@/lib/chat/scope";

function formatMatches(heading: string, matches: ScopedMatch[], singleBook: boolean): string {
  if (singleBook) {
    return [heading, "", `Found **${matches.length}** matches.`, ...matches.map((m) => `- **${m.label}**: ${m.snippet}`)].join(
      "\n"
    );
  }
  const byBook = new Map<string, ScopedMatch[]>();
  for (const m of matches) byBook.set(m.bookTitle, [...(byBook.get(m.bookTitle) || []), m]);
  const lines = [heading, "", `Found **${matches.length}** matches across **${byBook.size}** book(s).`];
  for (const [title, entries] of byBook) {
    lines.push("", `### ${title}`);
    for (const entry of entries) lines.push(`- **${entry.label}**: ${entry.snippet}`);
  }
  return lines.join("\n");
}

/** A quoted line: exact lookup in the stored text. A miss falls through to retrieval. */
export function quoteLookupStep(ctx: ChatContext): boolean {
  if (!ctx.quoteMode) return false;

  const { scope } = ctx;
  const copy = scope.text.quote;
  ctx.status(copy.status);
  const matches = scope.exactQuote(ctx.quoteMode);
  if (!matches.length) {
    ctx.status(copy.miss);
    return false;
  }
  ctx.status(`Exact quote matches found: ${matches.length}`);
  ctx.announceScope();
  ctx.emitAnswer(formatMatches(copy.heading, matches, scope.kind === "book"), {
    reason: "exact_quote",
    scope: scope.kind,
  });
  ctx.sendSources(matches.map(matchToSource));
  return true;
}
