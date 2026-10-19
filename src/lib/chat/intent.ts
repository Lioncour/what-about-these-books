import type { ChatMessage } from "@/lib/chat/types";

/** Fix common typos before intent matching. */
export function normalizeUserQuestion(input: string): string {
  return input
    // how many (and near-misses: ho many, how man, how mnay, hom many…)
    .replace(/\b(?:ho+|hwo|hwow?|hom)\s+(?:many|man|mnay|mny|meny)\b/gi, "how many")
    .replace(/\bhow\s+(?:man|mnay|mny|meny)\b/gi, "how many")
    // mentioned / mentions
    .replace(/\bmen+t+i+one?d\b/gi, "mentioned")
    .replace(/\bmen+t+i+ons\b/gi, "mentions")
    .replace(/\bmentiones\b/gi, "mentioned")
    .replace(/\bapperas?\b/gi, "appears")
    .replace(/\bfirts\b/gi, "first")
    .replace(/\bfirsts\b/gi, "first")
    .replace(/\s+/g, " ")
    .trim();
}

const MENTION_VERB =
  "(?:get\\s+|getting\\s+)?(?:mentioned|mentions?|appear(?:s|ed|ing)?|occurs?|used|said|named)";

export function extractQuotedText(input: string): string | null {
  const match = input.match(/["“”](.{20,}?)["“”]/);
  return match?.[1]?.trim() || null;
}

export function looksLikeQuoteLookup(input: string): boolean {
  const lower = input.toLowerCase();
  const hasQuote = /["“”'].{12,}["“”']/.test(input);
  return (
    hasQuote &&
    (lower.includes("find this quote") ||
      lower.includes("find quote") ||
      lower.includes("where is this quote") ||
      lower.includes("which book has") ||
      lower.includes("what chapter is"))
  );
}

export function isPronounTarget(value: string): boolean {
  return /^(he|she|they|him|her|them|it|this character|that character|this person|that person)$/i.test(
    value.trim()
  );
}

export function normalizeEntityTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^(and|about|for|of|is|was|are|were|does|do|did|the|a|an|word|name)\s+/i, "")
    .replace(
      /\s+(?:in|across|throughout|within)\s+(?:this|the|my|your|entire|whole|full)?\s*(?:book|books|library|series|novels?|texts?)(?:\b.*)?$/i,
      ""
    )
    .replace(/\s+(?:get|getting)$/i, "")
    .replace(/[?.,!;:]+$/g, "")
    .trim();
}

