import { callClaudeText, extractJsonObject } from "@/lib/bedrock-claude";
import { getEntityGraph } from "@/lib/knowledge-store";
import {
  queryBook,
  searchBookKeyword,
  loadBookSpecialistProfile,
} from "@/lib/book-store";
import {
  fingerprintQuestion,
  getCachedSpecialistAnswer,
  setCachedSpecialistAnswer,
  updateSpecialistScorecard,
} from "@/lib/quality-store";
import { isLibraryManagementInput } from "@/lib/chat/library-commands";
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
  const text = await callClaudeText(prompt, 900, 0.2, params.modelId);
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

export async function askBookSpecialist(params: {
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  modelId?: string;
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

  const cacheKey = fingerprintQuestion(params.bookId, params.userQuestion);
  const cached = getCachedSpecialistAnswer(cacheKey);
  if (cached) {
    return {
      bookTitle: params.bookTitle,
      confidence: parseSpecialistConfidence(cached.confidence),
      directAnswer: cached.answer,
      numericEstimate: null,
      findings: [],
      caveats: ["Served from specialist cache"],
    };
  }

  const semantic = await queryBook(params.bookId, params.userQuestion, 16);
  const words = params.userQuestion
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  const keyword = words.length ? searchBookKeyword(params.bookId, words, 60) : [];
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
    `${specialistPrompt}\n\nQuestion: ${params.userQuestion}\n\nContext:\n${context || "(No context found)"}`,
    1400,
    0.1,
    params.modelId
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
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map((f) => ({
            finding: String((f as SpecialistFinding).finding || ""),
            location: String((f as SpecialistFinding).location || "Unknown location"),
            evidence: String((f as SpecialistFinding).evidence || ""),
          }))
        : [],
      caveats: Array.isArray(parsed.caveats) ? parsed.caveats.map(String) : [],
    };
    let reasked = false;

    if (answer.confidence === "low" || answer.findings.length < 2) {
      const deepSemantic = await queryBook(params.bookId, params.userQuestion, 28);
      const deepKeyword = words.length ? searchBookKeyword(params.bookId, words, 140) : [];
      context = [
        ...deepSemantic.map((s, i) => `[S${i + 1} ${s.location}] ${s.text}`),
        ...deepKeyword.map((k, i) => `[K${i + 1} ${k.label}] ${k.snippet}`),
      ]
        .slice(0, 120)
        .join("\n\n");
      const retryRaw = await callClaudeText(
        `${specialistPrompt}\n\nRE-ASK: Previous answer was low confidence. Extract all evidence again, strictly from context.\nQuestion: ${params.userQuestion}\n\nContext:\n${context || "(No context found)"}`,
        1400,
        0.05,
        params.modelId
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
              ? retryParsed.findings.map((f) => ({
                  finding: String((f as SpecialistFinding).finding || ""),
                  location: String((f as SpecialistFinding).location || "Unknown location"),
                  evidence: String((f as SpecialistFinding).evidence || ""),
                }))
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

    setCachedSpecialistAnswer({
      key: cacheKey,
      answer: answer.directAnswer,
      confidence: answer.confidence,
      findingsCount: answer.findings.length,
      createdAt: new Date().toISOString(),
    });
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
