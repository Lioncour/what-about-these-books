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

export function buildFallbackFromSpecialists(question: string, specialists: SpecialistAnswer[]): string {
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

export async function orchestrateSpecialists(
  question: string,
  specialists: SpecialistAnswer[],
  modelId?: string,
  personalityHint?: string,
  opts?: {
    companionMode?: boolean;
    onToken?: (delta: string) => void;
    continuityHint?: string;
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
  const prompt =
    `${voicePreamble(companion)}\n\n` +
    `You are merging specialist reading notes into one final response in Markdown. ` +
    `${RESPONSE_FORMATTING_RULES}\n` +
    `Include per-book findings, totals if numeric data exists, and explicit caveats. ` +
    `Do not invent facts not present in specialist payload.\n\n` +
    `If specialists disagree, add a clear "## Where the books disagree" section.\n` +
    (opts?.continuityHint ? `${opts.continuityHint}\n\n` : "") +
    (personalityHint ? `Personality preferences:\n${personalityHint}\n\n` : "") +
    `User question: ${question}\n\nKnown disagreement notes:\n${disagreements.join("\n") || "(none)"}\n\nSpecialist outputs JSON:\n${payload}`;

  const text = opts?.onToken
    ? await callClaudeStream(prompt, opts.onToken, 2500, 0.2, modelId)
    : await callClaudeText(prompt, 2500, 0.2, modelId);

  if (!text?.trim() || looksLikeThinAnswer(text)) {
    const fallback = buildFallbackFromSpecialists(question, specialists);
    if (opts?.onToken && !text?.trim()) {
      opts.onToken(fallback);
    }
    return fallback;
  }
  return text;
}

/** Soften short factual one-liners only — skipped entirely in raw mode. */
export async function claudeNaturalAnswer(params: {
  userQuestion: string;
  factualAnswer: string;
  modelId?: string;
  companionMode?: boolean;
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
  const text = await callClaudeText(prompt, 450, 0.25, params.modelId);
  return text?.trim() || params.factualAnswer;
}
