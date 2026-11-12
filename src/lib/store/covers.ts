/** Cover images (covers/<bookId>.<ext>). */
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { isValidBookId } from "@/lib/runtime-config";
import { COVERS_DIR, assertBookId, bookFile, ensureStoreDirs } from "./paths";

export function saveCover(bookId: string, imageBuffer: Buffer, mimeType: string): boolean {
  assertBookId(bookId);
  ensureStoreDirs();
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : "jpg";
  const coverPath = bookFile(COVERS_DIR, bookId, ext);
  writeFileSync(coverPath, imageBuffer);
  return true;
}

export function getCoverPath(bookId: string): string | null {
  if (!isValidBookId(bookId)) return null;
  ensureStoreDirs();
  for (const ext of ["jpg", "png", "gif", "jpeg", "webp"]) {
    const p = bookFile(COVERS_DIR, bookId, ext);
    if (existsSync(p)) return p;
  }
  return null;
}

export function deleteCoverFiles(bookId: string): void {
  for (const ext of ["jpg", "png", "gif", "jpeg", "webp"]) {
    const p = bookFile(COVERS_DIR, bookId, ext);
    if (existsSync(p)) unlinkSync(p);
  }
}
