import { callClaudeText, callClaudeStream } from "@/lib/bedrock-claude";
import type { SpecialistAnswer } from "@/lib/chat/types";
import { summarizeSpecialistDisagreement } from "@/lib/chat/specialist";
import { isLibraryManagementInput } from "@/lib/chat/library-commands";
import {
  RESPONSE_FORMATTING_RULES,
  voicePreamble,
} from "@/lib/chat/response-formatting";

export function looksLikeThinAnswer(text: string): boolean {
  const cleaned = text.replace(/[#>*`|_-]/g, "").trim();
  if (cleaned.length < 40) return true;
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 2 && !/[.!?]/.test(cleaned)) return true;
  return false;
}

function buildFallbackFromSpecialists(question: string, specialists: SpecialistAnswer[]): string {
  const numeric = specialists
    .map((s) => s.numericEstimate)
    .filter((n): n is number => typeof n === "number");
  const avg = numeric.length
    ? Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length)
    : null;
  const high = specialists.filter((s) => s.confidence === "high").length;
  const medium = specialists.filter((s) => s.confidence === "medium").length;
  const low = specialists.filter((s) => s.confidence === "low").length;

  const lines: string[] = [];
  if (/how many|count|number of/i.test(question) && avg !== null) {
    lines.push(`Short answer: based on the available evidence, the best estimate is **${avg}**.`);
  } else {
    const best = specialists.find((s) => s.confidence !== "low") || specialists[0];
    lines.push(`Short answer: ${best?.directAnswer || "I found limited evidence to answer precisely."}`);
  }
  lines.push("");
  lines.push("## Across the books");
  lines.push(`- Confidence mix: high ${high}, medium ${medium}, low ${low}`);
  for (const s of specialists.slice(0, 5)) {
    const top = s.findings[0];
    lines.push(
      `- **${s.bookTitle}**: ${s.directAnswer}${top ? ` (evidence: ${top.location})` : ""}`
    );
  }
  lines.push("");
  lines.push("## Honest caveat");
  lines.push("- Assembled from specialist notes because the final synthesis came back thin.");
  return lines.join("\n");
}

/** Which books the notes come from, and how they came to be the ones read. */
export interface ReadingCoverage {
  /** How the books were chosen: the SCOPE reason. */
  reason: "named" | "focus" | "series" | "semantic" | "all" | "picked";
  /** Display titles of the books whose notes follow. */
  read: string[];
  /** Books in the scope the reader set (the library, the series, their pick). */
  total: number;
  /** Name of the series in focus, for "series". */
  seriesName?: string;
}

/**
 * Tells the model what it is looking at, so the answer doesn't claim more than was
 * read. Without this, a question asked of the whole library and answered from the three
 * closest books came back as "across all three books you're asking about": the reader
 * asked about none of them.
 */
export function coverageNote(coverage: ReadingCoverage): string {
  const { reason, read, total } = coverage;
  const list = read.join(", ");
  const n = read.length;
  const unread = Math.max(0, total - n);
  const plural = (count: number) => (count === 1 ? "book" : "books");
  switch (reason) {
    case "named":
      return `What was read: the reader named ${list} in the question, and the notes come from ${n === 1 ? "that book" : "those books"} only.`;
    case "focus":
      return `What was read: the reader has ${list} open, and the notes come from that book only.`;
    case "picked":
      return (
        `What was read: the reader picked ${total} ${plural(total)} for this question. The notes come from ${n === total ? "all of them" : `the ${n} closest to the question`}: ${list}.` +
        (unread ? ` The other ${unread} were not read; say so, and that the reader can ask for them to be checked too.` : "")
      );
    case "series":
      return (
        `What was read: the reader has the series ${coverage.seriesName || "in focus"} open (${total} ${plural(total)}). The notes come from ${n === total ? "all of them" : `${n} of them`}: ${list}.` +
        (unread
          ? ` The other ${unread} were not read. Do not speak for the whole series: say which books you looked at, and if the question is about the whole story, end by offering to read the rest.`
          : "")
      );
    default:
      return (
        `What was read: the reader asked their whole library (${total} ${plural(total)}) and named no book. ` +
        `You chose the ${n} ${plural(n)} closest to the question: ${list}.` +
        (unread
          ? ` The other ${unread} were not read. The reader did not ask about these ${n} ${plural(n)} in particular, so never write "the books you're asking about" or "all ${n} books": say "in the ${n} ${plural(n)} I looked at" and name them. ` +
            `If the question is about the whole story (does someone survive, how does it end, what happens to someone), say plainly that this is what those books show, and end with one short sentence offering to check the other books or a book the reader names.`
          : "")
      );
  }
}

