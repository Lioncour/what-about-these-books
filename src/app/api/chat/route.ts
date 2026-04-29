import { NextRequest } from "next/server";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  queryBook,
  queryAllBooks,
  querySeriesBooks,
  searchBookKeyword,
  searchAllBooksKeyword,
  searchSeriesKeyword,
  searchExactQuoteInBook,
  searchExactQuoteAllBooks,
  searchExactQuoteInSeries,
  listSeries,
  listBooks,
  loadSettings,
  loadBookSpecialistProfile,
  getBookById,
} from "@/lib/book-store";
import { logChatEvent } from "@/lib/chat-debug";
import {
  fingerprintQuestion,
  getCachedSpecialistAnswer,
  setCachedSpecialistAnswer,
  updateSpecialistScorecard,
} from "@/lib/quality-store";
import { detectChronologyConflicts, getEntityGraph, queryEntityGraph } from "@/lib/knowledge-store";

const AWS_REGION = process.env.AWS_REGION || "eu-central-1";
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-opus-4-6-v1";
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
const execFileAsync = promisify(execFile);
const AWS_CLI_CANDIDATES = ["aws", "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"];

function isAwsAuthExpiredMessage(message: string): boolean {
  return /ExpiredToken|The SSO session associated with this profile has expired|Unable to locate credentials|credentials/i.test(
    message
  );
}

async function runAwsSsoLogin(): Promise<boolean> {
  const profile = process.env.AWS_PROFILE?.trim();
  const args = profile ? ["sso", "login", "--profile", profile] : ["sso", "login"];
  for (const cli of AWS_CLI_CANDIDATES) {
    try {
      const result = await execFileAsync(cli, args, {
        timeout: 180000,
        windowsHide: true,
        env: process.env,
      });
      logChatEvent("aws_sso_login_auto_success", {
        cli,
        profile: profile || "default",
        stdout: (result.stdout || "").slice(0, 500),
      });
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logChatEvent("aws_sso_login_auto_failed", {
        cli,
        profile: profile || "default",
        error: msg.slice(0, 500),
      });
    }
  }
  return false;
}

async function callClaudeText(
  prompt: string,
  maxTokens = 2500,
  temperature = 0.2,
  modelId?: string
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const command = new InvokeModelCommand({
        modelId: modelId || BEDROCK_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: maxTokens,
          temperature,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
        }),
      });
      const response = await bedrockClient.send(command);
      const raw = new TextDecoder().decode(response.body);
      const parsed = JSON.parse(raw) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      return parsed.content?.find((c) => c.type === "text")?.text || "";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && isAwsAuthExpiredMessage(msg)) {
        const reloginOk = await runAwsSsoLogin();
        if (reloginOk) {
          continue;
        }
      }
      throw error;
    }
  }
  return "";
}

export const maxDuration = 120;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function extractQuotedText(input: string): string | null {
  const match = input.match(/["“”](.{20,}?)["“”]/);
  return match?.[1]?.trim() || null;
}

function looksLikeQuoteLookup(input: string): boolean {
  const lower = input.toLowerCase();
  return (
    lower.includes("find this quote") ||
    lower.includes("find quote") ||
    lower.includes("which book") ||
    lower.includes("what chapter") ||
    lower.includes("where is this quote")
  );
}

function extractMentionCountTarget(input: string): string | null {
  const patterns = [
    /how many times(?:\s+(?:is|was|are|were|does|do))?\s+["“”']?([^"“”'\n]+?)["“”']?\s+(?:mentioned|mentions?|appear(?:s|ed)?|occurs?|used)\b/i,
    /count(?:\s+the)?\s+(?:mentions?|occurrences?)\s+of\s+["“”']?([^"“”'\n]+?)["“”']?(?:\b|$)/i,
    /how many\s+(?:mentions?|occurrences?)\s+of\s+["“”']?([^"“”'\n]+?)["“”']?(?:\b|$)/i,
  ];
  const m = patterns.map((p) => input.match(p)).find(Boolean);
  if (!m?.[1]) return null;
  const value = normalizeEntityTarget(m[1]);
  return value.length >= 2 ? value : null;
}

function normalizeEntityTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^(and|about|for|of|is|was|are|were|does|do|the|a|an|word)\s+/i, "")
    .replace(/\s+(?:in|across)\s+(?:this|the|my|your)\s+(?:book|books|library)\b.*$/i, "")
    .replace(/[?.,!;:]+$/g, "")
    .trim();
}

function extractCountFollowupCandidate(input: string): string | null {
  const cleaned = normalizeEntityTarget(input.replace(/^and\s+/i, ""));
  if (!cleaned) return null;
  if (cleaned.split(/\s+/).length > 5) return null;
  if (/\b(how many|count|mentions?|times|appears?|occurs?|used|quote|chapter|page)\b/i.test(cleaned)) return null;
  if (!/[a-z]/i.test(cleaned)) return null;
  return cleaned;
}

function isCountFollowupContext(messages: ChatMessage[]): boolean {
  const recentUsers = messages
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.content.toLowerCase());
  return recentUsers.some((t) =>
    /(how many times|count(?:\s+the)?\s+mentions?|how many mentions? of|mentioned)/i.test(t)
  );
}

function looksLikeMentionCountQuestion(input: string): boolean {
  return /how many times/i.test(input) && /(mentioned|appear(?:s|ed)?|occurs?|used)/i.test(input);
}

function isPronounTarget(value: string): boolean {
  return /^(he|she|they|him|her|them|it|this character|that character|this person|that person)$/i.test(
    value.trim()
  );
}

