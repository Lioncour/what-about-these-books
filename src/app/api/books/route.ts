import { NextRequest, NextResponse } from "next/server";
import { listBooks, deleteBook } from "@/lib/book-store";

export async function GET() {
  const books = listBooks();
  return NextResponse.json({ books });
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
