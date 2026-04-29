import { NextRequest, NextResponse } from "next/server";
import { listBooks, loadBookPages } from "@/lib/book-store";
import { createShareLink, findShareByToken, listShareLinks, redactText } from "@/lib/ops-store";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ links: listShareLinks() });
  }
  const share = findShareByToken(token);
  if (!share) return NextResponse.json({ error: "Invalid token" }, { status: 404 });
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
  const body = await request.json();
  const link = createShareLink({
    bookIds: Array.isArray(body?.bookIds) ? body.bookIds.map(String) : [],
    redactTerms: Array.isArray(body?.redactTerms) ? body.redactTerms.map(String) : [],
    expiresAt: body?.expiresAt ? String(body.expiresAt) : undefined,
  });
  return NextResponse.json({ link, url: `/api/share?token=${link.token}` });
}
