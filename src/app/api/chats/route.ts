import { NextRequest, NextResponse } from "next/server";
import { listChats, saveChat, loadChat, deleteChat } from "@/lib/book-store";

export async function GET(request: NextRequest) {
  const chatId = request.nextUrl.searchParams.get("id");

  if (chatId) {
    const chat = loadChat(chatId);
    if (!chat) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(chat);
  }

  return NextResponse.json({ chats: listChats() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    saveChat(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save chat error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { chatId } = await request.json();
    if (!chatId) return NextResponse.json({ error: "Missing chat ID" }, { status: 400 });
    deleteChat(chatId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete chat error:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
