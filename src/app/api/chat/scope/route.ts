import { NextRequest, NextResponse } from "next/server";
import { previewScope } from "@/lib/chat/scope";

/**
 * Which books a question would be asked against, for the composer's scope chip.
 * Reads the catalog only: no embeddings, no Claude.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      bookId?: unknown;
      bookTitle?: unknown;
      bookIds?: unknown;
      question?: unknown;
    };
    const preview = previewScope({
      bookId: typeof body.bookId === "string" && body.bookId ? body.bookId : "all",
      bookTitle: typeof body.bookTitle === "string" ? body.bookTitle : "",
      question: typeof body.question === "string" ? body.question.slice(0, 2000) : "",
      pickedIds: body.bookIds,
    });
    return NextResponse.json(preview);
  } catch {
    return NextResponse.json({ error: "Could not preview the scope" }, { status: 400 });
  }
}
