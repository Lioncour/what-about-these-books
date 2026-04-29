import { NextRequest, NextResponse } from "next/server";
import { readRecentChatLogs } from "@/lib/chat-debug";

export async function GET(request: NextRequest) {
  const lines = Number(request.nextUrl.searchParams.get("lines") || 200);
  const safeLines = Number.isFinite(lines) ? Math.max(1, Math.min(2000, lines)) : 200;
  return NextResponse.json({ logs: readRecentChatLogs(safeLines) });
}
