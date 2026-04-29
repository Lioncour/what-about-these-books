import { NextResponse } from "next/server";
import { runEvalHarness } from "@/lib/eval-harness";

export async function GET() {
  const report = await runEvalHarness();
  return NextResponse.json(report);
}
