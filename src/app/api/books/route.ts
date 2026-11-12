import { NextRequest, NextResponse } from "next/server";
import { listBooks, deleteBook, listDuplicateBookGroups, mergeDuplicateBooks, isValidBookId } from "@/lib/book-store";
import { badRequest, errorResponse, publicModeBlocked } from "@/lib/api-guard";

export async function GET(request: NextRequest) {
  const requestMode = request.nextUrl.searchParams.get("mode");
  const books = listBooks();
  if (requestMode === "duplicates") {
    return NextResponse.json({ groups: listDuplicateBookGroups() });
  }
  return NextResponse.json({ books });
}

export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Editing books");
  if (blocked) return blocked;
  try {
    const body = await request.json();
    if (body?.action === "duplicates") {
      return NextResponse.json({ groups: listDuplicateBookGroups() });
    }
    if (body?.action === "merge-duplicate") {
      const primaryBookId = String(body?.primaryBookId || "");
      const duplicateBookId = String(body?.duplicateBookId || "");
      if (!primaryBookId || !duplicateBookId) {
        return NextResponse.json({ error: "Missing merge book IDs" }, { status: 400 });
      }
      if (!isValidBookId(primaryBookId) || !isValidBookId(duplicateBookId)) {
        return badRequest("Invalid book id");
      }
      const result = await mergeDuplicateBooks(primaryBookId, duplicateBookId);
      return NextResponse.json({ ok: true, result });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return errorResponse(error, "Failed to update books");
  }
}

export async function DELETE(request: NextRequest) {
  const blocked = publicModeBlocked("Deleting books");
  if (blocked) return blocked;

  try {
    const { bookId } = await request.json();
    if (!bookId) {
      return NextResponse.json({ error: "Missing book ID" }, { status: 400 });
    }
    if (!isValidBookId(bookId)) return badRequest("Invalid book id");
    await deleteBook(bookId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Failed to delete book");
  }
}
