import { NextRequest, NextResponse } from "next/server";
import { runEvalHarness } from "@/lib/eval-harness";
import { runChatEval } from "@/lib/chat-eval";
import { publicModeBlocked } from "@/lib/api-guard";

export const maxDuration = 600;

/** Retrieval eval (eval/gold-questions.json): embeds each question, no Claude. */
export async function GET() {
  const blocked = publicModeBlocked("Running the eval harness");
  if (blocked) return blocked;
  const report = await runEvalHarness();
  return NextResponse.json(report);
}

/**
 * Chat eval (eval/chat-cases.json): `{ "live"?: boolean, "ids"?: string[] }`.
 * Dry by default (Claude calls counted, not made); `live` spends real tokens.
 */
export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Running the chat eval");
  if (blocked) return blocked;
  try {
    const body = (await request.json().catch(() => ({}))) as { live?: unknown; ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : undefined;
    const report = await runChatEval({ live: body.live === true, ids });
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
