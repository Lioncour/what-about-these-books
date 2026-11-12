import { NextResponse } from "next/server";
import { InvalidIdError, isPublicMode } from "@/lib/runtime-config";

/**
 * Returns a 403 response when PUBLIC_MODE is on, else null.
 * Use at the top of every route handler that mutates data or spends money.
 */
export function publicModeBlocked(what = "This action"): NextResponse | null {
  if (!isPublicMode) return null;
  return NextResponse.json({ error: `${what} is disabled in public mode.` }, { status: 403 });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Map a store error to a response: InvalidIdError → 400, anything else → fallback 500. */
export function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof InvalidIdError) return badRequest(error.message);
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
