import { NextRequest, NextResponse } from "next/server";
import { isPublicMode, listBooks, loadBookPages } from "@/lib/book-store";
import { createShareLink, findShareByToken, listShareLinks, redactText } from "@/lib/ops-store";

function shareExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) < Date.now();
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    if (isPublicMode) {
      return NextResponse.json({ error: "Listing share links is disabled in public mode." }, { status: 403 });
    }
    return NextResponse.json({ links: listShareLinks() });
  }
  const share = findShareByToken(token);
  if (!share) return NextResponse.json({ error: "Invalid token" }, { status: 404 });
  if (shareExpired(share.expiresAt)) {
    return NextResponse.json({ error: "Share link expired" }, { status: 410 });
  }
  const books = listBooks().filter((b) => share.bookIds.includes(b.id));
  const payload = books.map((book) => {
    const pages = (loadBookPages(book.id) || []).slice(0, 80).map((p) => ({
      label: p.label,
      text: redactText(p.text, share.redactTerms),
    }));
    return {
      id: book.id,
      title: book.title,
      author: book.author,
      pages,
    };
  });
  return NextResponse.json({ shareId: share.id, books: payload, scope: share.bookIds });
}

export async function POST(request: NextRequest) {
  if (isPublicMode) {
    return NextResponse.json({ error: "Creating share links is disabled in public mode." }, { status: 403 });
  }
  const body = await request.json();
  const bookIds = Array.isArray(body?.bookIds) ? body.bookIds.map(String) : [];
  if (!bookIds.length) {
    return NextResponse.json({ error: "At least one bookId is required" }, { status: 400 });
  }
  const known = new Set(listBooks().map((b) => b.id));
  if (bookIds.some((id: string) => !known.has(id))) {
    return NextResponse.json({ error: "Unknown book id in share request" }, { status: 400 });
  }
  const link = createShareLink({
    bookIds,
    redactTerms: Array.isArray(body?.redactTerms) ? body.redactTerms.map(String) : [],
    expiresAt: body?.expiresAt ? String(body.expiresAt) : undefined,
  });
  return NextResponse.json({ link, url: `/api/share?token=${link.token}` });
}
