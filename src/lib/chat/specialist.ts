import { DRY_RUN_TEXT, isDryRun, skipSpecialistCache } from "@/lib/chat/request-context";
import { callClaudeText, extractJsonObject } from "@/lib/bedrock-claude";
import { getEntityGraph } from "@/lib/knowledge-store";
import {
  queryBook,
  searchBookKeyword,
  loadBookSpecialistProfile,
  getBookById,
  type BookSpecialistProfile,
} from "@/lib/book-store";
import { getReindexState } from "@/lib/reindex-manager";
import {
  fingerprintQuestion,
  getCachedSpecialistAnswer,
  setCachedSpecialistAnswer,
  updateSpecialistScorecard,
} from "@/lib/quality-store";
import { isLibraryManagementInput } from "@/lib/chat/library-commands";
import { extractKeywords } from "@/lib/chat/intent";
import { callSpecialistClaude, resolveSpecialistModel } from "@/lib/chat/specialist-model";
import type {
  SpecialistAnswer,
  SpecialistConfidence,
  SpecialistFinding,
  StreamSpecialistReport,
} from "@/lib/chat/types";

/**
 * Capitalised words the entity graph picks up at the start of sentences and in dialogue.
 * The graph takes any capitalised word for a name; these never are one.
 */
const NOT_A_NAME = new Set(
  (
    "the that this these those there then than they them their you your yours what when where which who whom whose why how " +
    "and but for nor not with without from into onto over under after before because since while until unless although though " +
    "she her hers his him its our ours all any some one two three four five six seven eight nine ten first second none most more " +
    "much many each every both either neither other another such same only just even also still again once now here " +
    "yes yeah yep nope okay well hey hmm huh ugh wow whoa oops damn crap shit hell holy sorry please thank thanks sure right " +
    "good great fine like let lets can could would should will shall may might must did does are was were has have had having " +
    "come give get got look listen tell see wait stop maybe perhaps anyway instead except besides however whatever plus part " +
    "really actually probably technically unfortunately sometimes nothing something everything anything everyone someone " +
    "anyone nobody people sir maam mister miss chapter prologue epilogue don didn isn wasn won"
  ).split(" ")
);

export interface MainCharacter {
  name: string;
  /** Other forms of the name the books use ("Joe", "Bishop" for "Joe Bishop"). */
  aliases: string[];
  mentions: number;
  /** How many of the books in scope the character appears in. */
  books: number;
}

/**
 * The people who matter most in these books, from the entity graph: characters only
 * (groups, ships and places are other node types), short forms counted into the full
 * name they belong to.
 */
export function deriveMainCharacters(bookIds: string[]): MainCharacter[] {
  const graph = getEntityGraph();
  const inScope = new Set(bookIds);
  // The graph holds one node per name and book; a character is the sum of its nodes.
  const byName = new Map<string, { name: string; mentions: number; books: Set<string>; aliases: string[] }>();
  // "Bishop" in one book is "Joe Bishop" in another: a short form counts towards the
  // full name it is an alias of, when only one full name claims it.
  const fullNameOf = new Map<string, string | null>();
  for (const n of graph.nodes) {
    if (n.type !== "character" || !n.books.some((b: string) => inScope.has(b))) continue;
    for (const alias of n.aliases || []) {
      const key = alias.toLowerCase();
      const seen = fullNameOf.get(key);
      fullNameOf.set(key, seen === undefined || seen === n.name ? n.name : null);
    }
  }
  for (const n of graph.nodes) {
    if (n.type !== "character" || n.mentions < 2) continue;
    const books = n.books.filter((b: string) => inScope.has(b));
    if (!books.length) continue;
    const displayName = fullNameOf.get(n.name.toLowerCase()) || n.name;
    const key = displayName.toLowerCase();
    if (NOT_A_NAME.has(key)) continue;
    const row = byName.get(key) || { name: displayName, mentions: 0, books: new Set<string>(), aliases: [] };
    row.mentions += n.mentions;
    for (const b of books) row.books.add(b);
    for (const alias of displayName === n.name ? n.aliases || [] : [n.name]) {
      const known = row.aliases.some((a) => a.toLowerCase() === alias.toLowerCase());
      if (!known && alias.toLowerCase() !== key && !NOT_A_NAME.has(alias.toLowerCase())) row.aliases.push(alias);
    }
    byName.set(key, row);
  }
  const weighted = [...byName.values()].map((row) => ({
    name: row.name,
    aliases: row.aliases,
    mentions: row.mentions,
    books: row.books.size,
    score: row.mentions * Math.max(row.books.size, 1),
  }));
  weighted.sort((a, b) => b.score - a.score);
  if (!weighted.length) return [];
  const max = weighted[0].score;
  return weighted
    .filter((w, i) => i < 8 && (w.score >= max * 0.35 || i < 3))
    .map((w) => ({ name: w.name, aliases: w.aliases, mentions: w.mentions, books: w.books }));
}

