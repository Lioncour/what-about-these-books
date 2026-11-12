import { callClaudeText, extractJsonObject } from "@/lib/bedrock-claude";
import { getEntityGraph } from "@/lib/knowledge-store";
import {
  queryBook,
  searchBookKeyword,
  loadBookSpecialistProfile,
  getBookById,
} from "@/lib/book-store";
import { DEFAULT_BEDROCK_MODEL_ID } from "@/lib/bedrock-client";
import { getReindexState } from "@/lib/reindex-manager";
import {
  fingerprintQuestion,
  getCachedSpecialistAnswer,
  setCachedSpecialistAnswer,
  updateSpecialistScorecard,
} from "@/lib/quality-store";
import { isLibraryManagementInput } from "@/lib/chat/library-commands";
import { extractKeywords } from "@/lib/chat/intent";
import type {
  SpecialistAnswer,
  SpecialistConfidence,
  SpecialistFinding,
  StreamSpecialistReport,
} from "@/lib/chat/types";

export type { StreamSpecialistReport };

export function deriveMainCharacters(bookIds: string[]): { name: string; mentions: number; books: number }[] {
  const graph = getEntityGraph();
  const nodes = graph.nodes.filter(
    (n) =>
      n.type === "character" &&
      n.mentions >= 2 &&
      n.books.some((b: string) => bookIds.includes(b))
  );
  const weighted = nodes.map((n) => {
    const scopeBooks = n.books.filter((b: string) => bookIds.includes(b)).length;
    return {
      name: n.name,
      mentions: n.mentions,
      books: scopeBooks,
      score: n.mentions * Math.max(scopeBooks, 1),
    };
  });
  weighted.sort((a, b) => b.score - a.score);
  if (!weighted.length) return [];
  const max = weighted[0].score;
  return weighted
    .filter((w, i) => i < 8 && (w.score >= max * 0.35 || i < 3))
    .map((w) => ({ name: w.name, mentions: w.mentions, books: w.books }));
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

export async function synthesizeWhoIsAnswer(params: {
  target: string;
  scopeLabel: string;
  snippets: Array<{ book: string; label: string; snippet: string }>;
  conversationContext?: string;
  modelId?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (!params.snippets.length) {
    return `I couldn't find enough evidence to identify **${params.target}** in ${params.scopeLabel}.`;
  }
  const context = params.snippets
    .slice(0, 24)
    .map((s, i) => `[${i + 1}] ${s.book} ${s.label}: ${s.snippet}`)
    .join("\n");
  const prompt = `You are a helpful librarian AI.
User asks: "Who is ${params.target}?"
Scope: ${params.scopeLabel}
Recent conversation context:
${params.conversationContext || "(none)"}

Use ONLY the evidence below. Answer like a real person in 2-4 sentences:
1) Start with a direct identification sentence.
2) Add key role/context.
3) If uncertain, say that clearly.

Then add a short markdown section "## Evidence notes" with 2-4 bullets citing evidence ids like [3].

Evidence:
${context}`;
  const text = await callClaudeText(prompt, 900, 0.2, params.modelId, { signal: params.signal });
  return text?.trim() || `I found references to **${params.target}**, but I couldn't generate a reliable identity summary yet.`;
}

export function parseSpecialistConfidence(value: string | undefined): SpecialistConfidence {
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

export async function askBookSpecialist(params: {
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  modelId?: string;
  signal?: AbortSignal;
  /** Semantic passages for this book from the request's one seed query (skips a re-embed). */
  seedPassages?: Array<{ text: string; location: string }>;
}): Promise<SpecialistAnswer & { reasked?: boolean; scorecard?: StreamSpecialistReport["scorecard"] }> {
  if (isLibraryManagementInput(params.userQuestion)) {
    return {
      bookTitle: params.bookTitle,
      confidence: "high",
      directAnswer:
        "Skipped — this is a library management command (delete/reindex/list), not a question about book content.",
      numericEstimate: null,
      findings: [],
      caveats: ["Handled by the library command handler in chat, not per-book specialists."],
    };
  }

  const modelId = params.modelId || DEFAULT_BEDROCK_MODEL_ID;
  const cacheKey = specialistCacheKey(params.bookId, params.userQuestion, modelId);
  const cached = getCachedSpecialistAnswer(cacheKey) as
    | (ReturnType<typeof getCachedSpecialistAnswer> & { findings?: unknown; numericEstimate?: unknown })
    | null;
  // Only entries that carry their findings are usable; older ones (no findings) are bypassed.
  if (cached && Array.isArray(cached.findings)) {
    return {
      bookTitle: params.bookTitle,
      confidence: parseSpecialistConfidence(cached.confidence),
      directAnswer: cached.answer,
      numericEstimate: typeof cached.numericEstimate === "number" ? cached.numericEstimate : null,
      findings: parseFindings(cached.findings),
      caveats: ["Served from specialist cache"],
    };
  }

  params.signal?.throwIfAborted();
  const semantic = params.seedPassages?.length
    ? params.seedPassages
    : await queryBook(params.bookId, params.userQuestion, 16);
  const words = extractKeywords(params.userQuestion);
  const keyword = words.length ? searchBookKeyword(params.bookId, words, 40) : [];
  const profile = loadBookSpecialistProfile(params.bookId);

  let context = [
    ...semantic.map((s, i) => `[S${i + 1} ${s.location}] ${s.text}`),
    ...keyword.map((k, i) => `[K${i + 1} ${k.label}] ${k.snippet}`),
  ]
    .slice(0, 80)
    .join("\n\n");

  const specialistPrompt = `You are the specialist AI for the single book "${params.bookTitle}".
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

  const raw = await callClaudeText(
    `Question: ${params.userQuestion}\n\nContext:\n${context || "(No context found)"}`,
    1400,
    0.1,
    modelId,
    { system: specialistPrompt, signal: params.signal }
  );
  const json = extractJsonObject(raw);
  if (!json) {
    const fallback: SpecialistAnswer = {
      bookTitle: params.bookTitle,
      confidence: "low",
      directAnswer: "Unable to parse specialist output.",
      numericEstimate: null,
      findings: [],
      caveats: ["Specialist returned non-JSON output."],
    };
    const score = updateSpecialistScorecard({
      bookId: params.bookId,
      bookTitle: params.bookTitle,
      confidence: fallback.confidence,
      findingsCount: fallback.findings.length,
    });
    return {
      ...fallback,
      scorecard: {
        precisionEstimate: score.precisionEstimate,
        recallEstimate: score.recallEstimate,
        total: score.total,
      },
    };
  }

  try {
    const parsed = JSON.parse(json) as Omit<SpecialistAnswer, "bookTitle">;
    let answer: SpecialistAnswer = {
      bookTitle: params.bookTitle,
      confidence: parseSpecialistConfidence(parsed.confidence),
      directAnswer: parsed.directAnswer || "No answer provided.",
      numericEstimate: typeof parsed.numericEstimate === "number" ? parsed.numericEstimate : null,
      findings: parseFindings(parsed.findings),
      caveats: Array.isArray(parsed.caveats) ? parsed.caveats.map(String) : [],
    };
    let reasked = false;

    // Re-ask only when the book had passages to read and the specialist still found nothing.
    if (answer.findings.length === 0 && semantic.length > 0 && !params.signal?.aborted) {
      const deepSemantic = await queryBook(params.bookId, params.userQuestion, 28);
      const deepKeyword = words.length ? searchBookKeyword(params.bookId, words, 80) : [];
      context = [
        ...deepSemantic.map((s, i) => `[S${i + 1} ${s.location}] ${s.text}`),
        ...deepKeyword.map((k, i) => `[K${i + 1} ${k.label}] ${k.snippet}`),
      ]
        .slice(0, 120)
        .join("\n\n");
      const retryRaw = await callClaudeText(
        `RE-ASK: Previous answer had no findings. Extract all evidence again, strictly from context.\nQuestion: ${params.userQuestion}\n\nContext:\n${context || "(No context found)"}`,
        1400,
        0.05,
        modelId,
        { system: specialistPrompt, signal: params.signal }
      );
      const retryJson = extractJsonObject(retryRaw);
      if (retryJson) {
        try {
          const retryParsed = JSON.parse(retryJson) as Omit<SpecialistAnswer, "bookTitle">;
          answer = {
            ...answer,
            confidence: parseSpecialistConfidence(retryParsed.confidence) || answer.confidence,
            directAnswer: retryParsed.directAnswer || answer.directAnswer,
            numericEstimate:
              typeof retryParsed.numericEstimate === "number"
                ? retryParsed.numericEstimate
                : answer.numericEstimate,
            findings: Array.isArray(retryParsed.findings)
              ? parseFindings(retryParsed.findings)
              : answer.findings,
            caveats: Array.isArray(retryParsed.caveats)
              ? retryParsed.caveats.map(String)
              : answer.caveats,
          };
          reasked = true;
        } catch {
          // keep original answer
        }
      }
    }

    // Findings travel with the entry so a cache hit still has sources.
    const cacheRow = {
      key: cacheKey,
      bookId: params.bookId,
      answer: answer.directAnswer,
      confidence: answer.confidence,
      findingsCount: answer.findings.length,
      findings: answer.findings,
      numericEstimate: answer.numericEstimate,
      createdAt: new Date().toISOString(),
    };
    setCachedSpecialistAnswer(cacheRow);
    const score = updateSpecialistScorecard({
      bookId: params.bookId,
      bookTitle: params.bookTitle,
      confidence: answer.confidence,
      findingsCount: answer.findings.length,
    });
    return {
      ...answer,
      reasked,
      scorecard: {
        precisionEstimate: score.precisionEstimate,
        recallEstimate: score.recallEstimate,
        total: score.total,
      },
    };
  } catch {
    return {
      bookTitle: params.bookTitle,
      confidence: "low",
      directAnswer: "Unable to parse specialist output.",
      numericEstimate: null,
      findings: [],
      caveats: ["Specialist JSON parse failed."],
    };
  }
}
