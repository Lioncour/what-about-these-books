import { listBooks } from "@/lib/book-store";
import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { claudeNaturalAnswer } from "@/lib/chat/orchestrator";

function natural(ctx: ChatContext, factualAnswer: string): Promise<string> {
  return claudeNaturalAnswer({
    userQuestion: ctx.question,
    factualAnswer,
    modelId: ctx.settings.orchestratorModelId,
    companionMode: ctx.settings.companionMode,
    signal: ctx.signal,
  });
}

/** "Have you read these?" — what the catalog holds for this scope, in the friend's voice. */
export async function haveYouReadStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.route.kind !== "have_you_read") return false;

  ctx.announceScope();
  const text = await natural(ctx, ctx.scope.text.coverage());
  ctx.emitAnswer(text, { reason: "have_you_read", scope: ctx.scope.kind, usedSpecialists: false });
  return true;
}

/**
 * "How many books do I have?" — only with the whole library in focus; inside a series or
 * a book the question goes on to the specialists (as it always has).
 */
export async function libraryCountStep(ctx: ChatContext): Promise<boolean> {
  if (ctx.route.kind !== "library_count" || ctx.scope.kind !== "all") return false;

  ctx.announceScope();
  const total = listBooks().length;
  const facts =
    total === 0
      ? "You currently have **0 books** in your library."
      : `You currently have **${total} book${total === 1 ? "" : "s"}** in your library.`;
  ctx.emitAnswer(await natural(ctx, facts), { reason: "library_count", usedSpecialists: false });
  logChatEvent("library_count_answered", { totalBooks: total });
  return true;
}