/** "- **Joe Bishop** (Joe, Bishop): 6,479 mentions in 16 books" */
export function formatMainCharacter(c: MainCharacter): string {
  const aliases = c.aliases.length ? ` (${c.aliases.slice(0, 4).join(", ")})` : "";
  const mentions = `${c.mentions.toLocaleString("en-US")} mention${c.mentions === 1 ? "" : "s"}`;
  return `- **${c.name}**${aliases}: ${mentions} in ${c.books} book${c.books === 1 ? "" : "s"}`;
}

export function summarizeSpecialistDisagreement(specialists: SpecialistAnswer[]): string[] {
  const normalized = specialists
    .map((s) => ({
      bookTitle: s.bookTitle,
      answer: s.directAnswer.toLowerCase().replace(/\s+/g, " ").trim(),
      numeric: s.numericEstimate,
    }))
    .filter((s) => s.answer.length > 0);
  if (normalized.length < 2) return [];
  const numeric = normalized.filter((n) => typeof n.numeric === "number") as Array<{
    bookTitle: string;
    answer: string;
    numeric: number;
  }>;
  const notes: string[] = [];
  if (numeric.length >= 2) {
    const unique = [...new Set(numeric.map((n) => n.numeric))];
    if (unique.length > 1) {
      notes.push(
        `Numeric disagreement across specialists: ${numeric
          .map((n) => `${n.bookTitle}=${n.numeric}`)
          .join(", ")}`
      );
    }
  }
  const uniqueAnswers = [...new Set(normalized.map((n) => n.answer.slice(0, 120)))];
  if (uniqueAnswers.length > Math.max(2, Math.ceil(normalized.length * 0.5))) {
    notes.push("Specialists reported materially different narrative answers across books.");
  }
  return notes;
}

/** What the entity graph says a name is, in words a prompt can use. */
export function describeEntityKind(entity: { name: string; type: string; aliases: string[] }): string {
  const also = entity.aliases.length ? ` Also written: ${entity.aliases.slice(0, 5).join(", ")}.` : "";
  switch (entity.type) {
    case "character":
      return `${entity.name} is a person (a character).${also}`;
    case "faction":
      return `${entity.name} is a group (a species, people, organisation or ship), not a single person. Describe who they are as a group.${also}`;
    case "place":
      return `${entity.name} is a place, not a person. Say where and what it is.${also}`;
    default:
      return "";
  }
}