export function extractMentionCountTarget(input: string): string | null {
  const text = normalizeUserQuestion(input);
  const patterns = [
    new RegExp(
      `how\\s+many\\s+times(?:\\s+(?:is|was|are|were|does|do|did|can|has|have))?\\s+(?:the\\s+(?:name|word)\\s+)?["“”']?([^"“”'\\n]+?)["“”']?\\s+${MENTION_VERB}\\b`,
      "i"
    ),
    new RegExp(
      `how\\s+often(?:\\s+(?:is|does|do))?\\s+["“”']?([^"“”'\\n]+?)["“”']?\\s+(?:${MENTION_VERB}|show(?:s|ed)?\\s+up)\\b`,
      "i"
    ),
    /count(?:\s+the)?\s+(?:mentions?|occurrences?|times)\s+(?:of\s+)?["“”']?([^"“”'\n]+?)["“”']?(?:\b|$)/i,
    /how many\s+(?:mentions?|occurrences?)\s+of\s+["“”']?([^"“”'\n]+?)["“”']?(?:\b|$)/i,
    /(?:mentions?|occurrences?)\s+of\s+["“”']?([^"“”'\n]+?)["“”']?\s*(?:\?|$)/i,
  ];
  const m = patterns.map((p) => text.match(p)).find(Boolean);
  if (m?.[1]) {
    const value = normalizeEntityTarget(m[1]);
    return value.length >= 2 ? value : null;
  }

  // Fallback: name sitting between times/often and mention/appear
  if (
    /how\s+man+y?\s+times|how\s+often|count\b/i.test(text) &&
    /ment+i+one?d|appear|occurs?|used|named/i.test(text)
  ) {
    const between = text.match(
      /(?:times|often)\s+(?:is\s+|was\s+|are\s+|were\s+|does\s+|do\s+|the\s+(?:name|word)\s+)?["“”']?([A-Za-z][\w'-]{1,40})["“”']?\s+\w*ment/i
    );
    if (between?.[1] && !isPronounTarget(between[1])) {
      return normalizeEntityTarget(between[1]);
    }
    const proper = text.match(
      /(?:times|often|count|mentions?\s+of)\s+(?:is\s+|was\s+|are\s+|were\s+|does\s+|do\s+|the\s+(?:name|word)\s+)?["“”']?([A-Za-z][\w'-]{1,40})["“”']?/i
    );
    if (proper?.[1] && !isPronounTarget(proper[1])) {
      return normalizeEntityTarget(proper[1]);
    }
  }
  return null;
}

export type BookCountScope =
  | { kind: "all" }
  | { kind: "first_n"; n: number }
  | { kind: "range"; from: number; to: number };

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};

function parseNumberToken(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUMBERS[t] ?? null;
}

/** Parse "first 10 books", "10 first books", "books 1-10", "books 1 through 10". */
export function extractBookCountScope(input: string): BookCountScope {
  const text = normalizeUserQuestion(input);

  const firstN =
    text.match(/\b(?:the\s+)?first\s+(\d+|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+books?\b/i) ||
    text.match(/\b(?:the\s+)?(\d+|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+first\s+books?\b/i) ||
    text.match(/\bfirst\s+(\d+|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/i);
  if (firstN?.[1]) {
    const n = parseNumberToken(firstN[1]);
    if (n && n > 0 && n <= 50) return { kind: "first_n", n };
  }

  const range =
    text.match(/\bbooks?\s+(\d+)\s*(?:-|–|—|to|through|thru)\s*(\d+)\b/i) ||
    text.match(/\b(?:from\s+)?book\s+(\d+)\s*(?:-|–|—|to|through|thru)\s*(?:book\s+)?(\d+)\b/i);
  if (range?.[1] && range?.[2]) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from > 0 && to >= from && to <= 50) return { kind: "range", from, to };
  }

  return { kind: "all" };
}

/** Best-effort series order — delegates to series-order (known maps + Book N). */
export { extractSeriesBookNumber } from "@/lib/series-order";

export function extractCountFollowupCandidate(input: string): string | null {
  if (!isShortCountFollowup(input)) return null;
  const cleaned = normalizeEntityTarget(
    normalizeUserQuestion(input)
      .replace(/^(and|also|what about|how about)\s+/i, "")
      .replace(/\?+$/g, "")
  );
  if (!cleaned) return null;
  if (cleaned.split(/\s+/).length > 3) return null;
  if (/\b(how many|count|mentions?|times|appears?|occurs?|used|quote|chapter|page|find|recipe|receipt|book|books)\b/i.test(cleaned)) {
    return null;
  }
  if (!/^[A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2}$/.test(cleaned)) return null;
  return cleaned;
}

/** Short name-only follow-ups like "and Skippy?" after a count question — not full sentences. */
export function isShortCountFollowup(input: string): boolean {
  const text = normalizeUserQuestion(input).trim();
  if (!text || looksLikeMentionCountQuestion(text)) return false;
  if (/\b(find|recipe|receipt|reciept|where|locate|search|show me|can you|please|there is|is there)\b/i.test(text)) {
    return false;
  }
  const stripped = text
    .replace(/^(and|also|what about|how about)\s+/i, "")
    .replace(/\?+$/g, "")
    .trim();
  if (stripped.split(/\s+/).length > 3) return false;
  if (/^(there|this|that|can|could|find|show|where|what|please|is|are|the|a|an)\b/i.test(stripped)) {
    return false;
  }
  return /^[A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2}$/.test(stripped);
}

export function isCountFollowupContext(messages: ChatMessage[]): boolean {
  const recentUsers = messages
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.content.toLowerCase());
  return recentUsers.some((t) =>
    /((?:how|ho)\s+many\s+times|how often|count(?:\s+the)?\s+mentions?|how many mentions? of|mentioned)/i.test(t)
  );
}

export function looksLikeMentionCountQuestion(input: string): boolean {
  const text = normalizeUserQuestion(input).toLowerCase();
  if (
    /how\s+man+y?\s+times|how\s+often/i.test(text) &&
    /ment+i+one?d|appear|occurs?|used|show up|named/i.test(text)
  ) {
    return true;
  }
  if (/count(?:\s+the)?\s+(?:mentions?|occurrences?|times)/i.test(text)) return true;
  if (/how many\s+(?:mentions?|occurrences?)\s+of/i.test(text)) return true;
  return false;
}

/** True when the user wants a precise full-text tally (never specialist estimates). */
export function shouldUseExactMentionCount(input: string, answerMode?: string): boolean {
  if (looksLikeMentionCountQuestion(input)) return true;
  // Exact-count answer mode only applies to real count questions / short name follow-ups
  if (answerMode === "Exact count" && isShortCountFollowup(input)) return true;
  return false;
}

/** Find a specific recipe/quote/passage — not broad theme questions like "any pop culture?". */
export function looksLikePassageFindQuestion(input: string): boolean {
  const text = normalizeUserQuestion(input).toLowerCase();
  if (looksLikeMentionCountQuestion(text)) return false;

  // Theme / survey questions belong with specialists or theme search — not keyword dumps.
  if (
    /\b(any (?:references?|mentions?|examples?)|references? to|pop culture|themes?|tropes?|examples of)\b/i.test(
      text
    ) &&
    !/\b(recipe|receipt|reciept|cheeseburger|hamburger|find (?:this|the|that) (?:quote|passage))\b/i.test(
      text
    )
  ) {
    return false;
  }

  const wantsRecipe =
    /\b(recipe|receipt|reciept|recipie|cheeseburger|hamburger|ingredient)\b/i.test(text) &&
    /\b(find|is there|there is|where|locate|show|can you find)\b/i.test(text);
  if (wantsRecipe) return true;

  if (
    looksLikeQuoteLookup(text) ||
    (/\b(find|where is|locate)\b/i.test(text) && /\b(quote|passage|scene)\b/i.test(text))
  ) {
    return true;
  }

  // Concrete "find that for me" after naming a thing (recipe path already covered)
  if (
    /\b(can you find|find (?:me )?(?:the|that|this)|help me find|look(?:ing)? up)\b/i.test(text) &&
    /\b(recipe|receipt|quote|passage|scene|cheeseburger|hamburger)\b/i.test(text)
  ) {
    return true;
  }

  return false;
}

/** Broad “are there X / any references to Y” questions — not a single-passage lookup. */
export function looksLikeThemeSurveyQuestion(input: string): boolean {
  const text = normalizeUserQuestion(input).toLowerCase();
  if (looksLikePassageFindQuestion(text) || looksLikeMentionCountQuestion(text)) return false;
  return (
    /\b(any (?:references?|mentions?|examples?)|references? to|pop culture|themes?|tropes?|examples of)\b/i.test(
      text
    ) ||
    (/\bis there\b/i.test(text) &&
      /\b(references?|mentions?|examples?|pop culture|movies?|films?|tv|comics?)\b/i.test(text))
  );
}

/** Keywords to search for a passage-find question, with common typo expansions. */
export function extractPassageSearchTerms(input: string): string[] {
  const text = normalizeUserQuestion(input);
  const terms = new Set<string>();

  const add = (t: string) => {
    const v = t.trim().toLowerCase();
    if (v.length >= 3) terms.add(v);
  };

  // Typo / synonym expansions
  if (/\bcheeseburger|cheese\s*burger/i.test(text)) {
    add("cheeseburger");
    add("cheese burger");
    add("burger");
  }
  if (/\bhamburger/i.test(text)) {
    add("hamburger");
    add("burger");
  }
  if (/\brecipe|receipt|reciept|recipie|recipt/i.test(text)) {
    add("recipe");
    add("recipes");
  }

  // Quoted phrases
  const quoted = text.match(/["“”']([^"“”']{3,60})["“”']/);
  if (quoted?.[1]) add(quoted[1]);

  // Content words (drop filler)
  const stop = new Set([
    "there",
    "is",
    "a",
    "an",
    "the",
    "in",
    "of",
    "for",
    "me",
    "you",
    "can",
    "find",
    "that",
    "this",
    "please",
    "books",
    "book",
    "library",
    "series",
    "with",
    "and",
    "or",
    "to",
    "my",
    "your",
    "one",
    "some",
    "any",
    "about",
    "where",
    "what",
    "how",
    "show",
    "help",
    "looking",
    "look",
    "up",
    "search",
  ]);
  for (const raw of text.replace(/[^\w\s'-]/g, " ").split(/\s+/)) {
    const w = raw.toLowerCase();
    if (w.length < 4 || stop.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (/^rec(ie|ei|i)pt$/i.test(w) || /^recipie$/i.test(w)) continue; // covered by recipe expansion
    add(w);
  }

  return [...terms].slice(0, 12);
}

export function extractPotentialEntityFromText(text: string): string | null {
  const whoIs = text.match(/\bwho is\s+["“”']?([^"“”'?\n]+?)["“”']?(?:\?|$)/i)?.[1];
  if (whoIs && !isPronounTarget(whoIs)) return whoIs.trim();

  const mention = text.match(/\bmentions?\s+of\s+["“”']?([^"“”'\n]+?)["“”']?/i)?.[1];
  if (mention && !isPronounTarget(mention)) return mention.trim();

  const quoted = text.match(/["“”']([^"“”']{2,40})["“”']/)?.[1];
  if (quoted && !isPronounTarget(quoted)) return quoted.trim();

  const manyTimes = extractMentionCountTarget(text);
  if (manyTimes && !isPronounTarget(manyTimes)) return manyTimes.trim();

  return null;
}

export function resolveMentionTarget(rawTarget: string | null, messages: ChatMessage[]): string | null {
  if (!rawTarget) return null;
  if (!isPronounTarget(rawTarget)) return rawTarget;

  for (let i = messages.length - 2; i >= 0; i--) {
    const candidate = extractPotentialEntityFromText(messages[i].content);
    if (candidate) return candidate;
  }
  return null;
}

export function resolveCountTarget(input: string, messages: ChatMessage[]): string | null {
  // Never invent a count target for find/search/recipe questions
  if (!looksLikeMentionCountQuestion(input) && !isShortCountFollowup(input)) {
    return null;
  }
  const extracted = extractMentionCountTarget(input);
  const resolved = resolveMentionTarget(extracted, messages);
  if (resolved) return normalizeEntityTarget(resolved);
  const followup = extractCountFollowupCandidate(input);
  if (followup && isCountFollowupContext(messages)) return followup;
  return null;
}

export function looksLikeMainCharacterQuestion(input: string): boolean {
  return /main character|main characters|primary character|protagonist/i.test(input);
}

export function extractWhoIsTarget(input: string): string | null {
  const m = input.match(/\bwho is\s+["“”']?([^"“”'?\n]+?)["“”']?(?:\?|$)/i);
  if (!m?.[1]) return null;
  const value = m[1].trim().replace(/^(the|a|an)\s+/i, "").trim();
  return value.length >= 2 ? value : null;
}

export function shouldBypassSpecialists(input: string): boolean {
  const text = normalizeUserQuestion(input).trim().toLowerCase();
  if (!text) return true;
  if (/^retry (specialist step|final synthesis) for:/i.test(text)) return false;
  if (/^(tell me|tell me please|please answer|answer please|continue|go on|finish the answer)\b/i.test(text)) {
    return false;
  }
  if (/\b(have you read|did you read|did you finish|have you finished)\b/.test(text)) {
    return true;
  }
  return (
    /what can you do|who are you|how can you help|help me|what do you know|introduce yourself|hello|hi\b|hey\b/.test(
      text
    ) ||
    (text.split(/\s+/).length <= 8 &&
      !/book|books|chapter|page|quote|character|theme|plot|series|mentioned|mentions|find|count|timeline|entity|who is|have you read|did you read|did you finish|have you finished/.test(
        text
      ))
  );
}

export function looksLikeLibraryCountQuestion(input: string): boolean {
  return /how many books|number of books|count (?:my )?books|books (?:do i|in (?:my )?library)/i.test(
    input
  );
}

export function looksLikeHaveYouReadQuestion(input: string): boolean {
  return /\b(have you read|did you read|did you finish|have you finished)\b/i.test(input);
}

export function extractRetryQuestion(
  input: string
): { step: "specialist" | "final"; question: string } | null {
  const m = input.match(/^retry (specialist step|final synthesis) for:\s*(.+)$/i);
  if (!m?.[2]) return null;
  const step = /specialist/i.test(m[1]) ? "specialist" : "final";
  return { step, question: m[2].trim() };
}

export function buildRecentConversation(messages: ChatMessage[], maxTurns = 6): string {
  return messages
    .slice(-maxTurns)
    .map((m) => {
      const sources = m.sources?.length
        ? `\n  [cited: ${m.sources
            .slice(0, 4)
            .map((s) => (s.position ? `${s.book} · ${s.position}` : s.book))
            .join("; ")}]`
        : "";
      const body = m.content.length > 900 ? `${m.content.slice(0, 880)}…` : m.content;
      return `${m.role.toUpperCase()}: ${body}${sources}`;
    })
    .join("\n");
}

/** Hint so open-ended answers stay aware of series order / continuity. */
export function buildSeriesContinuityHint(opts: {
  orderedTitles?: string[];
  focusTitle?: string | null;
}): string {
  const titles = (opts.orderedTitles || []).filter(Boolean);
  if (titles.length < 2) return "";
  const focus = opts.focusTitle ? ` Current focus: ${opts.focusTitle}.` : "";
  return (
    `SERIES CONTINUITY: These books are ordered as: ${titles.join(" → ")}.` +
    focus +
    " Prefer answering with awareness of what has happened by this point in the series;" +
    " note book numbers when comparing events across volumes; avoid spoiling later books unless asked."
  );
}
