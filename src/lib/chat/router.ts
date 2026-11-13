import type { ChatMessage } from "@/lib/chat/types";
import {
  extractBooksMentioningTarget,
  extractWhoIsTarget,
  looksLikeHaveYouReadQuestion,
  looksLikeLibraryCountQuestion,
  looksLikeMainCharacterQuestion,
  looksLikeMentionCountQuestion,
  looksLikePassageFindQuestion,
  looksLikeQuoteLookup,
  looksLikeThemeSurveyQuestion,
  normalizeUserQuestion,
  resolveCountTarget,
  shouldBypassSpecialists,
  shouldUseExactMentionCount,
} from "@/lib/chat/intent";
import { looksLikePopCultureSurvey } from "@/lib/chat/theme-survey";

/**
 * Single place that decides *how* to answer before we spend Claude tokens.
 * Deterministic tools first; open_rag falls through to specialists / RAG.
 */
export type ChatRouteKind =
  | "mention_count"
  | "books_mentioning"
  | "passage_find"
  | "theme_pop_culture"
  | "quote_lookup"
  | "have_you_read"
  | "library_count"
  | "main_characters"
  | "who_is"
  | "bypass_general"
  | "entity_graph"
  | "timeline_conflicts"
  | "open_rag";

export type ChatRoute = {
  kind: ChatRouteKind;
  /** For mention_count / who_is */
  target?: string | null;
  /** Why this route won — for logs / Why panel */
  reason: string;
  /** Prefer tools over LLM when true */
  usesTool: boolean;
};

function looksLikeEntityGraph(question: string): boolean {
  return /\b(entity graph|relationship map|who is connected|character graph)\b/i.test(question);
}

function looksLikeTimelineConflicts(question: string): boolean {
  return /\b(timeline conflict|contradictions?|inconsistenc(?:y|ies)|continuity error)\b/i.test(
    question
  );
}

export function routeChatQuestion(opts: {
  question: string;
  messages: ChatMessage[];
  answerMode?: string;
}): ChatRoute {
  const question = normalizeUserQuestion(opts.question);
  const answerMode = opts.answerMode;

  // Exact mention counts — never specialist estimates
  if (shouldUseExactMentionCount(question, answerMode) || looksLikeMentionCountQuestion(question)) {
    const target = resolveCountTarget(question, opts.messages);
    return {
      kind: "mention_count",
      target,
      reason: target
        ? `Exact count for "${target}"`
        : "Count question without a clear target",
      usesTool: true,
    };
  }

  // "Which books mention X?" — a per-book exact lookup, no reading needed
  const mentioned = extractBooksMentioningTarget(question);
  if (mentioned) {
    return {
      kind: "books_mentioning",
      target: mentioned,
      reason: `Which books mention "${mentioned}"`,
      usesTool: true,
    };
  }

  // Concrete find (recipe / passage / scene)
  if (looksLikePassageFindQuestion(question)) {
    return {
      kind: "passage_find",
      reason: "Find a specific passage or recipe",
      usesTool: true,
    };
  }

  // Broad theme surveys (pop culture, etc.)
  if (looksLikeThemeSurveyQuestion(question) && looksLikePopCultureSurvey(question)) {
    return {
      kind: "theme_pop_culture",
      reason: "Survey pop-culture references across books",
      usesTool: true,
    };
  }

  if (looksLikeQuoteLookup(question)) {
    return {
      kind: "quote_lookup",
      reason: "Locate a quoted passage",
      usesTool: true,
    };
  }

  if (looksLikeHaveYouReadQuestion(question)) {
    return {
      kind: "have_you_read",
      reason: "Library coverage question",
      usesTool: true,
    };
  }

  if (looksLikeLibraryCountQuestion(question)) {
    return {
      kind: "library_count",
      reason: "How many books in the library",
      usesTool: true,
    };
  }

  if (looksLikeMainCharacterQuestion(question)) {
    return {
      kind: "main_characters",
      reason: "Main character derivation",
      usesTool: true,
    };
  }

  const who = extractWhoIsTarget(question);
  if (who) {
    return {
      kind: "who_is",
      target: who,
      reason: `Who-is lookup for "${who}"`,
      usesTool: true,
    };
  }

  if (looksLikeEntityGraph(question)) {
    return {
      kind: "entity_graph",
      reason: "Entity graph query",
      usesTool: true,
    };
  }

  if (looksLikeTimelineConflicts(question)) {
    return {
      kind: "timeline_conflicts",
      reason: "Timeline / continuity check",
      usesTool: true,
    };
  }

  if (shouldBypassSpecialists(question)) {
    return {
      kind: "bypass_general",
      reason: "General / greeting — skip specialists",
      usesTool: false,
    };
  }

  // "and Joe?" right after a count: the same exact count for another name. Checked last,
  // so a greeting or a real question after a count is never taken for a name.
  const followUp = resolveCountTarget(question, opts.messages);
  if (followUp) {
    return {
      kind: "mention_count",
      target: followUp,
      reason: `Count follow-up for "${followUp}"`,
      usesTool: true,
    };
  }

  return {
    kind: "open_rag",
    reason: "Open question — specialists / RAG",
    usesTool: false,
  };
}