export async function synthesizeWhoIsAnswer(params: {
  target: string;
  scopeLabel: string;
  snippets: Array<{ book: string; label: string; snippet: string }>;
  conversationContext?: string;
  modelId?: string;
  signal?: AbortSignal;
  /** The question as asked ("Who are the Kristang?"); default "Who is <target>?". */
  question?: string;
  /** What the entity graph knows the target to be. */
  entity?: { name: string; type: string; aliases: string[] } | null;
}): Promise<string> {
  if (!params.snippets.length) {
    return `I couldn't find enough evidence to identify **${params.target}** in ${params.scopeLabel}.`;
  }
  const context = params.snippets
    .slice(0, 24)
    .map((s, i) => `[${i + 1}] ${s.book} ${s.label}: ${s.snippet}`)
    .join("\n");
  const kind = params.entity ? describeEntityKind(params.entity) : "";
  const prompt = `You are a helpful librarian AI.
User asks: "${params.question || `Who is ${params.target}?`}"
Scope: ${params.scopeLabel}
${kind ? `What the library's index of names says: ${kind}\n` : ""}Recent conversation context:
${params.conversationContext || "(none)"}

Use ONLY the evidence below. Answer like a real person in 2-4 sentences, in the language the user's question is written in:
1) Start with a direct identification sentence.
2) Add key role/context.
3) If uncertain, say that clearly.

Then add a short markdown section "## Evidence notes" with 2-4 bullets citing evidence ids like [3].

Evidence:
${context}`;
  const text = await callClaudeText(prompt, 900, 0.2, params.modelId, { signal: params.signal });
  return text?.trim() || `I found references to **${params.target}**, but I couldn't generate a reliable identity summary yet.`;
}

function parseSpecialistConfidence(value: string | undefined): SpecialistConfidence {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "low";
}

export function toSpecialistReports(
  specialists: Array<SpecialistAnswer & { reasked?: boolean; scorecard?: StreamSpecialistReport["scorecard"] }>
): StreamSpecialistReport[] {
  return specialists.map((s) => ({
    bookTitle: s.bookTitle,
    confidence: s.confidence,
    numericEstimate: s.numericEstimate,
    directAnswer: s.directAnswer,
    findingsCount: s.findings.length,
    topFindings: s.findings.slice(0, 3).map((f) => ({
      finding: f.finding,
      location: f.location,
    })),
    caveats: s.caveats.slice(0, 3),
    reasked: s.reasked,
    scorecard: s.scorecard,
  }));
}

function parseFindings(value: unknown): SpecialistFinding[] {
  if (!Array.isArray(value)) return [];
  return value.map((f) => ({
    finding: String((f as SpecialistFinding)?.finding || ""),
    location: String((f as SpecialistFinding)?.location || "Unknown location"),
    evidence: String((f as SpecialistFinding)?.evidence || ""),
  }));
}

/** Cache key: book + question + model + book/index generation, so a reindex or model switch misses. */
function specialistCacheKey(bookId: string, question: string, modelId: string): string {
  const book = getBookById(bookId);
  const reindexedAt = getReindexState().finishedAt || "";
  return fingerprintQuestion(`${bookId}::${modelId}::${book?.addedAt || ""}::${reindexedAt}`, question);
}

export interface SpecialistRequest {
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  /** A fixed model from Settings; empty means auto (cheaper models first, see `specialist-model.ts`). */
  modelId?: string;
  signal?: AbortSignal;
  /** Semantic passages for this book from the request's one seed query (skips a re-embed). */
  seedPassages?: Array<{ text: string; location: string }>;
}

export type SpecialistResult = SpecialistAnswer & {
  reasked?: boolean;
  scorecard?: StreamSpecialistReport["scorecard"];
  /** Claude calls this answer cost so far (0: cache, skipped command). */
  calls: number;
  /**
   * The book had passages and the librarian still found nothing: a deeper second read
   * (`reaskBookSpecialist`) may help. Such an answer is not cached or scored yet; the
   * caller either re-asks or keeps it (`keepSpecialistAnswer`).
   */
  canReask: boolean;
};

const specialistSystemPrompt = (bookTitle: string, profile: BookSpecialistProfile | null) =>
  `You are the specialist AI for the single book "${bookTitle}".
You must answer ONLY from evidence in context. Return STRICT JSON:
{
  "confidence": "high|medium|low",
  "directAnswer": "string",
  "numericEstimate": number|null,
  "findings": [{"finding":"string","location":"Page X / Chapter Y","evidence":"short quote"}],
  "caveats": ["string"]
}
Rules:
- No markdown, JSON only.
- If unsure, set confidence low and explain in caveats.
- Include all concrete findings you can prove from context.
${profile ? `Specialist memory summary: ${profile.summary}\nKey topics: ${profile.keyTopics.join(", ")}` : ""}`;

