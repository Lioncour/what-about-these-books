import { NextRequest, NextResponse } from "next/server";
import { getCoverPath, isValidBookId, MAX_COVER_BYTES, replaceCover } from "@/lib/book-store";
import { errorResponse, publicModeBlocked } from "@/lib/api-guard";
import { readFileSync, statSync } from "fs";

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * The cover image. A URL with a `?v=` query is treated as versioned and may be cached
 * for good; without it the browser must revalidate (ETag from the file's time and
 * size), so a replaced cover is never shown stale.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> }
) {
  const { bookId } = await params;
  if (!isValidBookId(bookId)) {
    return NextResponse.json({ error: "Invalid book id" }, { status: 400 });
  }
  const coverPath = getCoverPath(bookId);

  if (!coverPath) {
    return NextResponse.json({ error: "No cover found" }, { status: 404 });
  }

  const st = statSync(coverPath);
  const etag = `"${Math.round(st.mtimeMs).toString(36)}-${st.size.toString(36)}"`;
  const cacheControl = request.nextUrl.searchParams.has("v")
    ? "private, max-age=31536000, immutable"
    : "private, no-cache";
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  const ext = coverPath.split(".").pop()?.toLowerCase() || "jpg";
  const contentType = MIME_TYPES[ext] || "image/jpeg";
  const buffer = readFileSync(coverPath);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Replace the cover: multipart form with a `file` field (PNG, JPEG or WebP by its
 * first bytes, at most 5 MB) → `{ "ok": true }`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> }
) {
  const blocked = publicModeBlocked("Changing covers");
  if (blocked) return blocked;
  try {
    const { bookId } = await params;
    if (!isValidBookId(bookId)) return NextResponse.json({ error: "Invalid book id" }, { status: 400 });
    // Refuse an oversized body before reading it (the form adds a little to the file).
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_COVER_BYTES + 64 * 1024) {
      return NextResponse.json({ error: "The cover can be at most 5 MB" }, { status: 400 });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "Send the image as the form field \"file\"" }, { status: 400 });
    }
    if (file.size > MAX_COVER_BYTES) {
      return NextResponse.json({ error: "The cover can be at most 5 MB" }, { status: 400 });
    }
    const result = replaceCover(bookId, Buffer.from(await file.arrayBuffer()));
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Failed to save the cover");
  }
}
