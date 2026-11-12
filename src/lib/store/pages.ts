/** Page/chapter text per book (texts/<bookId>.json), cached by file mtime. */
import { existsSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { isValidBookId, writeJsonAtomic } from "@/lib/runtime-config";
import { TEXTS_DIR, assertBookId, ensureStoreDirs } from "./paths";

export interface BookPage {
  label: string;
  text: string;
}

/**
 * In-process cache of parsed page maps keyed by the file's mtime, with a pre-lowercased
 * copy for `findPageForText`. Multi-MB JSON used to be parsed per rendered section.
 */
const pagesCache = new Map<string, { mtimeMs: number; size: number; pages: BookPage[]; lower: string[] | null }>();

/** Forget every parsed page map. */
export function resetPagesCache(): void {
  pagesCache.clear();
}

function pagesPath(bookId: string): string {
  return join(TEXTS_DIR, `${bookId}.json`);
}

function loadPagesEntry(bookId: string) {
  if (!isValidBookId(bookId)) return null;
  ensureStoreDirs();
  const p = pagesPath(bookId);
  if (!existsSync(p)) {
    pagesCache.delete(bookId);
    return null;
  }
  const st = statSync(p);
  const cached = pagesCache.get(bookId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const pages = JSON.parse(readFileSync(p, "utf-8")) as BookPage[];
  const entry = { mtimeMs: st.mtimeMs, size: st.size, pages, lower: null };
  pagesCache.set(bookId, entry);
  return entry;
}

export function saveBookPages(bookId: string, pages: BookPage[]): void {
  assertBookId(bookId);
  ensureStoreDirs();
  writeJsonAtomic(pagesPath(bookId), pages, false);
  pagesCache.delete(bookId);
}

export function loadBookPages(bookId: string): BookPage[] | null {
  return loadPagesEntry(bookId)?.pages ?? null;
}

export function deleteBookPagesFile(bookId: string): void {
  const p = pagesPath(bookId);
  if (existsSync(p)) unlinkSync(p);
  pagesCache.delete(bookId);
}

/** Label of the page a retrieved chunk came from (first 80, then 40 characters matched). */
export function findPageForText(bookId: string, chunkText: string): string {
  const entry = loadPagesEntry(bookId);
  if (!entry) return "Unknown location";
  if (!entry.lower) entry.lower = entry.pages.map((p) => p.text.toLowerCase());
  const { pages, lower } = entry;

  const needle = chunkText.slice(0, 80).replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    if (lower[i].includes(needle)) {
      return pages[i].label;
    }
  }

  const shortNeedle = chunkText.slice(0, 40).replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    if (lower[i].includes(shortNeedle)) {
      return pages[i].label;
    }
  }

  return "Unknown location";
}
