import { logChatEvent } from "@/lib/chat-debug";
import { FIRST_WAVE_SPECIALIST_BOOKS, MAX_SPECIALIST_CALLS_PER_REQUEST } from "@/lib/chat/constants";
import { isDryRun } from "@/lib/chat/request-context";
import { wantsMultipleBooks, type BookRef } from "@/lib/chat/specialist-limits";
import type { ChatContext } from "@/lib/chat/context";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { looksLikeThinAnswer, orchestrateSpecialists } from "@/lib/chat/orchestrator";
import { listTitles, readingStatus } from "@/lib/chat/presence";
import type { SpecialistSelection } from "@/lib/chat/scope";
import {
  askBookSpecialist,
  keepSpecialistAnswer,
  reaskBookSpecialist,
  toSpecialistReports,
  type SpecialistRequest,
  type SpecialistResult,
} from "@/lib/chat/specialist";
import type { SpecialistAnswer } from "@/lib/chat/types";
import type { ChatSource } from "@/lib/chat/types";

/** Nothing solid came back: every librarian unsure, or hardly a finding between them. */
function cameBackThin(answers: SpecialistAnswer[]): boolean {
  const findings = answers.reduce((n, a) => n + a.findings.length, 0);
  return findings < 2 || answers.every((a) => a.confidence === "low");
}

/**
 * Open questions: one specialist per chosen book reads its passages and reports JSON
 * findings; the orchestrator merges the reports into the streamed answer.
 *
 * An open library question (no book named, picked or in focus, and not asking for
 * breadth) asks the closest few books first and reads the rest of the selection only
 * when those come back thin. Most questions are answered by the closest books, and
 * every librarian is a full Claude call.
 *
 * A librarian that found nothing in a book that had passages may read once more, with
 * more passages. That is decided last: thinness is judged on the first answers, the
 * selection is widened if needed, and only then do the still-empty librarians re-ask,
 * closest book first, while the request stays within MAX_SPECIALIST_CALLS_PER_REQUEST.
 */
export async function specialistsStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.quoteMode) return false;

  const { scope, settings } = ctx;
  const copy = scope.text.specialists;
  if (copy.roster) ctx.status(copy.roster);
  ctx.checkpoint();
  // A follow-up ("What does he call Joe?") is read with the question it follows.
  const reading = ctx.readingQuestion;
  const full = await scope.selectSpecialistBooks(reading);
  const inWaves =
    scope.kind === "all" &&
    !scope.picked &&
    full.reason === "semantic" &&
    full.books.length > FIRST_WAVE_SPECIALIST_BOOKS &&
    !wantsMultipleBooks(ctx.question);
  if (reading !== ctx.question) logChatEvent("follow_up_context_added", { question: ctx.question.slice(0, 160) });
  const later = inWaves ? full.books.slice(FIRST_WAVE_SPECIALIST_BOOKS) : [];
  const selection: SpecialistSelection = inWaves
    ? { ...full, books: full.books.slice(0, FIRST_WAVE_SPECIALIST_BOOKS) }
    : full;
  const books = selection.books;
  if (!books.length) {
    // An empty library is an error; a series without books falls through to plain retrieval.
    if (scope.kind !== "all") return false;
    ctx.error("No books available for specialist analysis.");
    return true;
  }

  const titlesOf = (list: BookRef[]) => list.map((b) => cleanBookDisplayTitle(b.title));
  ctx.announceScope(books, selection.reason);
  ctx.status(readingStatus(titlesOf(books)));
  logChatEvent("specialist_books_selected", {
    scope: scope.kind,
    named: selection.namedBooks.map((b) => b.title),
    chosen: books.map((b) => b.title),
  });

  ctx.checkpoint();
  const requestFor = (b: BookRef): SpecialistRequest => ({
    bookId: b.id,
    bookTitle: b.title,
    userQuestion: reading,
    modelId: settings.specialistModelId,
    signal: ctx.signal,
    seedPassages: selection.seedByTitle.get(b.title),
  });
  const asked: Array<{ request: SpecialistRequest; result: SpecialistResult }> = [];
  const askAll = async (list: BookRef[]) => {
    const requests = list.map(requestFor);
    const results = await Promise.all(requests.map((r) => askBookSpecialist(r)));
    results.forEach((result, i) => asked.push({ request: requests[i], result }));
  };
  const callsSoFar = () => asked.reduce((n, a) => n + a.result.calls, 0);

  await askAll(books);
  ctx.checkpoint();
  // A dry run has no answers to judge, so it plans the usual case: the first wave only.
  if (later.length && !isDryRun() && cameBackThin(asked.map((a) => a.result))) {
    logChatEvent("specialists_widened", { first: books.length, more: later.length });
    ctx.status(`Not much there — also reading ${listTitles(titlesOf(later))}`);
    ctx.widenScope([...books, ...later], full.reason);
    await askAll(later);
    ctx.checkpoint();
  }

  // Second reads for the librarians that are still empty, as far as the call budget goes.
  let budget = Math.max(0, MAX_SPECIALIST_CALLS_PER_REQUEST - callsSoFar());
  const reasked = asked.filter((a) => a.result.canReask && budget-- > 0);
  if (reasked.length) logChatEvent("specialists_reasked", { count: reasked.length, callsBefore: callsSoFar() });
  await Promise.all(
    asked.map(async (a) => {
      if (!a.result.canReask) return;
      a.result = reasked.includes(a)
        ? await reaskBookSpecialist(a.request, a.result)
        : keepSpecialistAnswer(a.request, a.result);
    })
  );
  ctx.checkpoint();
  const results = asked.map((a) => a.result);
  // The orchestrator gets the librarians' notes, not the bookkeeping around them.
  const answers: SpecialistAnswer[] = results.map((r) => ({
    bookTitle: r.bookTitle,
    confidence: r.confidence,
    directAnswer: r.directAnswer,
    numericEstimate: r.numericEstimate,
    findings: r.findings,
    caveats: r.caveats,
  }));
  logChatEvent("specialists_completed", {
    scope: scope.kind,
    count: answers.length,
    calls: callsSoFar(),
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
  ctx.send("SPECIALISTS", JSON.stringify(toSpecialistReports(results)));
  // The answer goes out as TOKEN lines while the orchestrator streams.
  const finalText = await orchestrateSpecialists(
    reading,
    answers,
    settings.orchestratorModelId,
    settings.personality(),
    {
      companionMode: settings.companionMode,
      onToken: ctx.emitToken,
      continuityHint: ctx.continuityHint,
      signal: ctx.signal,
      coverage: {
        reason: full.reason,
        read: titlesOf(asked.map((a) => ({ id: a.request.bookId, title: a.request.bookTitle }))),
        total: scope.books.length,
        seriesName: scope.series?.name,
      },
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
