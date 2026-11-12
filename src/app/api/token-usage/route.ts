import { NextRequest, NextResponse } from "next/server";
import { getTokenUsageSummary, resetTokenUsage } from "@/lib/token-usage-store";
import { publicModeBlocked } from "@/lib/api-guard";

export async function GET() {
  return NextResponse.json(getTokenUsageSummary());
}

export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Resetting token usage");
  if (blocked) return blocked;
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === "reset") {
      resetTokenUsage();
      return NextResponse.json({ ok: true, usage: getTokenUsageSummary() });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Token usage POST error:", error);
    return NextResponse.json({ error: "Failed to update token usage" }, { status: 500 });
  }
}
