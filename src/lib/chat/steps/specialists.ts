import { logChatEvent } from "@/lib/chat-debug";
import { assignLibrarianNames } from "@/lib/chat/constants";
import type { ChatContext } from "@/lib/chat/context";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { looksLikeThinAnswer, orchestrateSpecialists } from "@/lib/chat/orchestrator";
import type { SpecialistSelection } from "@/lib/chat/scope";
import { askBookSpecialist, toSpecialistReports } from "@/lib/chat/specialist";
import type { ChatSource } from "@/lib/chat/types";

/** Books the question names come first (or alone); say which ones are being read. */
function readingStatus(selection: SpecialistSelection): string {
  const namedIds = new Set(selection.namedBooks.map((b) => b.id));
  const titles = (named: boolean) =>
    selection.books.filter((b) => namedIds.has(b.id) === named).map((b) => cleanBookDisplayTitle(b.title));
  const named = titles(true);
  const others = titles(false);
  return named.length
    ? `Reading ${named.join(", ")} (named in your question)${others.length ? `, then ${others.join(", ")}` : ""}`
    : `Reading: ${others.join(", ")}`;
}

/**
 * Open questions: one specialist per chosen book reads its passages and reports JSON
 * findings; the orchestrator merges the reports into the streamed answer.
 */
export async function specialistsStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.quoteMode) return false;

  const { scope, settings } = ctx;
  const copy = scope.text.specialists;
  if (copy.roster) ctx.status(copy.roster);
  ctx.checkpoint();
  const selection = await scope.selectSpecialistBooks(ctx.question);
  const books = selection.books;
  if (!books.length) {
    // An empty library is an error; a series without books falls through to plain retrieval.
    if (scope.kind !== "all") return false;
    ctx.error("No books available for specialist analysis.");
    return true;
  }

  ctx.announceScope(books, selection.reason);
  if (scope.kind !== "book") ctx.status(readingStatus(selection));
  logChatEvent("specialist_books_selected", {
    scope: scope.kind,
    named: selection.namedBooks.map((b) => b.title),
    chosen: books.map((b) => b.title),
  });
  const librarians = assignLibrarianNames(books.map((b) => b.id));
  const roster = books
    .slice(0, 4)
    .map((b) => `Librarian ${librarians.get(b.id)}`)
    .join(", ");
  ctx.status(copy.consulting(books.length, roster));

  ctx.checkpoint();
  const answers = await Promise.all(
    books.map((b) =>
      askBookSpecialist({
        bookId: b.id,
        bookTitle: b.title,
        userQuestion: ctx.question,
        modelId: settings.specialistModelId,
        signal: ctx.signal,
        seedPassages: selection.seedByTitle.get(b.title),
      })
    )
  );
  ctx.checkpoint();
  logChatEvent("specialists_completed", {
    scope: scope.kind,
    count: answers.length,
    lowConfidence: answers.filter((s) => s.confidence === "low").length,
  });

  const perBook = scope.kind === "book" ? 10 : 6;
  const sources: ChatSource[] = answers.flatMap((answer) =>
    answer.findings.slice(0, perBook).map((finding) => ({
      book: answer.bookTitle,
      excerpt: finding.evidence || finding.finding,
      position: finding.location,
    }))
  );

  ctx.status(copy.merging);
  ctx.send("SPECIALISTS", JSON.stringify(toSpecialistReports(answers)));
  // The answer goes out as TOKEN lines while the orchestrator streams.
  const finalText = await orchestrateSpecialists(
    ctx.question,
    answers,
    settings.orchestratorModelId,
    settings.personality(),
    {
      companionMode: settings.companionMode,
      onToken: ctx.emitToken,
      continuityHint: ctx.continuityHint,
      signal: ctx.signal,
    }
  );
  logChatEvent("chat_answer_emitted", {
    bookId: ctx.bookId,
    chars: finalText.length,
    thin: looksLikeThinAnswer(finalText),
    reason: "orchestrated_specialists",
    scope: scope.kind,
    usedSpecialists: true,
    streamed: true,
  });
  ctx.sendSources(sources);
  return true;
}
