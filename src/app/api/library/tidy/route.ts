import { NextRequest, NextResponse } from "next/server";
import { tidyLibrary } from "@/lib/book-store";
import { errorResponse, publicModeBlocked } from "@/lib/api-guard";

/**
 * POST /api/library/tidy  body: { "dryRun"?: boolean }
 * → { titles: [{ id, from, to }], labels: [{ id, title, changed }], dryRun }
 *
 * Cleans display titles and EPUB chapter labels of the books already in the library.
 * A dry run reports what would change; a real run takes a backup snapshot first.
 */
export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Tidying the library");
  if (blocked) return blocked;
  let dryRun = false;
  try {
    const body: unknown = await request.json().catch(() => null);
    dryRun = !!body && typeof body === "object" && (body as { dryRun?: unknown }).dryRun === true;
    return NextResponse.json(tidyLibrary({ dryRun }));
  } catch (error) {
    return errorResponse(error, dryRun ? "Failed to preview the library tidy" : "Failed to tidy the library");
  }
}
