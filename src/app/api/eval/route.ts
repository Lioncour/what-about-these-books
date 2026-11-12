import { NextResponse } from "next/server";
import { runEvalHarness } from "@/lib/eval-harness";
import { publicModeBlocked } from "@/lib/api-guard";

export async function GET() {
  const blocked = publicModeBlocked("Running the eval harness");
  if (blocked) return blocked;
  const report = await runEvalHarness();
  return NextResponse.json(report);
}