function buildContext(
  semantic: Array<{ text: string; location: string }>,
  keyword: Array<{ label: string; snippet: string }>,
  max: number
): string {
  return [
    ...semantic.map((s, i) => `[S${i + 1} ${s.location}] ${s.text}`),
    ...keyword.map((k, i) => `[K${i + 1} ${k.label}] ${k.snippet}`),
  ]
    .slice(0, max)
    .join("\n\n");
}

function parseSpecialistJson(raw: string): Partial<Omit<SpecialistAnswer, "bookTitle">> | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<Omit<SpecialistAnswer, "bookTitle">>) : null;
  } catch {
    return null;
  }
}

function withScore(params: SpecialistRequest, result: SpecialistResult): SpecialistResult {
  const score = updateSpecialistScorecard({
    bookId: params.bookId,
    bookTitle: params.bookTitle,
    confidence: result.confidence,
    findingsCount: result.findings.length,
  });
  return {
    ...result,
    scorecard: {
      precisionEstimate: score.precisionEstimate,
      recallEstimate: score.recallEstimate,
      total: score.total,
    },
  };
}

/** Cache the final answer (findings travel with it, so a cache hit still has sources) and score it. */
function settle(params: SpecialistRequest, result: SpecialistResult, modelId: string): SpecialistResult {
  // `findings` and `numericEstimate` ride along beyond the store's entry type.
  const row = {
    key: specialistCacheKey(params.bookId, params.userQuestion, modelId),
    bookId: params.bookId,
    answer: result.directAnswer,
    confidence: result.confidence,
    findingsCount: result.findings.length,
    findings: result.findings,
    numericEstimate: result.numericEstimate,
    createdAt: new Date().toISOString(),
  };
  setCachedSpecialistAnswer(row);
  return { ...withScore(params, result), canReask: false };
}

/** The model that gave each still-open first read: the final answer is cached under it. */
const answeredBy = new WeakMap<SpecialistResult, string>();

/**
 * One librarian reads its book once. An empty answer from a book that had passages
 * comes back with `canReask`; whether a second, deeper read is worth a call is the
 * caller's decision (it knows whether more books are about to be read anyway).
 */