/** Short label for status / UI. */
export function describeRoute(route: ChatRoute): string {
  switch (route.kind) {
    case "mention_count":
      return route.target ? `Counting mentions of ${route.target}…` : "Figuring out who to count…";
    case "books_mentioning":
      return `Checking which books mention ${route.target}…`;
    case "passage_find":
      return "Searching for the best matching passages…";
    case "theme_pop_culture":
      return "Scanning for movie, TV, and book shout-outs…";
    case "quote_lookup":
      return "Looking up that quote…";
    case "have_you_read":
      return "Checking what I’ve read…";
    case "library_count":
      return "Counting your books…";
    case "main_characters":
      return "Finding who matters most…";
    case "who_is":
      return route.target ? `Looking up ${route.target}…` : "Looking someone up…";
    case "entity_graph":
      return "Checking the character graph…";
    case "timeline_conflicts":
      return "Checking for continuity clashes…";
    case "bypass_general":
      return "Answering directly…";
    default:
      return "Figuring out the best way to answer…";
  }
}

/* ───────────── model fallback: when no rule claims an ambiguous question ───────────── */

/** The tool routes the router model may pick; anything else keeps `open_rag`. */
export const MODEL_ROUTES = [
  "mention_count",
  "books_mentioning",
  "quote_lookup",
  "passage_find",
  "who_is",
  "main_characters",
  "open_rag",
] as const;
export type ModelRoute = (typeof MODEL_ROUTES)[number];

/** Routes that are nothing without a target taken from the question. */
const TARGET_ROUTES = new Set<ModelRoute>(["mention_count", "books_mentioning", "quote_lookup", "who_is"]);

export const ROUTER_MAX_TOKENS = 60;
export const ROUTER_TIMEOUT_MS = 4000;
/** "Asking something short": at most this many words. */
const SHORT_QUESTION_WORDS = 4;

const COUNT_WORD_RE =
  /\b(?:how (?:many|often|much|frequently)|number of|count(?:s|ed|ing)?|tally|total|times|frequency|frequent(?:ly)?|occurrences?)\b/i;
