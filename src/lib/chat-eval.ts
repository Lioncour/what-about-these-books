import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { listBooks, listSeries } from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { runChatInProcess } from "@/lib/chat/handler";
import { DRY_RUN_TEXT } from "@/lib/chat/request-context";
import { decodeStreamLine } from "@/lib/chat/stream-protocol";
import type { ChatMessage } from "@/lib/chat/types";

/**
 * Chat eval: gold questions run through the real pipeline, checked for the route taken,
 * the books read, what it cost and (where the answer is real) what it says.
 *
 * Dry run (default): Claude calls are counted, not made. Routes, scope, exact counts,
 * quote and passage lookups are real; generated answers are placeholders, so their
 * text checks are skipped. Live: everything is real and every check applies.
 */

export interface ChatEvalCase {
  id: string;
  question: string;
  /** The conversation before the question (a follow-up case), oldest first. */
  history?: ChatMessage[];
  /** Why this case exists (the bug or behaviour it pins). */
  note?: string;
  /** Scope by display title, so the file doesn't depend on book ids. Default: whole library. */
  focus?: string;
  series?: string;
  books?: string[];
  expect: ChatEvalExpectation;
}

export interface ChatEvalExpectation {
  route?: string;
  routeNot?: string[];
  scopeReason?: string;
  /** The answer is drawn from exactly these books (display titles). */
  scopeBooks?: string[];
  /** …or at least these. */
  scopeIncludes?: string[];
  /** …and none of these. */
  scopeExcludes?: string[];
  minClaudeCalls?: number;
  maxClaudeCalls?: number;
  /** Substrings of the answer, case-insensitive. Checked only when the answer is real. */
  textIncludes?: string[];
  textExcludes?: string[];
  /**
   * Facts with several valid spellings: of each inner list at least one must appear
   * (`[["Adams", "Margaret"], ["sergeant", "gunny"]]`). Same rules as `textIncludes`.
   */
  textIncludesAny?: string[][];
  /**
   * Whether the router model is consulted (a question no rule claims but that looks like
   * a job for a tool). In a dry run the call is planned, not made, so the route stays
   * `open_rag` and the `route` check waits for a live run.
   */
  routerAsked?: boolean;
  /** Substrings of "Book · position" of some source. */
  sourcesInclude?: string[];
  minSources?: number;
}

export interface ChatEvalObserved {
  route: string | null;
  /** The router model was asked for the route (live) or would have been (dry). */
  routerAsked: boolean;
  scopeReason: string | null;
  scopeBooks: string[];
  scopeMore: number;
  claudeCalls: number;
  embedCalls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  text: string;
  /** False when the text is a dry-run placeholder (a Claude call wrote it). */
  textIsReal: boolean;
  sources: string[];
  error: string | null;
}

export interface ChatEvalResult {
  id: string;
  question: string;
  note?: string;
  passed: boolean;
  failures: string[];
  /** Checks not applied in this mode (text of a generated answer in a dry run). */
  skipped: string[];
  observed: ChatEvalObserved;
}

