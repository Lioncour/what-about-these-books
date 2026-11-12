import { NextResponse } from "next/server";
import { getReindexState, startFullReindex } from "@/lib/reindex-manager";
import { publicModeBlocked } from "@/lib/api-guard";

export async function GET() {
  return NextResponse.json(getReindexState());
}

export async function POST() {
  const blocked = publicModeBlocked("Re-indexing");
  if (blocked) return blocked;
  const state = await startFullReindex();
  return NextResponse.json(state);
}
