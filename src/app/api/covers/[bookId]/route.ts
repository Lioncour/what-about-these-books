import { NextRequest, NextResponse } from "next/server";
import { getCoverPath } from "@/lib/book-store";
import { readFileSync } from "fs";

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> }
) {
  const { bookId } = await params;
  const coverPath = getCoverPath(bookId);

  if (!coverPath) {
    return NextResponse.json({ error: "No cover found" }, { status: 404 });
  }

  const ext = coverPath.split(".").pop()?.toLowerCase() || "jpg";
  const contentType = MIME_TYPES[ext] || "image/jpeg";
  const buffer = readFileSync(coverPath);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
