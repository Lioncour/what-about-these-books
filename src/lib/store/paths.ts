/** Where each store keeps its files under DATA_DIR, plus the book-id guard shared by all of them. */
import { join } from "path";
import { DATA_DIR, ensureDir, InvalidIdError, isValidBookId } from "@/lib/runtime-config";

export const INDEX_DIR = join(DATA_DIR, "index");
export const COVERS_DIR = join(DATA_DIR, "covers");
export const TEXTS_DIR = join(DATA_DIR, "texts");
export const SPECIALISTS_DIR = join(DATA_DIR, "specialists");
export const CHATS_DIR = join(DATA_DIR, "chats");
export const CATALOG_FILE = join(DATA_DIR, "books.json");
export const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export function ensureStoreDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(INDEX_DIR);
  ensureDir(COVERS_DIR);
  ensureDir(TEXTS_DIR);
  ensureDir(SPECIALISTS_DIR);
}

export function bookFile(dir: string, bookId: string, ext: string): string {
  return join(dir, `${bookId}.${ext}`);
}

export function assertBookId(bookId: unknown): asserts bookId is string {
  if (!isValidBookId(bookId)) throw new InvalidIdError("book", bookId);
}