export async function askBookSpecialist(params: SpecialistRequest): Promise<SpecialistResult> {
  const base = { bookTitle: params.bookTitle, numericEstimate: null, findings: [], calls: 0, canReask: false };
  if (isLibraryManagementInput(params.userQuestion)) {
    return {
      ...base,
      confidence: "high",
      directAnswer:
        "Skipped — this is a library management command (delete/reindex/list), not a question about book content.",
      caveats: ["Handled by the library command handler in chat, not per-book specialists."],
    };
  }

  // Looked up under the model the call would start with; an answer is stored under the
  // model that gave it, which after a fallback is the starting model of later requests.
  const cacheKey = specialistCacheKey(params.bookId, params.userQuestion, resolveSpecialistModel(params.modelId));
  const cached = getCachedSpecialistAnswer(cacheKey) as
    | (ReturnType<typeof getCachedSpecialistAnswer> & { findings?: unknown; numericEstimate?: unknown })
    | null;
  // Only entries that carry their findings are usable; older ones (no findings) are bypassed.
  // An eval run (dry or live) asks as if nothing were cached, so its call counts and
  // answers don't depend on what was asked before.
  if (!skipSpecialistCache() && cached && Array.isArray(cached.findings)) {
    return {
      ...base,
      confidence: parseSpecialistConfidence(cached.confidence),
      directAnswer: cached.answer,
      numericEstimate: typeof cached.numericEstimate === "number" ? cached.numericEstimate : null,
      findings: parseFindings(cached.findings),
      caveats: ["Served from specialist cache"],
    };
  }

  if (isDryRun()) {
    // Eval dry run: this librarian would be asked. Count the call; touch no cache, scorecard or model state.
    await callSpecialistClaude("", 1, 0, { fixedModelId: params.modelId, signal: params.signal });
    return { ...base, calls: 1, confidence: "low", directAnswer: DRY_RUN_TEXT, caveats: ["Dry run"] };
  }

  params.signal?.throwIfAborted();
  const semantic = params.seedPassages?.length
    ? params.seedPassages
    : await queryBook(params.bookId, params.userQuestion, 16);
  const words = extractKeywords(params.userQuestion);
  const keyword = words.length ? searchBookKeyword(params.bookId, words, 40) : [];
  const context = buildContext(semantic, keyword, 80);

  const { text: raw, modelId } = await callSpecialistClaude(
    `Question: ${params.userQuestion}\n\nContext:\n${context || "(No context found)"}`,
    1400,
    0.1,
    {
      fixedModelId: params.modelId,
      system: specialistSystemPrompt(params.bookTitle, loadBookSpecialistProfile(params.bookId)),
      signal: params.signal,
    }
  );
  const parsed = parseSpecialistJson(raw);
  if (!parsed) {
    // Not cached: the next ask should get a real answer.
    return withScore(params, {
      ...base,
      calls: 1,
      confidence: "low",
      directAnswer: "Unable to parse specialist output.",
      caveats: ["Specialist returned non-JSON output."],
    });
  }

  const result: SpecialistResult = {
    ...base,
    calls: 1,
    confidence: parseSpecialistConfidence(parsed.confidence),
    directAnswer: parsed.directAnswer || "No answer provided.",
    numericEstimate: typeof parsed.numericEstimate === "number" ? parsed.numericEstimate : null,
    findings: parseFindings(parsed.findings),
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats.map(String) : [],
  };
  if (result.findings.length === 0 && semantic.length > 0) {
    const open = { ...result, canReask: true };
    answeredBy.set(open, modelId);
    return open;
  }
  return settle(params, result, modelId);
}

/** Keep an empty first read as the final answer (no call left for a second read). */
export function keepSpecialistAnswer(params: SpecialistRequest, first: SpecialistResult): SpecialistResult {
  if (!first.canReask) return first;
  return settle(params, first, answeredBy.get(first) || resolveSpecialistModel(params.modelId));
}

/** The second, deeper read of a book whose first read found nothing: more passages, one more call. */
export async function reaskBookSpecialist(
  params: SpecialistRequest,
  first: SpecialistResult
): Promise<SpecialistResult> {
  if (!first.canReask) return first;
  if (params.signal?.aborted) return keepSpecialistAnswer(params, first);
  const words = extractKeywords(params.userQuestion);
  const deepSemantic = await queryBook(params.bookId, params.userQuestion, 28);
  const deepKeyword = words.length ? searchBookKeyword(params.bookId, words, 80) : [];
  const context = buildContext(deepSemantic, deepKeyword, 120);
  const { text: raw, modelId } = await callSpecialistClaude(
    `RE-ASK: Previous answer had no findings. Extract all evidence again, strictly from context.\nQuestion: ${params.userQuestion}\n\nContext:\n${context || "(No context found)"}`,
    1400,
    0.05,
    {
      fixedModelId: params.modelId,
      system: specialistSystemPrompt(params.bookTitle, loadBookSpecialistProfile(params.bookId)),
      signal: params.signal,
    }
  );
  const retry = parseSpecialistJson(raw);
  const merged: SpecialistResult = retry
    ? {
        ...first,
        confidence: parseSpecialistConfidence(retry.confidence),
        directAnswer: retry.directAnswer || first.directAnswer,
        numericEstimate: typeof retry.numericEstimate === "number" ? retry.numericEstimate : first.numericEstimate,
        findings: Array.isArray(retry.findings) ? parseFindings(retry.findings) : first.findings,
        caveats: Array.isArray(retry.caveats) ? retry.caveats.map(String) : first.caveats,
        reasked: true,
      }
    : first;
  return settle(params, { ...merged, calls: first.calls + 1 }, modelId);
}
