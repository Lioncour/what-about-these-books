import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import { executeLibraryCommand, resolveLibraryCommand } from "@/lib/chat/library-commands";

/** "list my books", "@remove all books@" … — handled before any routing. */
export async function libraryCommandStep(ctx: ChatContext): Promise<boolean> {
  const command = resolveLibraryCommand(ctx.lastUserMessage.content, ctx.question);
  if (!command) return false;

  ctx.status("Running library command...");
  const result = await executeLibraryCommand(command, {
    focusBookId: ctx.scope.kind === "book" ? ctx.bookId : undefined,
  });
  ctx.emitAnswer(result.message, { reason: "library_command", command: command.type });
  if (result.libraryChanged) {
    ctx.send("LIBRARY_CHANGED", JSON.stringify({ clearFocus: Boolean(result.clearFocus) }));
  }
  logChatEvent("library_command_executed", { command: command.type, libraryChanged: result.libraryChanged });
  return true;
}