function extractPotentialEntityFromText(text: string): string | null {
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

function resolveMentionTarget(rawTarget: string | null, messages: ChatMessage[]): string | null {
  if (!rawTarget) return null;
  if (!isPronounTarget(rawTarget)) return rawTarget;

  for (let i = messages.length - 2; i >= 0; i--) {
    const candidate = extractPotentialEntityFromText(messages[i].content);
    if (candidate) return candidate;
  }
  return null;
}

function resolveCountTarget(input: string, messages: ChatMessage[]): string | null {
  const extracted = extractMentionCountTarget(input);
  const resolved = resolveMentionTarget(extracted, messages);
  if (resolved) return normalizeEntityTarget(resolved);
  const followup = extractCountFollowupCandidate(input);
  if (followup && isCountFollowupContext(messages)) return followup;
  return null;
}

function looksLikeMainCharacterQuestion(input: string): boolean {
  return /main character|main characters|primary character|protagonist/i.test(input);
}

function extractWhoIsTarget(input: string): string | null {
  const m = input.match(/\bwho is\s+["“”']?([^"“”'?\n]+?)["“”']?(?:\?|$)/i);
  if (!m?.[1]) return null;
  const value = m[1].trim().replace(/^(the|a|an)\s+/i, "").trim();
  return value.length >= 2 ? value : null;
}

function shouldBypassSpecialists(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text) return true;
  if (/^retry (specialist step|final synthesis) for:/i.test(text)) return false;
  if (/^(tell me|tell me please|please answer|answer please|continue|go on|finish the answer)\b/i.test(text)) {
    return false;
  }
  if (/\b(have you read|did you read|did you finish|have you finished)\b/.test(text)) {
    return true;
  }
  // Generic assistant / small-talk / capability questions should go straight to Claude.
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

function extractRetryQuestion(input: string): { step: "specialist" | "final"; question: string } | null {
  const m = input.match(/^retry (specialist step|final synthesis) for:\s*(.+)$/i);
  if (!m) return null;
  const step = /specialist/i.test(m[1]) ? "specialist" : "final";
  const question = (m[2] || "").trim();
  if (!question) return null;
  return { step, question };
}

function looksLikeLibraryCountQuestion(input: string): boolean {
  const text = input.toLowerCase();
  return (
    /(how many|number of|count)\s+books/.test(text) &&
    /(library|my books|books do i have|in total)/.test(text)
  );
}

function looksLikeHaveYouReadQuestion(input: string): boolean {
  const text = input.toLowerCase();
  return /\b(have you read|did you read|have you finished|did you finish)\b/.test(text)
    && /\b(book|books|this book|the book|library)\b/.test(text);
}

const FAMOUS_LIBRARIANS = [
  "Hypatia",
  "Borges",
  "Dewey",
  "Brewster",
  "Shirley",
  "Panizzi",
  "Ranganathan",
  "Aurelia",
];

function getLibrarianName(seed: string, idx = 0): string {
  const sum = seed.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) + idx;
  return FAMOUS_LIBRARIANS[sum % FAMOUS_LIBRARIANS.length];
}

