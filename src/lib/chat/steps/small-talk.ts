import { callClaudeText } from "@/lib/bedrock-claude";
import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";

const BOOK_GROUNDED =
  /\b(book|books|library|chapter|page|quote|character|theme|plot|series|mentioned|mentions|who is|in this book)\b/i;

/** Greetings and "what can you do?" — answered directly, without reading any book. */
export async function smallTalkStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.mentionTarget || ctx.route.kind !== "bypass_general" || BOOK_GROUNDED.test(ctx.question)) return false;

  const copy = ctx.scope.text.smallTalk;
  ctx.status(copy.status);
  const reply = await callClaudeText(
    copy.prompt(ctx.recentConversation, ctx.question),
    900,
    0.4,
    ctx.settings.orchestratorModelId,
    { signal: ctx.signal }
  );
  ctx.emitAnswer(reply || copy.fallback, {
    reason: "bypass_general_prompt",
    scope: ctx.scope.kind,
    usedSpecialists: false,
  });
  logChatEvent("specialist_bypass_general_prompt", { scope: ctx.scope.kind, input: ctx.question.slice(0, 160) });
  return true;
}
