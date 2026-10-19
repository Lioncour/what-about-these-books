import { NextResponse } from "next/server";
import { getReindexState, startFullReindex } from "@/lib/reindex-manager";

export async function GET() {
  return NextResponse.json(getReindexState());
}

export async function POST() {
  const state = await startFullReindex();
  return NextResponse.json(state);
}