function deriveMainCharacters(bookIds: string[]): { name: string; mentions: number; books: number }[] {
  const graph = getEntityGraph();
  const nodes = graph.nodes.filter(
    (n) =>
      n.type === "character" &&
      n.mentions >= 2 &&
      n.books.some((b) => bookIds.includes(b))
  );
  const weighted = nodes.map((n) => {
    const scopeBooks = n.books.filter((b) => bookIds.includes(b)).length;
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

interface SpecialistFinding {
  finding: string;
  location: string;
  evidence: string;
}

interface SpecialistAnswer {
  bookTitle: string;
  confidence: "high" | "medium" | "low";
  directAnswer: string;
  numericEstimate: number | null;
  findings: SpecialistFinding[];
  caveats: string[];
}

function buildRecentConversation(messages: ChatMessage[], maxMessages = 8): string {
  const slice = messages.slice(Math.max(0, messages.length - maxMessages));
  return slice
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");
}

function looksLikeThinAnswer(text: string): boolean {
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
  lines.push("## Specialist summary");
  lines.push(`- Confidence mix: high ${high}, medium ${medium}, low ${low}`);
  for (const s of specialists.slice(0, 5)) {
    const top = s.findings[0];
    lines.push(
      `- **${s.bookTitle}**: ${s.directAnswer}${top ? ` (evidence: ${top.location})` : ""}`
    );
  }
  lines.push("");
  lines.push("## Limitation");
  lines.push("- This fallback was used because the final synthesis step returned an incomplete answer.");
  return lines.join("\n");
}

async function synthesizeWhoIsAnswer(params: {
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

interface StreamSpecialistReport {
  bookTitle: string;
  confidence: "high" | "medium" | "low";
  numericEstimate: number | null;
  directAnswer: string;
  findingsCount: number;
  topFindings: { finding: string; location: string }[];
  caveats: string[];
  reasked?: boolean;
  scorecard?: {
    precisionEstimate: number;
    recallEstimate: number;
    total: number;
  };
}

function toSpecialistReports(
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

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

async function askBookSpecialist(params: {
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  modelId?: string;
}): Promise<SpecialistAnswer & { reasked?: boolean; scorecard?: StreamSpecialistReport["scorecard"] }> {
  const cacheKey = fingerprintQuestion(params.bookId, params.userQuestion);
  const cached = getCachedSpecialistAnswer(cacheKey);
  if (cached) {
    return {
      bookTitle: params.bookTitle,
      confidence: cached.confidence,
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

  const context = [
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
    const fallback = {
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
      confidence:
        parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
          ? parsed.confidence
          : "low",
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

    if (answer.confidence === "low") {
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
            confidence:
              retryParsed.confidence === "high" ||
              retryParsed.confidence === "medium" ||
              retryParsed.confidence === "low"
                ? retryParsed.confidence
                : answer.confidence,
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

async function orchestrateSpecialists(
  question: string,
  specialists: SpecialistAnswer[],
  modelId?: string
): Promise<string> {
  const payload = JSON.stringify(specialists);
  const prompt =
    `You are the orchestrator AI. Merge specialist outputs into one final response in Markdown. ` +
    `Include a comparison table, per-book findings, totals if numeric data exists, and explicit caveats. ` +
    `Do not invent facts not present in specialist payload.\n\n` +
    `User question: ${question}\n\nSpecialist outputs JSON:\n${payload}`;
  const text = await callClaudeText(prompt, 2500, 0.2, modelId);
  if (!text?.trim() || looksLikeThinAnswer(text)) {
    return buildFallbackFromSpecialists(question, specialists);
  }
  return text;
}

async function claudeNaturalAnswer(params: {
  userQuestion: string;
  factualAnswer: string;
  modelId?: string;
}): Promise<string> {
  const prompt = `You are Claude, a friendly librarian assistant inside a book app.
User asked: "${params.userQuestion}"

Facts you MUST preserve exactly:
${params.factualAnswer}

Instructions:
- Reply naturally like a human in 1-3 short sentences.
- Keep all numbers and factual claims exactly the same as provided.
- Do not add new facts.
- Do not use headings or tables unless the facts already require them.`;
  const text = await callClaudeText(prompt, 450, 0.25, params.modelId);
  return text?.trim() || params.factualAnswer;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const { bookId, bookTitle, messages } = (await request.json()) as {
      bookId: string;
      bookTitle: string;
      messages: ChatMessage[];
    };

    if (!bookId || !messages?.length) {
      return Response.json(
        { error: "Missing book ID or messages" },
        { status: 400 }
      );
    }

    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMessage) {
      return Response.json({ error: "No user message" }, { status: 400 });
    }
    logChatEvent("chat_request_received", {
      bookId,
      bookTitle,
      messageCount: messages.length,
      lastUserMessage: lastUserMessage.content.slice(0, 300),
    });

    const readable = new ReadableStream({
      async start(controller) {
        const send = (type: string, data: string) => {
          controller.enqueue(encoder.encode(`${type}:${data}\n`));
        };

        try {
          const emitAnswer = (text: string, meta?: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`TEXT:${text}\n`));
            logChatEvent("chat_answer_emitted", {
              bookId,
              chars: text.length,
              thin: looksLikeThinAnswer(text),
              ...meta,
            });
          };
          let systemPrompt: string;
          const aiSettings = loadSettings();
          const specialistModelId = aiSettings.modelRouting?.specialistModelId || BEDROCK_MODEL_ID;
          const orchestratorModelId = aiSettings.modelRouting?.orchestratorModelId || BEDROCK_MODEL_ID;
          const groundedMode = Boolean(aiSettings.groundedMode);

          interface Source {
            book: string;
            excerpt: string;
            position?: string;
          }
          const sources: Source[] = [];
          const retryQuestion = extractRetryQuestion(lastUserMessage.content);
          const questionText = retryQuestion?.question || lastUserMessage.content;
          if (retryQuestion) {
            logChatEvent("chat_retry_requested", {
              bookId,
              step: retryQuestion.step,
              originalInput: lastUserMessage.content.slice(0, 220),
              restoredQuestion: questionText.slice(0, 220),
            });
          }
          const mentionTargetRaw = extractMentionCountTarget(questionText);
          const mentionTarget = resolveCountTarget(questionText, messages);
          const recentConversation = buildRecentConversation(messages);
          const bookGroundedIntent = /\b(book|books|library|chapter|page|quote|character|theme|plot|series|mentioned|mentions|who is|in this book)\b/i.test(
            questionText
          );
          send("STATUS", "Claude is deciding whether specialist input is needed...");
          logChatEvent("claude_specialist_decision_started", {
            bookId,
            bookGroundedIntent,
            input: questionText.slice(0, 180),
          });
          logChatEvent("chat_pipeline_start", {
            bookId,
            mentionTargetRaw,
            mentionTargetResolved: mentionTarget,
            quoteLookup: looksLikeQuoteLookup(questionText),
            retryStep: retryQuestion?.step || null,
          });
          if (looksLikeMentionCountQuestion(questionText) && !mentionTarget) {
            emitAnswer("I can count mentions, but I need the exact name. Who should I count?", {
              reason: "missing_mention_target",
            });
            logChatEvent("mention_count_missing_target", {
              bookId,
              input: questionText.slice(0, 180),
            });
            controller.close();
            return;
          }

          if (/entity graph|relationship graph|who is connected/i.test(questionText)) {
            const graph = queryEntityGraph(questionText.replace(/entity graph|relationship graph/gi, "").trim());
            const lines: string[] = ["## Entity Graph Matches", ""];
            lines.push(`Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);
            for (const node of graph.nodes.slice(0, 20)) {
              lines.push(`- **${node.name}** (${node.type}) mentions: ${node.mentions}`);
            }
            emitAnswer(lines.join("\n"), { reason: "entity_graph" });
            controller.close();
            return;
          }
          if (/timeline conflict|chronology conflict|timeline issue/i.test(questionText)) {
            const conflicts = detectChronologyConflicts();
            const text = conflicts.length
              ? `## Timeline Conflicts\n\n${conflicts.map((c) => `- ${c}`).join("\n")}`
              : "## Timeline Conflicts\n\nNo obvious chronology conflicts detected.";
            emitAnswer(text, { reason: "timeline_conflict_check" });
            controller.close();
            return;
          }

          if (bookId === "all") {
            send("STATUS", "Searching across your entire library (semantic search)...");
            if (looksLikeHaveYouReadQuestion(questionText)) {
              const totalBooks = listBooks().length;
              const factual =
                totalBooks > 0
                  ? `Yes — I’ve indexed your uploaded library and can answer questions from it. Right now I can see **${totalBooks} book${totalBooks === 1 ? "" : "s"}**.`
                  : "Not yet — I don’t see any uploaded books in your library. Add a book and I can answer from it immediately.";
              const text = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: factual,
                modelId: orchestratorModelId,
              });
              emitAnswer(text, { reason: "have_you_read", scope: "all", usedSpecialists: false });
              controller.close();
              return;
            }
            if (looksLikeLibraryCountQuestion(questionText)) {
              const totalBooks = listBooks().length;
              const text =
                totalBooks === 0
                  ? "You currently have **0 books** in your library."
                  : `You currently have **${totalBooks} book${totalBooks === 1 ? "" : "s"}** in your library.`;
              const natural = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: text,
                modelId: orchestratorModelId,
              });
              emitAnswer(natural, { reason: "library_count", usedSpecialists: false });
              logChatEvent("library_count_answered", { totalBooks });
              controller.close();
              return;
            }
            const whoTarget = extractWhoIsTarget(questionText);
            if (whoTarget) {
              send("STATUS", `Looking up who "${whoTarget}" is in your library...`);
              const matches = searchAllBooksKeyword([whoTarget], 120);
              for (const hit of matches.slice(0, 30)) {
                sources.push({
                  book: hit.bookTitle,
                  excerpt: hit.snippet,
                  position: hit.label,
                });
              }
              const grouped = new Map<string, number>();
              for (const m of matches) grouped.set(m.bookTitle, (grouped.get(m.bookTitle) || 0) + 1);
              const topBook = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0];
              const scopeLabel = topBook?.[0]
                ? `your library (mostly in ${topBook[0]})`
                : "your library";
              const summary = await synthesizeWhoIsAnswer({
                target: whoTarget,
                scopeLabel,
                snippets: sources.map((s) => ({
                  book: s.book,
                  label: s.position || "Unknown location",
                  snippet: s.excerpt,
                })),
                conversationContext: recentConversation,
                modelId: orchestratorModelId,
              });
              const lines = [summary];
              controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              logChatEvent("who_is_answered", { scope: "all", whoTarget, matches: matches.length });
              controller.close();
              return;
            }
            if (!mentionTarget && shouldBypassSpecialists(questionText) && !bookGroundedIntent) {
              send("STATUS", "This is a general prompt — replying directly as your library assistant...");
              const directPrompt = `You are a friendly, practical digital librarian assistant.
Answer naturally like a real helpful person.
Do not claim you searched books unless the user asked for book-grounded evidence.
Use recent conversation context for follow-up references.
Recent conversation:
${recentConversation}
User message: ${questionText}`;
              const directText = await callClaudeText(directPrompt, 900, 0.4, orchestratorModelId);
              const final = directText || "I can help you explore your library, compare books, find quotes, count mentions, and summarize chapters with sources.";
              emitAnswer(final, { reason: "bypass_general_prompt", scope: "all", usedSpecialists: false });
              logChatEvent("specialist_bypass_general_prompt", { scope: "all", input: questionText.slice(0, 160) });
              controller.close();
              return;
            }

            const quotedText = extractQuotedText(questionText);
            const quoteMode = quotedText || (looksLikeQuoteLookup(questionText) ? questionText : null);
            if (looksLikeMainCharacterQuestion(questionText)) {
              const allIds = listBooks().map((b) => b.id);
              const mains = deriveMainCharacters(allIds);
              const lines: string[] = [];
              if (mains.length) {
                lines.push(
                  `Short answer: I detect about **${mains.length} main characters** across the current scope, based on repeated entity prominence in the text.`
                );
                lines.push("");
                lines.push("## Likely main characters");
                for (const m of mains) {
                  lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
                }
                for (const m of mains.slice(0, 5)) {
                  const matches = searchAllBooksKeyword([m.name], 4);
                  for (const hit of matches) {
                    sources.push({
                      book: hit.bookTitle,
                      excerpt: hit.snippet,
                      position: hit.label,
                    });
                  }
                }
              } else {
                lines.push(
                  "I couldn't confidently identify main characters yet. Try re-indexing this book or asking with a specific book selected."
                );
              }
              logChatEvent("main_character_answered", { scope: "all", count: mains.length });
              const natural = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: lines.join("\n"),
                modelId: orchestratorModelId,
              });
              emitAnswer(natural, { reason: "main_character", scope: "all", usedSpecialists: false });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (mentionTarget) {
              send("STATUS", `Counting mentions of "${mentionTarget}" across your library...`);
              const maxCountMatches = 3000;
              const mentionMatches = searchAllBooksKeyword([mentionTarget], maxCountMatches);
              const counts = new Map<string, number>();
              for (const m of mentionMatches) {
                counts.set(m.bookTitle, (counts.get(m.bookTitle) || 0) + 1);
              }
              const total = mentionMatches.length;
              const byBook = [...counts.entries()].sort((a, b) => b[1] - a[1]);
              for (const m of mentionMatches.slice(0, 60)) {
                sources.push({
                  book: m.bookTitle,
                  excerpt: m.snippet,
                  position: m.label,
                });
              }
              const lines: string[] = [];
              const capped = total >= maxCountMatches;
              lines.push(
                capped
                  ? `**${mentionTarget}** is mentioned at least **${total}** times across your current library.`
                  : `**${mentionTarget}** is mentioned **${total}** times across your current library.`
              );
              lines.push("");
              lines.push("## Breakdown by book");
              for (const [title, count] of byBook.slice(0, 20)) {
                lines.push(`- **${title}**: ${count} mention${count === 1 ? "" : "s"}`);
              }
              logChatEvent("mention_count_answered", { scope: "all", mentionTarget, total, books: byBook.length });
              const natural = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: lines.join("\n"),
                modelId: orchestratorModelId,
              });
              controller.enqueue(encoder.encode(`TEXT:${natural}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            if (!quoteMode) {
              send("STATUS", "Building specialist roster from your books...");
              const catalogBooks = listBooks();
              const seedPassages = await queryAllBooks(lastUserMessage.content, 40);
              const seenTitles = [...new Set(seedPassages.map((p) => p.bookTitle))];
              const chosenBooks = (seenTitles.length
                ? catalogBooks.filter((b) => seenTitles.includes(b.title))
                : catalogBooks
              ).slice(0, 8);

              if (!chosenBooks.length) {
                send("ERROR", "No books available for specialist analysis.");
                controller.close();
                return;
              }

              const roster = chosenBooks
                .slice(0, 4)
                .map((b, i) => `Librarian ${getLibrarianName(b.title, i)}`)
                .join(", ");
              send("STATUS", `Consulting ${chosenBooks.length} Librarian agents${roster ? `: ${roster}` : ""}...`);
              const specialistAnswers = await Promise.all(
                chosenBooks.map((b) =>
                  askBookSpecialist({
                    bookId: b.id,
                    bookTitle: b.title,
                    userQuestion: questionText,
                    modelId: specialistModelId,
                  })
                )
              );
              logChatEvent("specialists_completed", {
                scope: "all",
                count: specialistAnswers.length,
                lowConfidence: specialistAnswers.filter((s) => s.confidence === "low").length,
              });

              for (const ans of specialistAnswers) {
                for (const finding of ans.findings.slice(0, 6)) {
                  sources.push({
                    book: ans.bookTitle,
                    excerpt: finding.evidence || finding.finding,
                    position: finding.location,
                  });
                }
              }

              send("STATUS", "Main AI is merging specialist reports...");
              send("SPECIALISTS", JSON.stringify(toSpecialistReports(specialistAnswers)));
              const finalText = await orchestrateSpecialists(
                questionText,
                specialistAnswers,
                orchestratorModelId
              );
              logChatEvent("orchestrator_text_generated", {
                scope: "all",
                chars: finalText.length,
                thin: looksLikeThinAnswer(finalText),
              });
              emitAnswer(finalText, { reason: "orchestrated_specialists", scope: "all", usedSpecialists: true });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            const passagesPromise = queryAllBooks(questionText, 20);
            if (quoteMode) {
              send("STATUS", "Running exact quote lookup across all books...");
              const exactMatches = searchExactQuoteAllBooks(quoteMode, 120);
              if (exactMatches.length > 0) {
                send("STATUS", `Exact quote matches found: ${exactMatches.length}`);
                const grouped = new Map<string, { label: string; snippet: string }[]>();
                for (const m of exactMatches) {
                  if (!grouped.has(m.bookTitle)) grouped.set(m.bookTitle, []);
                  grouped.get(m.bookTitle)!.push({ label: m.label, snippet: m.snippet });
                  sources.push({
                    book: m.bookTitle,
                    excerpt: m.snippet,
                    position: m.label,
                  });
                }
                const lines: string[] = [];
                lines.push("## Exact Quote Matches");
                lines.push("");
                lines.push(`Found **${exactMatches.length}** matches across **${grouped.size}** book(s).`);
                for (const [title, entries] of grouped) {
                  lines.push("");
                  lines.push(`### ${title}`);
                  for (const entry of entries) {
                    lines.push(`- **${entry.label}**: ${entry.snippet}`);
                  }
                }
                emitAnswer(lines.join("\n"), { reason: "exact_quote", scope: "all" });
                send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
              send("STATUS", "No exact quote matches found in stored page text");
            }

            send("STATUS", "Running keyword search for exact matches...");
            const queryWords = questionText
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 5);
            const [passages, keywordMatches] = await Promise.all([
              passagesPromise,
              Promise.resolve(queryWords.length ? searchAllBooksKeyword(queryWords, 500) : []),
            ]);

            const totalFound = passages.length + keywordMatches.length;
            if (totalFound) {
              const bookNames = [
                ...new Set([
                  ...passages.map((p) => p.bookTitle),
                  ...keywordMatches.map((m) => m.bookTitle),
                ]),
              ];
              send(
                "STATUS",
                `Found ${passages.length} semantic + ${keywordMatches.length} keyword matches from ${bookNames.length} book${bookNames.length !== 1 ? "s" : ""}`
              );
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            let passageNum = 0;
            const contextParts: string[] = [];

            for (const p of passages) {
              passageNum++;
              sources.push({
                book: p.bookTitle,
                excerpt: p.text.slice(0, 200).replace(/\s+/g, " ").trim(),
                position: p.location,
              });
              contextParts.push(`[Passage ${passageNum} — from "${p.bookTitle}", ${p.location}]\n${p.text}`);
            }

            for (const m of keywordMatches) {
              passageNum++;
              sources.push({
                book: m.bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
              contextParts.push(`[Passage ${passageNum} — from "${m.bookTitle}", ${m.label}]\n${m.snippet}`);
            }

            const context = contextParts.length
              ? contextParts.join("\n\n---\n\n")
              : "(No relevant passages found across your library.)";

            systemPrompt = `You are a rigorous research assistant analyzing a library of books. You approach every question with academic precision and intellectual honesty.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, "${passages[0]?.bookTitle || "Book Title"}", Page X or Chapter Y). Always include the page/chapter location. Never state something without a citation.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting. Use phrases like "The text states..." vs. "This suggests..." or "One could interpret this as..."
4. When multiple passages or books address the same topic, COMPARE and CONTRAST them. Note agreements, contradictions, or different perspectives.
5. If the evidence is insufficient or ambiguous, say so explicitly. Never fill gaps with speculation presented as fact. If you suspect there may be MORE instances beyond the provided passages, say so.
6. Structure your response clearly: lead with a direct answer, then present the supporting evidence, then add any caveats or limitations.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

FORMATTING — you MUST use Markdown to structure your responses:
- Use **## headings** to separate major sections (e.g. "## Key Findings", "## Evidence", "## Limitations")
- Use **bullet points** (- or *) for listing evidence, characters, events, themes
- Use **bold** for book titles, character names, and key terms
- Use **> blockquotes** when directly quoting a passage
- Use tables when comparing data across books (e.g. | Book | Character | Fate |)
- Keep paragraphs short and scannable

Your tone should be thorough and analytical but still readable — like a knowledgeable research assistant, not a dry textbook.

Relevant passages from the user's library:

${context}`;
          } else if (bookId.startsWith("series:")) {
            const seriesId = bookId.replace("series:", "");
            const seriesEntry = listSeries().find((s) => s.id === seriesId);
            const seriesName = seriesEntry?.name || bookTitle;
            send("STATUS", `Searching series "${seriesName}" (semantic search)...`);
            if (looksLikeHaveYouReadQuestion(questionText)) {
              const seriesBooks = listBooks().filter((b) => seriesEntry?.bookIds.includes(b.id));
              const factual =
                seriesBooks.length > 0
                  ? `Yes — I’ve indexed the books in **${seriesName}** and can answer from them. I currently see **${seriesBooks.length}** book${seriesBooks.length === 1 ? "" : "s"} in this series.`
                  : `Not yet — I can’t find indexed books in **${seriesName}** yet.`;
              const text = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: factual,
                modelId: orchestratorModelId,
              });
              emitAnswer(text, { reason: "have_you_read", scope: "series", seriesId, usedSpecialists: false });
              controller.close();
              return;
            }
            const whoTarget = extractWhoIsTarget(questionText);
            if (whoTarget) {
              send("STATUS", `Looking up who "${whoTarget}" is in series "${seriesName}"...`);
              const matches = searchSeriesKeyword(seriesId, [whoTarget], 120);
              for (const hit of matches.slice(0, 30)) {
                sources.push({
                  book: hit.bookTitle,
                  excerpt: hit.snippet,
                  position: hit.label,
                });
              }
              const grouped = new Map<string, number>();
              for (const m of matches) grouped.set(m.bookTitle, (grouped.get(m.bookTitle) || 0) + 1);
              const topBook = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0];
              const scopeLabel = topBook?.[0]
                ? `series ${seriesName} (mostly in ${topBook[0]})`
                : `series ${seriesName}`;
              const summary = await synthesizeWhoIsAnswer({
                target: whoTarget,
                scopeLabel,
                snippets: sources.map((s) => ({
                  book: s.book,
                  label: s.position || "Unknown location",
                  snippet: s.excerpt,
                })),
                conversationContext: recentConversation,
                modelId: orchestratorModelId,
              });
              const lines = [summary];
              controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              logChatEvent("who_is_answered", { scope: "series", seriesId, whoTarget, matches: matches.length });
              controller.close();
              return;
            }
            if (!mentionTarget && shouldBypassSpecialists(questionText) && !bookGroundedIntent) {
              send("STATUS", "General prompt detected — replying directly without specialist fan-out...");
              const directPrompt = `You are a friendly librarian assistant helping with a selected series context (${seriesName}).
If the user is not asking for evidence from books, respond conversationally and briefly.
Use recent conversation context for follow-up references.
Recent conversation:
${recentConversation}
User message: ${questionText}`;
              const directText = await callClaudeText(directPrompt, 900, 0.4, orchestratorModelId);
              const final = directText || "I can help with this series — ask me about characters, themes, or specific evidence when you want citations.";
              emitAnswer(final, { reason: "bypass_general_prompt", scope: "series", usedSpecialists: false });
              logChatEvent("specialist_bypass_general_prompt", { scope: "series", seriesId, input: questionText.slice(0, 160) });
              controller.close();
              return;
            }

            const quotedText = extractQuotedText(questionText);
            const quoteMode = quotedText || (looksLikeQuoteLookup(questionText) ? questionText : null);
            if (looksLikeMainCharacterQuestion(questionText)) {
              const seriesBookIds = listSeries().find((s) => s.id === seriesId)?.bookIds || [];
              const mains = deriveMainCharacters(seriesBookIds);
              const lines: string[] = [];
              if (mains.length) {
                lines.push(
                  `Short answer: in **${seriesName}**, I detect about **${mains.length} main characters** from repeated prominence patterns.`
                );
                lines.push("");
                lines.push("## Likely main characters");
                for (const m of mains) {
                  lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
                }
                for (const m of mains.slice(0, 5)) {
                  const matches = searchSeriesKeyword(seriesId, [m.name], 4);
                  for (const hit of matches) {
                    sources.push({
                      book: hit.bookTitle,
                      excerpt: hit.snippet,
                      position: hit.label,
                    });
                  }
                }
              } else {
                lines.push("I couldn't confidently identify main characters in this series yet.");
              }
              logChatEvent("main_character_answered", { scope: "series", seriesId, count: mains.length });
              controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (mentionTarget) {
              send("STATUS", `Counting mentions of "${mentionTarget}" in series "${seriesName}"...`);
              const maxCountMatches = 3000;
              const mentionMatches = searchSeriesKeyword(seriesId, [mentionTarget], maxCountMatches);
              const counts = new Map<string, number>();
              for (const m of mentionMatches) {
                counts.set(m.bookTitle, (counts.get(m.bookTitle) || 0) + 1);
              }
              const total = mentionMatches.length;
              const byBook = [...counts.entries()].sort((a, b) => b[1] - a[1]);
              for (const m of mentionMatches.slice(0, 60)) {
                sources.push({
                  book: m.bookTitle,
                  excerpt: m.snippet,
                  position: m.label,
                });
              }
              const lines: string[] = [];
              const capped = total >= maxCountMatches;
              lines.push(
                capped
                  ? `In **${seriesName}**, **${mentionTarget}** is mentioned at least **${total}** times.`
                  : `In **${seriesName}**, **${mentionTarget}** is mentioned **${total}** times.`
              );
              lines.push("");
              lines.push("## Breakdown by book");
              for (const [title, count] of byBook.slice(0, 20)) {
                lines.push(`- **${title}**: ${count} mention${count === 1 ? "" : "s"}`);
              }
              logChatEvent("mention_count_answered", { scope: "series", seriesId, mentionTarget, total });
              controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            if (!quoteMode && seriesEntry) {
              const catalogBooks = listBooks().filter((b) => seriesEntry.bookIds.includes(b.id));
              if (catalogBooks.length) {
                const roster = catalogBooks
                  .slice(0, 4)
                  .map((b, i) => `Librarian ${getLibrarianName(b.title, i)}`)
                  .join(", ");
                send("STATUS", `Consulting ${catalogBooks.length} series Librarians${roster ? `: ${roster}` : ""}...`);
                const specialistAnswers = await Promise.all(
                  catalogBooks.map((b) =>
                    askBookSpecialist({
                      bookId: b.id,
                      bookTitle: b.title,
                    userQuestion: questionText,
                      modelId: specialistModelId,
                    })
                  )
                );
                logChatEvent("specialists_completed", {
                  scope: "series",
                  count: specialistAnswers.length,
                  lowConfidence: specialistAnswers.filter((s) => s.confidence === "low").length,
                });
                for (const ans of specialistAnswers) {
                  for (const finding of ans.findings.slice(0, 6)) {
                    sources.push({
                      book: ans.bookTitle,
                      excerpt: finding.evidence || finding.finding,
                      position: finding.location,
                    });
                  }
                }
                send("STATUS", "Main AI is merging specialist reports...");
                send("SPECIALISTS", JSON.stringify(toSpecialistReports(specialistAnswers)));
                const finalText = await orchestrateSpecialists(
                  questionText,
                  specialistAnswers,
                  orchestratorModelId
                );
                logChatEvent("orchestrator_text_generated", {
                  scope: "series",
                  chars: finalText.length,
                  thin: looksLikeThinAnswer(finalText),
                });
                emitAnswer(finalText, { reason: "orchestrated_specialists", scope: "series", usedSpecialists: true });
                if (sources.length) send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
            }

            const passagesPromise = querySeriesBooks(seriesId, questionText, 20);
            if (quoteMode) {
              send("STATUS", `Running exact quote lookup in series "${seriesName}"...`);
              const exactMatches = searchExactQuoteInSeries(seriesId, quoteMode, 90);
              if (exactMatches.length > 0) {
                send("STATUS", `Exact quote matches found: ${exactMatches.length}`);
                const grouped = new Map<string, { label: string; snippet: string }[]>();
                for (const m of exactMatches) {
                  if (!grouped.has(m.bookTitle)) grouped.set(m.bookTitle, []);
                  grouped.get(m.bookTitle)!.push({ label: m.label, snippet: m.snippet });
                  sources.push({
                    book: m.bookTitle,
                    excerpt: m.snippet,
                    position: m.label,
                  });
                }
                const lines: string[] = [];
                lines.push(`## Exact Quote Matches in ${seriesName}`);
                lines.push("");
                lines.push(`Found **${exactMatches.length}** matches across **${grouped.size}** book(s).`);
                for (const [title, entries] of grouped) {
                  lines.push("");
                  lines.push(`### ${title}`);
                  for (const entry of entries) {
                    lines.push(`- **${entry.label}**: ${entry.snippet}`);
                  }
                }
                controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
                send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
              send("STATUS", "No exact quote matches found in this series");
            }

            send("STATUS", "Running keyword search for exact matches...");
            const queryWords = questionText
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 5);
            const [passages, keywordMatches] = await Promise.all([
              passagesPromise,
              Promise.resolve(queryWords.length ? searchSeriesKeyword(seriesId, queryWords, 400) : []),
            ]);

            const totalFound = passages.length + keywordMatches.length;
            if (totalFound) {
              const bookNames = [
                ...new Set([
                  ...passages.map((p) => p.bookTitle),
                  ...keywordMatches.map((m) => m.bookTitle),
                ]),
              ];
              send(
                "STATUS",
                `Found ${passages.length} semantic + ${keywordMatches.length} keyword matches from ${bookNames.length} book${bookNames.length !== 1 ? "s" : ""} in this series`
              );
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            let passageNum = 0;
            const contextParts: string[] = [];

            for (const p of passages) {
              passageNum++;
              sources.push({
                book: p.bookTitle,
                excerpt: p.text.slice(0, 200).replace(/\s+/g, " ").trim(),
                position: p.location,
              });
              contextParts.push(`[Passage ${passageNum} — from "${p.bookTitle}", ${p.location}]\n${p.text}`);
            }

            for (const m of keywordMatches) {
              passageNum++;
              sources.push({
                book: m.bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
              contextParts.push(`[Passage ${passageNum} — from "${m.bookTitle}", ${m.label}]\n${m.snippet}`);
            }

            const context = contextParts.length
              ? contextParts.join("\n\n---\n\n")
              : `(No relevant passages found for series "${seriesName}".)`;

            systemPrompt = `You are a rigorous research assistant analyzing the series "${seriesName}". You approach every question with academic precision and intellectual honesty.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, "Book Title", Page X or Chapter Y). Always include both book title and location.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting.
4. Compare how the books in the series agree or differ when relevant.
5. If evidence is insufficient or ambiguous, say so explicitly.
6. Structure your response with a direct answer, supporting evidence, then caveats.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

FORMATTING — use Markdown with headings and bullet points.

Relevant passages from series "${seriesName}":

${context}`;
          } else {
            send("STATUS", `Searching "${bookTitle}" (semantic search)...`);
            if (looksLikeHaveYouReadQuestion(questionText)) {
              const selected = getBookById(bookId);
              const factual = selected
                ? `Yes — I’ve indexed **${selected.title}** and can answer questions about it.`
                : "I don’t have that selected book indexed yet. Re-add or re-index it and I can answer immediately.";
              const text = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: factual,
                modelId: orchestratorModelId,
              });
              emitAnswer(text, { reason: "have_you_read", scope: "book", bookId, usedSpecialists: false });
              controller.close();
              return;
            }
            const whoTarget = extractWhoIsTarget(questionText);
            if (whoTarget) {
              send("STATUS", `Looking up who "${whoTarget}" is in "${bookTitle}"...`);
              const matches = searchBookKeyword(bookId, [whoTarget], 120);
              for (const hit of matches.slice(0, 30)) {
                sources.push({
                  book: bookTitle,
                  excerpt: hit.snippet,
                  position: hit.label,
                });
              }
              const summary = await synthesizeWhoIsAnswer({
                target: whoTarget,
                scopeLabel: `book ${bookTitle}`,
                snippets: sources.map((s) => ({
                  book: s.book,
                  label: s.position || "Unknown location",
                  snippet: s.excerpt,
                })),
                conversationContext: recentConversation,
                modelId: orchestratorModelId,
              });
              const lines = [summary];
              controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              logChatEvent("who_is_answered", { scope: "book", bookId, whoTarget, matches: matches.length });
              controller.close();
              return;
            }
            if (!mentionTarget && shouldBypassSpecialists(questionText) && !bookGroundedIntent) {
              send("STATUS", "General prompt detected — replying directly as Claude...");
              const directPrompt = `You are a friendly librarian assistant helping with one selected book (${bookTitle}).
If user asks generally, answer naturally first.
If they ask for evidence, then use citations.
Use recent conversation context for follow-up references.
Recent conversation:
${recentConversation}
User message: ${questionText}`;
              const directText = await callClaudeText(directPrompt, 900, 0.4, orchestratorModelId);
              const final = directText || "Sure — I can help with summaries, character overviews, themes, quotes, and exact evidence from this book.";
              emitAnswer(final, { reason: "bypass_general_prompt", scope: "book", usedSpecialists: false });
              logChatEvent("specialist_bypass_general_prompt", { scope: "book", bookId, input: questionText.slice(0, 160) });
              controller.close();
              return;
            }

            const quotedText = extractQuotedText(questionText);
            const quoteMode = quotedText || (looksLikeQuoteLookup(questionText) ? questionText : null);
            if (looksLikeMainCharacterQuestion(questionText)) {
              const mains = deriveMainCharacters([bookId]);
              const lines: string[] = [];
              if (mains.length) {
                lines.push(
                  `Short answer: in **${bookTitle}**, I detect about **${mains.length} main characters** by repeated prominence in the text.`
                );
                lines.push("");
                lines.push("## Likely main characters");
                for (const m of mains) {
                  lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
                }
                for (const m of mains.slice(0, 5)) {
                  const matches = searchBookKeyword(bookId, [m.name], 4);
                  for (const hit of matches) {
                    sources.push({
                      book: bookTitle,
                      excerpt: hit.snippet,
                      position: hit.label,
                    });
                  }
                }
              } else {
                lines.push("I couldn't confidently identify the main characters yet for this book.");
              }
              logChatEvent("main_character_answered", { scope: "book", bookId, count: mains.length });
              controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (mentionTarget) {
              send("STATUS", `Counting mentions of "${mentionTarget}" in "${bookTitle}"...`);
              const maxCountMatches = 3000;
              const mentionMatches = searchBookKeyword(bookId, [mentionTarget], maxCountMatches);
              const total = mentionMatches.length;
              for (const m of mentionMatches.slice(0, 80)) {
                sources.push({
                  book: bookTitle,
                  excerpt: m.snippet,
                  position: m.label,
                });
              }
              const text =
                total > 0
                  ? total >= maxCountMatches
                    ? `In **${bookTitle}**, **${mentionTarget}** is mentioned at least **${total}** times.\n\nI based this on direct keyword matches in the indexed text.`
                    : `In **${bookTitle}**, **${mentionTarget}** is mentioned **${total}** times.\n\nI based this on direct keyword matches in the indexed text.`
                  : `I couldn't find any mentions of **${mentionTarget}** in the indexed text for this book.`;
              logChatEvent("mention_count_answered", { scope: "book", bookId, mentionTarget, total });
              const natural = await claudeNaturalAnswer({
                userQuestion: questionText,
                factualAnswer: text,
                modelId: orchestratorModelId,
              });
              controller.enqueue(encoder.encode(`TEXT:${natural}\n`));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (!quoteMode) {
              send("STATUS", `Consulting Librarian ${getLibrarianName(bookTitle)} for "${bookTitle}"...`);
              const specialistAnswer = await askBookSpecialist({
                bookId,
                bookTitle,
                userQuestion: questionText,
                modelId: specialistModelId,
              });
              logChatEvent("specialist_completed", {
                scope: "book",
                bookId,
                confidence: specialistAnswer.confidence,
                findings: specialistAnswer.findings.length,
              });
              for (const finding of specialistAnswer.findings.slice(0, 10)) {
                sources.push({
                  book: specialistAnswer.bookTitle,
                  excerpt: finding.evidence || finding.finding,
                  position: finding.location,
                });
              }
              send("STATUS", "Main AI is composing final answer...");
              send("SPECIALISTS", JSON.stringify(toSpecialistReports([specialistAnswer])));
              const finalText = await orchestrateSpecialists(
                questionText,
                [specialistAnswer],
                orchestratorModelId
              );
              logChatEvent("orchestrator_text_generated", {
                scope: "book",
                chars: finalText.length,
                thin: looksLikeThinAnswer(finalText),
              });
              emitAnswer(finalText, { reason: "orchestrated_specialists", scope: "book", usedSpecialists: true });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            const relevantChunksPromise = queryBook(bookId, questionText, 20);
            if (quoteMode) {
              send("STATUS", "Running exact quote lookup in this book...");
              const exactMatches = searchExactQuoteInBook(bookId, quoteMode, 70);
              if (exactMatches.length > 0) {
                send("STATUS", `Exact quote matches found: ${exactMatches.length}`);
                const lines: string[] = [];
                lines.push(`## Exact Quote Matches in ${bookTitle}`);
                lines.push("");
                lines.push(`Found **${exactMatches.length}** matches.`);
                for (const m of exactMatches) {
                  lines.push(`- **${m.label}**: ${m.snippet}`);
                  sources.push({
                    book: bookTitle,
                    excerpt: m.snippet,
                    position: m.label,
                  });
                }
                controller.enqueue(encoder.encode(`TEXT:${lines.join("\n")}\n`));
                send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
              send("STATUS", "No exact quote matches found in this book");
            }

            send("STATUS", "Running keyword search for exact matches...");
            const queryWords = questionText
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 5);
            const [relevantChunks, keywordMatches] = await Promise.all([
              relevantChunksPromise,
              Promise.resolve(queryWords.length ? searchBookKeyword(bookId, queryWords, 300) : []),
            ]);

            const totalFound = relevantChunks.length + keywordMatches.length;
            if (totalFound) {
              send("STATUS", `Found ${relevantChunks.length} semantic + ${keywordMatches.length} keyword matches`);
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            let passageNum = 0;
            const contextParts: string[] = [];

            for (const passage of relevantChunks) {
              passageNum++;
              sources.push({
                book: bookTitle,
                excerpt: passage.text.slice(0, 200).replace(/\s+/g, " ").trim(),
                position: passage.location,
              });
              contextParts.push(`[Passage ${passageNum}, ${passage.location}]\n${passage.text}`);
            }

            for (const m of keywordMatches) {
              passageNum++;
              sources.push({
                book: bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
              contextParts.push(`[Passage ${passageNum}, ${m.label}]\n${m.snippet}`);
            }

            const context = contextParts.length
              ? contextParts.join("\n\n---\n\n")
              : "(No relevant passages found for this question.)";

            systemPrompt = `You are a rigorous research assistant analyzing the book "${bookTitle}". You approach every question with academic precision and intellectual honesty.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, Page X or Chapter Y). Always include the page/chapter location from the passage header. Never state something without a citation.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting. Use phrases like "The text states..." vs. "This suggests..." or "One could interpret this as..."
4. When multiple passages address the same topic, SYNTHESIZE them. Note if they reinforce, expand on, or contradict each other.
5. If the evidence is insufficient or ambiguous, say so explicitly. Never fill gaps with speculation presented as fact. If you suspect there may be MORE instances beyond the provided passages, say so.
6. Structure your response clearly: lead with a direct answer, then present the supporting evidence, then add any caveats or limitations.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

FORMATTING — you MUST use Markdown to structure your responses:
- Use **## headings** to separate major sections (e.g. "## Key Findings", "## Evidence", "## Limitations")
- Use **bullet points** (- or *) for listing evidence, characters, events, themes
- Use **bold** for character names, key terms, and important concepts
- Use **> blockquotes** when directly quoting a passage
- Use tables when comparing data (e.g. | Character | Role | Fate |)
- Keep paragraphs short and scannable

Your tone should be thorough and analytical but still readable — like a knowledgeable research assistant, not a dry textbook.

Relevant passages from "${bookTitle}":

${context}`;
          }

          const toneMap: Record<string, string> = {
            Scientific: "Use a rigorous, evidence-first, analytical style.",
            Casual: "Use a warm, conversational, easy-to-read style.",
            "Teacher-like": "Explain clearly and pedagogically, as if teaching a student.",
            Concise: "Be brief and direct while preserving factual accuracy.",
            Custom: "Follow the user's custom instructions very closely.",
          };
          const settingsInstructions: string[] = [];
          settingsInstructions.push(
            "Write like a helpful librarian: natural, warm, and clear. Start with a plain sentence before structured details."
          );
          if (aiSettings.language && aiSettings.language !== "Auto") {
            settingsInstructions.push(`You MUST respond entirely in ${aiSettings.language}.`);
          }
          if (aiSettings.tone) {
            settingsInstructions.push(toneMap[aiSettings.tone] || toneMap.Scientific);
          }
          if (aiSettings.focusAreas?.length) {
            settingsInstructions.push(
              `Pay special attention to these topics: ${aiSettings.focusAreas.join(", ")}.`
            );
          }
          if (aiSettings.customInstructions?.trim()) {
            settingsInstructions.push(`Additional user instructions: ${aiSettings.customInstructions.trim()}`);
          }
          if (settingsInstructions.length) {
            systemPrompt += `\n\nUSER PERSONALITY SETTINGS:\n- ${settingsInstructions.join("\n- ")}`;
          }

          send("STATUS", `Building context from ${sources.length} passage${sources.length !== 1 ? "s" : ""} (${(systemPrompt.length / 1000).toFixed(1)}k characters)...`);

          const conversation = messages
            .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
            .join("\n\n");
          const finalPrompt = `${systemPrompt}\n\nConversation so far:\n${conversation}`;

          send("STATUS", "Sending to Claude on Bedrock — reading passages and reasoning...");
          const streamStart = Date.now();
          let finalText = await callClaudeText(finalPrompt, 2500, 0.2, orchestratorModelId);
          if (groundedMode) {
            const hasCitation = /\(Passage\s+\d+/i.test(finalText) || /\bPage\s+\d+/i.test(finalText) || /\bChapter\s+\d+/i.test(finalText);
            if (!hasCitation || sources.length === 0) {
              finalText = "insufficient evidence";
              send("STATUS", "Grounded mode blocked unsupported answer.");
            }
          }
          send(
            "WHY",
            JSON.stringify({
              groundedMode,
              sourceCount: sources.length,
              specialistModelId,
              orchestratorModelId,
            })
          );
          controller.enqueue(encoder.encode(`TEXT:${finalText}\n`));
          logChatEvent("chat_answer_completed", {
            bookId,
            groundedMode,
            sources: sources.length,
            answerChars: finalText.length,
          });
          const totalTime = ((Date.now() - streamStart) / 1000).toFixed(1);
          send("STATUS", `Done — response generated in ${totalTime}s`);

          if (sources.length) {
            send("SOURCES", JSON.stringify(sources));
          }

          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          const msg = error instanceof Error ? error.message : String(error);
          logChatEvent("chat_stream_error", { bookId, error: msg });
          if (/ExpiredToken|credentials|Unable to locate credentials|Forbidden|AccessDenied/i.test(msg)) {
            send(
              "ERROR",
              "Failed to generate response. AWS credentials or Bedrock permissions are invalid/expired. Run AWS login again and verify model access."
            );
          } else {
            send("ERROR", "Failed to generate response. " + msg);
          }
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Chat error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    logChatEvent("chat_request_error", { error: msg });

    return Response.json(
      { error: "Failed to generate response. " + msg },
      { status: 500 }
    );
  }
}
