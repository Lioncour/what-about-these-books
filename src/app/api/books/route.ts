import { NextRequest, NextResponse } from "next/server";
import {
  BookEditError,
  deleteBook,
  isValidBookId,
  listBooks,
  listDuplicateBookGroups,
  mergeDuplicateBooks,
  updateBookMetadata,
} from "@/lib/book-store";
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

/**
 * Edit a book's display title and/or author: `{ "bookId", "title"?, "author"? }` →
 * `{ "book": <catalog entry> }`. 400 for a bad id or value, 409 when another book
 * already has that title. An empty author clears it.
 */
export async function PATCH(request: NextRequest) {
  const blocked = publicModeBlocked("Editing books");
  if (blocked) return blocked;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Expected a JSON object");
    const book = updateBookMetadata(body.bookId, { title: body.title, author: body.author });
    return NextResponse.json({ book });
  } catch (error) {
    if (error instanceof BookEditError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return errorResponse(error, "Failed to update the book");
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