export async function orchestrateSpecialists(
  question: string,
  specialists: SpecialistAnswer[],
  modelId?: string,
  personalityHint?: string,
  opts?: {
    companionMode?: boolean;
    onToken?: (delta: string) => void;
    continuityHint?: string;
    signal?: AbortSignal;
    /** What the notes cover; lets the answer say what it did and didn't read. */
    coverage?: ReadingCoverage;
  }
): Promise<string> {
  if (isLibraryManagementInput(question)) {
    const skipped = specialists.every((s) =>
      s.directAnswer.includes("library management command")
    );
    if (skipped) {
      return (
        "That message is a **library command** (manage your uploaded books), not a question about book content.\n\n" +
        "Try again with: `remove all the books in the library`, `@remove all books@`, `list my books`, or `library commands` for help."
      );
    }
  }

  const companion = opts?.companionMode !== false;
  const payload = JSON.stringify(specialists);
  const disagreements = summarizeSpecialistDisagreement(specialists);
  const system =
    `${voicePreamble(companion)}\n\n` +
    `You are merging specialist reading notes into one final response in Markdown. ` +
    `${RESPONSE_FORMATTING_RULES}\n` +
    `Include per-book findings, totals if numeric data exists, and explicit caveats. ` +
    `Do not invent facts not present in specialist payload.\n\n` +
    `If specialists disagree, add a clear "## Where the books disagree" section.\n` +
    (opts?.coverage?.read.length ? `${coverageNote(opts.coverage)}\n\n` : "") +
    (opts?.continuityHint ? `${opts.continuityHint}\n\n` : "") +
    (personalityHint ? `Personality preferences:\n${personalityHint}\n\n` : "");
  const prompt = `User question: ${question}\n\nKnown disagreement notes:\n${disagreements.join("\n") || "(none)"}\n\nSpecialist outputs JSON:\n${payload}`;
  const callOpts = { system, signal: opts?.signal };

  const text = opts?.onToken
    ? await callClaudeStream(prompt, opts.onToken, 2500, 0.2, modelId, callOpts)
    : await callClaudeText(prompt, 2500, 0.2, modelId, callOpts);

  if (!text?.trim() || looksLikeThinAnswer(text)) {
    const fallback = buildFallbackFromSpecialists(question, specialists);
    if (!opts?.onToken) return fallback;
    // Streaming: the client ignores TEXT once tokens have arrived and appends TOKENs,
    // so the fallback goes out as more tokens after whatever thin text was streamed.
    if (!text?.trim()) {
      opts.onToken(fallback);
      return fallback;
    }
    const combined = `${text.trimEnd()}\n\n${fallback}`;
    opts.onToken(`\n\n${fallback}`);
    return combined;
  }
  return text;
}

/** Soften short factual one-liners only — skipped entirely in raw mode. */
export async function claudeNaturalAnswer(params: {
  userQuestion: string;
  factualAnswer: string;
  modelId?: string;
  companionMode?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  if (params.companionMode === false) {
    return params.factualAnswer;
  }

  if (
    /^#/m.test(params.factualAnswer) ||
    params.factualAnswer.includes("\n- ") ||
    params.factualAnswer.includes("\n|") ||
    params.factualAnswer.split("\n").filter(Boolean).length > 4
  ) {
    return params.factualAnswer;
  }

  const prompt = `${voicePreamble(true)}

User asked: "${params.userQuestion}"

Facts you MUST preserve exactly:
${params.factualAnswer}

Instructions:
- Reply naturally like a friend in 1-3 short sentences.
- Keep all numbers and factual claims exactly the same as provided.
- Do not add new facts.
- Do not use headings or tables unless the facts already require them.`;
  const text = await callClaudeText(prompt, 450, 0.25, params.modelId, { signal: params.signal });
  return text?.trim() || params.factualAnswer;
}
