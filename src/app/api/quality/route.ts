import { NextResponse } from "next/server";
import { listSpecialistScorecards } from "@/lib/quality-store";
import { readRecentChatLogs } from "@/lib/chat-debug";

export async function GET() {
  const logs = readRecentChatLogs(2000)
    .map((line) => {
      try {
        return JSON.parse(line) as { event?: string; payload?: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((x): x is { event?: string; payload?: Record<string, unknown> } => Boolean(x));
  const emitted = logs.filter((l) => l.event === "chat_answer_emitted");
  const retries = logs.filter((l) => l.event === "chat_retry_requested").length;
  const bypasses = logs.filter((l) => l.event === "specialist_bypass_general_prompt").length;
  const thin = emitted.filter((l) => Boolean(l.payload?.thin)).length;
  const byScope = ["all", "series", "book"].map((scope) => {
    const rows = emitted.filter((l) => (l.payload?.scope as string) === scope);
    return {
      scope,
      total: rows.length,
      thin: rows.filter((r) => Boolean(r.payload?.thin)).length,
      avgChars: rows.length
        ? Math.round(rows.reduce((sum, r) => sum + Number(r.payload?.chars || 0), 0) / rows.length)
        : 0,
    };
  });
  return NextResponse.json({
    scorecards: listSpecialistScorecards(),
    summary: {
      totalAnswers: emitted.length,
      thinAnswerRate: emitted.length ? Number((thin / emitted.length).toFixed(3)) : 0,
      retryRequests: retries,
      bypasses,
    },
    byScope,
  });
}
