import { callClaudeStream, callClaudeText } from "@/lib/bedrock-claude";
import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { extractKeywords } from "@/lib/chat/intent";
import { voicePreamble } from "@/lib/chat/response-formatting";
import { resolveSpecialistModel } from "@/lib/chat/specialist-model";
import type { ChatSource } from "@/lib/chat/types";

/** Keyword snippets appended to the prompt after the semantic passages. */
const MAX_KEYWORD_SNIPPETS = 40;
const SEMANTIC_PASSAGES = 20;

const CITATION = [/\(Passage\s+\d+/i, /\bPage\s+\d+/i, /\bChapter\s+\d+/i];

/**
 * Last resort (an exact quote that wasn't found, a series without books): semantic +
 * keyword passages in one prompt, one cited answer. Always answers.
 */
export async function ragStep(ctx: ChatContext): Promise<boolean> {
  const { scope, settings } = ctx;
  const copy = scope.text.rag;

  ctx.announceScope();
  ctx.status("Running keyword search for exact matches...");
  const words = extractKeywords(ctx.question);
  const passages = await scope.semantic(ctx.question, SEMANTIC_PASSAGES);
  const keywordMatches = words.length ? scope.keyword(words, MAX_KEYWORD_SNIPPETS) : [];

  if (passages.length + keywordMatches.length) {
    const titles = new Set([...passages.map((p) => p.bookTitle), ...keywordMatches.map((m) => m.bookTitle)]);
    ctx.status(copy.found(passages.length, keywordMatches.length, titles.size));
  } else {
    ctx.status("No closely matching passages found — the AI will do its best");
  }

  const sources: ChatSource[] = [];
  const contextParts: string[] = [];
  for (const p of passages) {
    sources.push({ book: p.bookTitle, excerpt: p.text.slice(0, 200).replace(/\s+/g, " ").trim(), position: p.location });
    contextParts.push(`${copy.passageHeader(sources.length, p.bookTitle, p.location)}\n${p.text}`);
  }
  for (const m of keywordMatches.slice(0, MAX_KEYWORD_SNIPPETS)) {
    sources.push({ book: m.bookTitle, excerpt: m.snippet, position: m.label });
    contextParts.push(`${copy.passageHeader(sources.length, m.bookTitle, m.label)}\n${m.snippet}`);
  }

  const system =
    copy.system({
      citeTitle: passages[0]?.bookTitle,
      voice: voicePreamble(settings.companionMode),
      context: contextParts.length ? contextParts.join("\n\n---\n\n") : copy.noPassages,
    }) + `\n\nUSER PERSONALITY SETTINGS:\n${settings.personality()}`;

  ctx.status(
    `Building context from ${sources.length} passage${sources.length !== 1 ? "s" : ""} (${(system.length / 1000).toFixed(1)}k characters)...`
  );
  const conversation = (settings.ai.useConversationMemory === false ? [ctx.lastUserMessage] : ctx.messages)
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join("\n\n");
  // The system prompt goes in the Messages API `system` field; the conversation is the user turn.
  const prompt = `Conversation so far:\n${conversation}`;
  const callOpts = { system, signal: ctx.signal };
  const { orchestratorModelId, groundedMode } = settings;

  ctx.status("Sending to Claude on Bedrock — reading passages and reasoning...");
  ctx.checkpoint();
  const started = Date.now();
  let answer: string;
  if (groundedMode) {
    // The grounded gate needs the whole text before anything is shown.
    answer = await callClaudeText(prompt, 2500, 0.2, orchestratorModelId, callOpts);
    if (!CITATION.some((re) => re.test(answer)) || sources.length === 0) {
      answer = "insufficient evidence";
      ctx.status("Grounded mode blocked unsupported answer.");
    }
    ctx.emitToken(answer);
  } else {
    answer = await callClaudeStream(prompt, ctx.emitToken, 2500, 0.2, orchestratorModelId, callOpts);
  }

  ctx.send(
    "WHY",
    JSON.stringify({
      groundedMode,
      sourceCount: sources.length,
      specialistModelId: resolveSpecialistModel(settings.specialistModelId),
      orchestratorModelId,
    })
  );
  logChatEvent("chat_answer_completed", {
    bookId: ctx.bookId,
    groundedMode,
    sources: sources.length,
    answerChars: answer.length,
  });
  ctx.status(`Done — response generated in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  ctx.sendSources(sources);
  return true;
}
