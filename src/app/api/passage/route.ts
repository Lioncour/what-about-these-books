import { NextRequest, NextResponse } from "next/server";
import { lookupPassage } from "@/lib/chat/passage-lookup";

export async function GET(request: NextRequest) {
  const bookId = request.nextUrl.searchParams.get("bookId");
  const book = request.nextUrl.searchParams.get("book");
  const position = request.nextUrl.searchParams.get("position");
  const excerpt = request.nextUrl.searchParams.get("excerpt");

  if (!bookId && !book) {
    return NextResponse.json({ error: "bookId or book required" }, { status: 400 });
  }

  const passage = lookupPassage({ bookId, book, position, excerpt });
  if (!passage) {
    return NextResponse.json({ error: "Passage not found" }, { status: 404 });
  }
  return NextResponse.json(passage);
}
