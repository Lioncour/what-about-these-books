import { NextRequest, NextResponse } from "next/server";
import { listBooks, deleteBook, listDuplicateBookGroups, mergeDuplicateBooks } from "@/lib/book-store";

export async function GET(request: NextRequest) {
  const requestMode = request.nextUrl.searchParams.get("mode");
  const books = listBooks();
  if (requestMode === "duplicates") {
    return NextResponse.json({ groups: listDuplicateBookGroups() });
  }
  return NextResponse.json({ books });
}

export async function POST(request: NextRequest) {
  if (process.env.PUBLIC_MODE === "true") {
    return NextResponse.json(
      { error: "Editing books is disabled in public mode." },
      { status: 403 }
    );
  }
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
      const result = await mergeDuplicateBooks(primaryBookId, duplicateBookId);
      return NextResponse.json({ ok: true, result });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Books POST error:", error);
    return NextResponse.json({ error: "Failed to update books" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (process.env.PUBLIC_MODE === "true") {
    return NextResponse.json(
      { error: "Deleting books is disabled in public mode." },
      { status: 403 }
    );
  }

  try {
    const { bookId } = await request.json();
    if (!bookId) {
      return NextResponse.json({ error: "Missing book ID" }, { status: 400 });
    }
    await deleteBook(bookId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete error:", error);
    return NextResponse.json(
      { error: "Failed to delete book" },
      { status: 500 }
    );
  }
}
