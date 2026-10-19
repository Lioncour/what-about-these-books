import type { ChatMessage } from "@/lib/chat/types";
import {
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
