/** Per-book "librarian memory" profiles (specialists/<bookId>.json). */
import { existsSync, readFileSync, unlinkSync } from "fs";
import { isValidBookId, writeJsonAtomic } from "@/lib/runtime-config";
import { SPECIALISTS_DIR, assertBookId, bookFile, ensureStoreDirs } from "./paths";

export interface BookSpecialistProfile {
  bookId: string;
  bookTitle: string;
  summary: string;
  keyTopics: string[];
  notableEntities: string[];
  styleNotes: string[];
  keyCharacters?: string[];
  keyLocations?: string[];
  glossary?: string[];
  timelineHighlights?: string[];
  updatedAt: string;
}

export function saveBookSpecialistProfile(profile: BookSpecialistProfile): void {
  assertBookId(profile.bookId);
  ensureStoreDirs();
  writeJsonAtomic(bookFile(SPECIALISTS_DIR, profile.bookId, "json"), profile);
}

export function loadBookSpecialistProfile(bookId: string): BookSpecialistProfile | null {
  if (!isValidBookId(bookId)) return null;
  ensureStoreDirs();
  const p = bookFile(SPECIALISTS_DIR, bookId, "json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as BookSpecialistProfile;
  } catch {
    return null;
  }
}

export function deleteBookSpecialistProfile(bookId: string): void {
  assertBookId(bookId);
  const p = bookFile(SPECIALISTS_DIR, bookId, "json");
  if (existsSync(p)) unlinkSync(p);
}

/** Keep the profile's copy of the title in step with the catalog. */
export function renameBookSpecialistProfile(bookId: string, bookTitle: string): void {
  const profile = loadBookSpecialistProfile(bookId);
  if (!profile || profile.bookTitle === bookTitle) return;
  saveBookSpecialistProfile({ ...profile, bookTitle });
}
