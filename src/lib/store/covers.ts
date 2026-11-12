/** Cover images (covers/<bookId>.<ext>). */
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { isValidBookId } from "@/lib/runtime-config";
import { loadCatalog, saveCatalog } from "./catalog";
import { COVERS_DIR, assertBookId, bookFile, ensureStoreDirs } from "./paths";

const COVER_EXTENSIONS = ["jpg", "png", "gif", "jpeg", "webp"] as const;

/** Largest cover a reader may upload. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * The image type by its first bytes (what the file is, not what it claims to be):
 * PNG, JPEG or WebP; null for anything else.
 */
export function detectImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // "RIFF" <size> "WEBP"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Write the cover; a cover saved earlier under another extension is removed. */
export function saveCover(bookId: string, imageBuffer: Buffer, mimeType: string): boolean {
  assertBookId(bookId);
  ensureStoreDirs();
  const ext = mimeType.includes("png")
    ? "png"
    : mimeType.includes("gif")
      ? "gif"
      : mimeType.includes("webp")
        ? "webp"
        : "jpg";
  const coverPath = bookFile(COVERS_DIR, bookId, ext);
  writeFileSync(coverPath, imageBuffer);
  for (const other of COVER_EXTENSIONS) {
    const p = bookFile(COVERS_DIR, bookId, other);
    if (other !== ext && existsSync(p)) unlinkSync(p);
  }
  return true;
}

/** A cover the reader uploaded: checked, saved, and the catalog told the book has one. */
export function replaceCover(bookId: string, image: Buffer): { ok: true } | { ok: false; error: string; status: 400 | 404 } {
  if (!isValidBookId(bookId)) return { ok: false, error: "Invalid book id", status: 400 };
  if (!image.length) return { ok: false, error: "The file is empty", status: 400 };
  if (image.length > MAX_COVER_BYTES) return { ok: false, error: "The cover can be at most 5 MB", status: 400 };
  const type = detectImageType(image);
  if (!type) return { ok: false, error: "The cover must be a PNG, JPEG or WebP image", status: 400 };
  const catalog = loadCatalog();
  const book = catalog.books.find((b) => b.id === bookId);
  if (!book) return { ok: false, error: "No such book", status: 404 };
  saveCover(bookId, image, type);
  if (!book.hasCover) {
    book.hasCover = true;
    saveCatalog(catalog);
  }
  return { ok: true };
}

export function getCoverPath(bookId: string): string | null {
  if (!isValidBookId(bookId)) return null;
  ensureStoreDirs();
  for (const ext of COVER_EXTENSIONS) {
    const p = bookFile(COVERS_DIR, bookId, ext);
    if (existsSync(p)) return p;
  }
  return null;
}

export function deleteCoverFiles(bookId: string): void {
  for (const ext of COVER_EXTENSIONS) {
    const p = bookFile(COVERS_DIR, bookId, ext);
    if (existsSync(p)) unlinkSync(p);
  }
}