const QUOTE_MARK_RE = /["“”«»]|(?:^|\s)['‘][^'’]{3,}['’](?=$|[\s?.!,])/;
const WHICH_BOOK_RE = /\b(?:which|what) (?:book|books|novel|novels|volume|volumes)\b/i;
const WHERE_RE = /\bwhere\b/i;
const LIST_RE = /\blist\b/i;

/**
 * Why an `open_rag` question might still be a job for a tool, or null when it isn't
 * ambiguous: it has a count word, a quote mark, "which book(s)", "where" or "list", or
 * it is short and names something from the entity graph. Cheap, no I/O beyond the
 * `isKnownName` callback, which is only asked for short questions.
 */
export function routerFallbackReason(question: string, isKnownName?: (name: string) => boolean): string | null {
  const q = normalizeUserQuestion(question);
  if (!q.trim()) return null;
  if (COUNT_WORD_RE.test(q)) return "count word";
  if (QUOTE_MARK_RE.test(q)) return "quote mark";
  if (WHICH_BOOK_RE.test(q)) return "which book";
  if (WHERE_RE.test(q)) return "where";
  if (LIST_RE.test(q)) return "list";
  const words = q.trim().split(/\s+/);
  if (isKnownName && words.length <= SHORT_QUESTION_WORDS) {
    const names = q.match(/\b[A-Z][\w’'-]+(?:\s+[A-Z][\w’'-]+){0,2}/g) || [];
    for (const name of names) {
      const forms = [name, ...name.split(/\s+/)].map((n) => n.replace(/[’']s$/i, ""));
      if (forms.some((n) => n.length > 2 && isKnownName(n))) return "short question about a known name";
    }
  }
  return null;
}

export function buildRouterPrompt(question: string): string {
  return `You route one question about a reader's own book library to the tool that answers it best.
Reply with ONE line of JSON and nothing else: {"route": "<route>", "target": "<target or empty>"}

Routes:
- "mention_count": the reader wants a NUMBER of times a name or word occurs in the text. target = that name or word.
- "books_mentioning": the reader wants to know WHICH BOOKS contain a name or word. target = that name or word.
- "quote_lookup": the reader wants to know where an exact quoted line is from, or who said it. target = the quoted line, without the quote marks.
- "passage_find": the reader wants to be shown one specific passage, scene or recipe.
- "who_is": the reader only wants to know who or what a named character, group or place is. target = the name.
- "main_characters": the reader wants the main characters of the books.
- "open_rag": anything that needs reading and explaining: plot, motives, opinions, comparisons, "why", "how", what a quote means, how often something happens (as opposed to how often a word occurs). When in doubt, choose this.

The target must be copied from the question exactly as written there.

Question: ${JSON.stringify(question)}`;
}

/**
 * Strict: one JSON object with a known route; a target, where the route needs one, that
 * really stands in the question. Anything else is null and the question stays `open_rag`.
 */
export function parseRouterAnswer(raw: string, question: string): { route: ModelRoute; target: string | null } | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!text.startsWith("{") || !text.endsWith("}") || text.includes("\n")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { route, target } = parsed as { route?: unknown; target?: unknown };
  if (typeof route !== "string" || !(MODEL_ROUTES as readonly string[]).includes(route)) return null;
  if (target !== undefined && target !== null && typeof target !== "string") return null;
  const kind = route as ModelRoute;
  const squash = (s: string) => s.toLowerCase().replace(/[“”«»"]/g, "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const clean = typeof target === "string" ? target.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim() : "";
  if (!TARGET_ROUTES.has(kind)) return { route: kind, target: null };
  if (clean.length < 2 || clean.length > 200 || !squash(question).includes(squash(clean))) return null;
  return { route: kind, target: clean };
}

/** The route a valid router answer stands for. */
export function routeFromModel(answer: { route: ModelRoute; target: string | null }): ChatRoute {
  return {
    kind: answer.route,
    target: answer.target,
    reason: answer.route === "open_rag" ? "Router model: open question" : `Router model picked ${answer.route}`,
    usesTool: answer.route !== "open_rag",
  };
}

export interface RouterFallbackResult {
  route: ChatRoute;
  /** The model was asked (or, in a dry run, would have been). */
  asked: boolean;
  /** Why it was (not) asked, or what came of it: for the log. */
  outcome: string;
}

/**
 * Ask the cheap librarian model to pick a route for a question no rule claimed. Only
 * for `open_rag` questions that `routerFallbackReason` finds ambiguous; one short call
 * (60 output tokens, 4 s). A timeout, an error or an answer that doesn't parse keeps
 * `open_rag`; only the reader's own Stop is passed on. In a dry run the call is counted
 * and not made, so the route stays `open_rag`.
 */
export async function resolveRouteWithModel(opts: {
  route: ChatRoute;
  question: string;
  isKnownName?: (name: string) => boolean;
  /** One model call: resolves to the raw answer. Gets a signal that also fires on timeout. */
  ask: (prompt: string, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<RouterFallbackResult> {
  const { route } = opts;
  if (route.kind !== "open_rag") return { route, asked: false, outcome: "rule_routed" };
  const why = routerFallbackReason(opts.question, opts.isKnownName);
  if (!why) return { route, asked: false, outcome: "not_ambiguous" };

  opts.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? ROUTER_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let raw: string;
  try {
    raw = await opts.ask(buildRouterPrompt(opts.question), signal);
  } catch (error) {
    // The reader pressed Stop: that ends the request. Everything else keeps open_rag.
    if (opts.signal?.aborted) throw error;
    const outcome = timeout.aborted ? "timeout" : "error";
    return { route, asked: true, outcome: `${why}: ${outcome}` };
  }
  if (opts.dryRun) return { route, asked: true, outcome: `${why}: planned (dry run)` };
  const answer = parseRouterAnswer(raw, opts.question);
  if (!answer) return { route, asked: true, outcome: `${why}: invalid answer` };
  if (answer.route === "open_rag") return { route, asked: true, outcome: `${why}: open_rag` };
  return { route: routeFromModel(answer), asked: true, outcome: `${why}: ${answer.route}` };
}
