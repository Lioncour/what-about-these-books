import { NextResponse } from "next/server";
import { listSpecialistScorecards } from "@/lib/quality-store";

export async function GET() {
  return NextResponse.json({ scorecards: listSpecialistScorecards() });
}
