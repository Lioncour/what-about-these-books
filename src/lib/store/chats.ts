/** Saved conversations (chats/<chatId>.json). */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { ensureDir, InvalidIdError, isValidChatId, writeJsonAtomic } from "@/lib/runtime-config";
import { CHATS_DIR, assertBookId, ensureStoreDirs } from "./paths";

export interface ChatEntry {
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  messages: {
    role: string;
    content: string;
    sources?: { book: string; excerpt: string; position?: string; bookId?: string }[];
  }[];
  updatedAt: string;
}

function chatFile(chatId: string): string {
  return join(CHATS_DIR, `${chatId}.json`);
}

function ensureChatsDir() {
  ensureStoreDirs();
  ensureDir(CHATS_DIR);
}

export function saveChat(chat: ChatEntry): void {
  if (!chat || typeof chat !== "object") throw new InvalidIdError("chat", chat);
  if (!isValidChatId(chat.id)) throw new InvalidIdError("chat", chat?.id);
  if (!Array.isArray(chat.messages)) throw new Error("Chat body must have a messages array");
  ensureChatsDir();
  writeJsonAtomic(chatFile(chat.id), chat);
}

export function loadChat(chatId: string): ChatEntry | null {
  if (!isValidChatId(chatId)) return null;
  ensureChatsDir();
  const p = chatFile(chatId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function listChats(): Omit<ChatEntry, "messages">[] {
  ensureChatsDir();
  const files = existsSync(CHATS_DIR)
    ? readdirSync(CHATS_DIR).filter((f: string) => f.endsWith(".json"))
    : [];
  const chats: Omit<ChatEntry, "messages">[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(CHATS_DIR, file), "utf-8"));
      chats.push({
        id: raw.id,
        bookId: raw.bookId,
        bookTitle: raw.bookTitle,
        title: raw.title,
        updatedAt: raw.updatedAt,
      });
    } catch { /* skip corrupt files */ }
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteChat(chatId: string): void {
  if (!isValidChatId(chatId)) throw new InvalidIdError("chat", chatId);
  ensureChatsDir();
  const p = chatFile(chatId);
  if (existsSync(p)) unlinkSync(p);
}

/** Remove saved conversations whose focus was the given book. */
export function deleteChatsForBook(bookId: string): number {
  assertBookId(bookId);
  ensureChatsDir();
  let removed = 0;
  for (const file of readdirSync(CHATS_DIR).filter((f: string) => f.endsWith(".json"))) {
    const p = join(CHATS_DIR, file);
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as { bookId?: string };
      if (raw.bookId === bookId) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      /* skip corrupt files */
    }
  }
  return removed;
}

/** Saved conversations keep the focused book's title for display; follow a rename. */
export function renameBookInChats(bookId: string, bookTitle: string): number {
  assertBookId(bookId);
  ensureChatsDir();
  let renamed = 0;
  for (const file of readdirSync(CHATS_DIR).filter((f: string) => f.endsWith(".json"))) {
    const p = join(CHATS_DIR, file);
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as { bookId?: string; bookTitle?: string };
      if (raw.bookId !== bookId || raw.bookTitle === bookTitle) continue;
      writeJsonAtomic(p, { ...raw, bookTitle });
      renamed++;
    } catch {
      /* skip corrupt files */
    }
  }
  return renamed;
}