export interface ChatEvalReport {
  mode: "dry" | "live";
  total: number;
  passed: number;
  failed: number;
  claudeCalls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  results: ChatEvalResult[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const sameTitle = (a: string, b: string) => norm(a) === norm(b);

/** Compare what happened with what the case expects. Pure. */
export function checkChatCase(
  expect: ChatEvalExpectation,
  observed: ChatEvalObserved
): { failures: string[]; skipped: string[] } {
  const failures: string[] = [];
  const skipped: string[] = [];

  if (observed.error) failures.push(`error: ${observed.error}`);

  // A dry run plans the router model's call without making it: the route it would pick
  // (and everything that follows from it) is only known live.
  const routePending = observed.routerAsked && !observed.textIsReal && observed.route === "open_rag";
  if (expect.routerAsked !== undefined && observed.routerAsked !== expect.routerAsked) {
    failures.push(`router model: expected ${expect.routerAsked ? "to be asked" : "not to be asked"}`);
  }
  if (expect.route && observed.route !== expect.route) {
    if (routePending && expect.routerAsked) skipped.push(`route ${expect.route} (the router model decides; run live)`);
    else failures.push(`route: expected ${expect.route}, got ${observed.route ?? "none"}`);
  }
  for (const not of expect.routeNot || []) {
    if (observed.route === not) failures.push(`route: must not be ${not}`);
  }
  // What depends on the route the model picks waits for a live run too.
  const pending = routePending && expect.routerAsked === true && !!expect.route && expect.route !== "open_rag";

  if (pending) {
    const waiting = [
      expect.scopeReason || expect.scopeBooks || expect.scopeIncludes || expect.scopeExcludes ? "scope" : "",
      expect.minClaudeCalls !== undefined || expect.maxClaudeCalls !== undefined ? "Claude calls" : "",
      expect.sourcesInclude || expect.minSources !== undefined ? "sources" : "",
    ].filter(Boolean);
    if (waiting.length) skipped.push(`${waiting.join(", ")} (follow from the route; run live)`);
  }
  const followsRoute = !pending;

  if (followsRoute && expect.scopeReason && observed.scopeReason !== expect.scopeReason) {
    failures.push(`scope reason: expected ${expect.scopeReason}, got ${observed.scopeReason ?? "none"}`);
  }
  if (followsRoute && expect.scopeBooks) {
    const want = expect.scopeBooks;
    const got = observed.scopeBooks;
    const same =
      observed.scopeMore === 0 &&
      want.length === got.length &&
      want.every((w) => got.some((g) => sameTitle(g, w)));
    if (!same) {
      const more = observed.scopeMore ? ` +${observed.scopeMore}` : "";
      failures.push(`scope: expected [${want.join(", ")}], got [${got.join(", ")}]${more}`);
    }
  }
  for (const title of followsRoute ? expect.scopeIncludes || [] : []) {
    if (!observed.scopeBooks.some((g) => sameTitle(g, title))) failures.push(`scope: missing ${title}`);
  }
  for (const title of followsRoute ? expect.scopeExcludes || [] : []) {
    if (observed.scopeBooks.some((g) => sameTitle(g, title))) failures.push(`scope: should not read ${title}`);
  }

  if (followsRoute && expect.minClaudeCalls !== undefined && observed.claudeCalls < expect.minClaudeCalls) {
    failures.push(`Claude calls: expected at least ${expect.minClaudeCalls}, got ${observed.claudeCalls}`);
  }
  if (followsRoute && expect.maxClaudeCalls !== undefined && observed.claudeCalls > expect.maxClaudeCalls) {
    failures.push(`Claude calls: expected at most ${expect.maxClaudeCalls}, got ${observed.claudeCalls}`);
  }

  const textChecks =
    (expect.textIncludes?.length || 0) + (expect.textExcludes?.length || 0) + (expect.textIncludesAny?.length || 0);
  if (textChecks > 0) {
    if (!observed.textIsReal || pending) {
      skipped.push(`${textChecks} text check${textChecks === 1 ? "" : "s"} (generated answer; run live)`);
    } else {
      const text = norm(observed.text);
      for (const needle of expect.textIncludes || []) {
        if (!text.includes(norm(needle))) failures.push(`text: missing "${needle}"`);
      }
      for (const needle of expect.textExcludes || []) {
        if (text.includes(norm(needle))) failures.push(`text: should not say "${needle}"`);
      }
      for (const anyOf of expect.textIncludesAny || []) {
        const options = Array.isArray(anyOf) ? anyOf : [String(anyOf)];
        if (!options.some((needle) => text.includes(norm(needle)))) {
          failures.push(`text: missing any of ${options.map((o) => `"${o}"`).join(" / ")}`);
        }
      }
    }
  }

  for (const needle of followsRoute ? expect.sourcesInclude || [] : []) {
    if (!observed.sources.some((s) => norm(s).includes(norm(needle)))) {
      failures.push(`sources: none matches "${needle}"`);
    }
  }
  if (followsRoute && expect.minSources !== undefined && observed.sources.length < expect.minSources) {
    failures.push(`sources: expected at least ${expect.minSources}, got ${observed.sources.length}`);
  }

  return { failures, skipped };
}

/** Turn the pipeline's stream lines into the facts the checks look at. Pure. */
export function observeChat(lines: string[], route: string | null, routerAsked = false): ChatEvalObserved {
  const observed: ChatEvalObserved = {
    route,
    routerAsked,
    scopeReason: null,
    scopeBooks: [],
    scopeMore: 0,
    claudeCalls: 0,
    embedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
    text: "",
    textIsReal: true,
    sources: [],
    error: null,
  };
  let text = "";
  let tokens = "";
  for (const raw of lines) {
    const line = decodeStreamLine(raw);
    if (!line) continue;
    const json = <T,>(): T | null => {
      try {
        return JSON.parse(line.data) as T;
      } catch {
        return null;
      }
    };
    if (line.type === "TEXT") text = line.data;
    else if (line.type === "TOKEN") tokens += line.data;
    else if (line.type === "ERROR") observed.error = line.data;
    else if (line.type === "SCOPE") {
      const scope = json<{ books?: Array<{ title?: string }>; reason?: string; more?: number }>();
      if (scope) {
        observed.scopeReason = scope.reason ?? null;
        observed.scopeBooks = (scope.books || []).map((b) => String(b.title || ""));
        observed.scopeMore = Number(scope.more) || 0;
      }
    } else if (line.type === "USAGE") {
      const usage = json<Partial<ChatEvalObserved>>();
      if (usage) {
        observed.claudeCalls = Number(usage.claudeCalls) || 0;
        observed.embedCalls = Number(usage.embedCalls) || 0;
        observed.inputTokens = Number(usage.inputTokens) || 0;
        observed.outputTokens = Number(usage.outputTokens) || 0;
        observed.ms = Number(usage.ms) || 0;
      }
    } else if (line.type === "SOURCES") {
      const sources = json<Array<{ book?: string; position?: string }>>();
      if (sources) observed.sources = sources.map((s) => `${s.book || ""} · ${s.position || ""}`);
    }
  }
  // A streamed answer replaces nothing; a TEXT line is the whole answer.
  observed.text = text || tokens;
  observed.textIsReal = !observed.text.includes(DRY_RUN_TEXT);
  return observed;
}

function loadChatEvalCases(): ChatEvalCase[] {
  const file = join(process.cwd(), "eval", "chat-cases.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("eval/chat-cases.json must be an array of cases");
  return parsed as ChatEvalCase[];
}

/** The case's scope as the chat endpoint takes it; throws when a title isn't in the library. */
function resolveCaseScope(testCase: ChatEvalCase): { bookId: string; bookTitle: string; bookIds?: string[] } {
  const books = listBooks();
  const byTitle = (title: string) => {
    const hit = books.find((b) => sameTitle(cleanBookDisplayTitle(b.title), title) || sameTitle(b.title, title));
    if (!hit) throw new Error(`no book titled "${title}" in the library`);
    return hit;
  };
  if (testCase.books?.length) {
    return { bookId: "all", bookTitle: "All Books", bookIds: testCase.books.map((t) => byTitle(t).id) };
  }
  if (testCase.focus) {
    const book = byTitle(testCase.focus);
    return { bookId: book.id, bookTitle: book.title };
  }
  if (testCase.series) {
    const series = listSeries().find((s) => sameTitle(s.name, testCase.series!));
    if (!series) throw new Error(`no series named "${testCase.series}" in the library`);
    return { bookId: `series:${series.id}`, bookTitle: series.name };
  }
  return { bookId: "all", bookTitle: "All Books" };
}

/** The case's earlier turns as chat messages; throws when one is malformed. */
export function caseHistory(testCase: Pick<ChatEvalCase, "history">): ChatMessage[] {
  if (testCase.history === undefined) return [];
  if (!Array.isArray(testCase.history)) throw new Error('"history" must be a list of { role, content } turns');
  return testCase.history.map((turn, i) => {
    const role = (turn as Partial<ChatMessage> | null)?.role;
    const content = (turn as Partial<ChatMessage> | null)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
      throw new Error(`history[${i}] needs a role ("user" or "assistant") and a content string`);
    }
    return { role, content };
  });
}

export async function runChatEval(opts: { live?: boolean; ids?: string[] } = {}): Promise<ChatEvalReport> {
  const all = loadChatEvalCases();
  const cases = opts.ids?.length ? all.filter((c) => opts.ids!.includes(c.id)) : all;
  const results: ChatEvalResult[] = [];

  // One at a time: answers are compared for cost, and parallel runs would share caches.
  for (const testCase of cases) {
    let observed: ChatEvalObserved;
    try {
      const scope = resolveCaseScope(testCase);
      const run = await runChatInProcess(
        { ...scope, messages: caseHistory(testCase), question: testCase.question },
        { dryRun: !opts.live }
      );
      observed = observeChat(run.lines, run.route?.kind ?? null, run.routerAsked);
    } catch (error) {
      observed = { ...observeChat([], null), error: error instanceof Error ? error.message : String(error) };
    }
    const { failures, skipped } = checkChatCase(testCase.expect || {}, observed);
    results.push({
      id: testCase.id,
      question: testCase.question,
      note: testCase.note,
      passed: failures.length === 0,
      failures,
      skipped,
      observed: { ...observed, text: observed.text.slice(0, 600) },
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const sum = (pick: (o: ChatEvalObserved) => number) => results.reduce((n, r) => n + pick(r.observed), 0);
  return {
    mode: opts.live ? "live" : "dry",
    total: results.length,
    passed,
    failed: results.length - passed,
    claudeCalls: sum((o) => o.claudeCalls),
    inputTokens: sum((o) => o.inputTokens),
    outputTokens: sum((o) => o.outputTokens),
    ms: sum((o) => o.ms),
    results,
  };
}
