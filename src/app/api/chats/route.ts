import { NextRequest, NextResponse } from "next/server";
import { listChats, saveChat, loadChat, deleteChat, isValidChatId } from "@/lib/book-store";
import { badRequest, errorResponse, publicModeBlocked } from "@/lib/api-guard";

export async function GET(request: NextRequest) {
  const chatId = request.nextUrl.searchParams.get("id");

  if (chatId) {
    if (!isValidChatId(chatId)) return badRequest("Invalid chat id");
    const chat = loadChat(chatId);
    if (!chat) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(chat);
  }

  return NextResponse.json({ chats: listChats() });
}

export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Saving chats");
  if (blocked) return blocked;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || !isValidChatId(body.id) || !Array.isArray(body.messages)) {
      return badRequest("Chat body must have a valid id and a messages array");
    }
    saveChat(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Failed to save");
  }
}

export async function DELETE(request: NextRequest) {
  const blocked = publicModeBlocked("Deleting chats");
  if (blocked) return blocked;
  try {
    const { chatId } = await request.json();
    if (!chatId) return NextResponse.json({ error: "Missing chat ID" }, { status: 400 });
    if (!isValidChatId(chatId)) return badRequest("Invalid chat id");
    deleteChat(chatId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Failed to delete");
  }
}
