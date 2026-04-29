import { NextRequest, NextResponse } from "next/server";
import { getReindexState, startFullReindex } from "@/lib/reindex-manager";

export async function GET() {
  return NextResponse.json(getReindexState());
}

export async function POST(_request: NextRequest) {
  const state = await startFullReindex();
  return NextResponse.json(state);
}
