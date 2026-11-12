/**
 * Pure helpers for the library rail (no React, no DOM): grouping the shelves,
 * dialog wording, and what an edit sends.
 */
import type { Book, DuplicateGroup, Series } from "@/components/library/types";

export function formatWordCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k words`;
  return `${count} words`;
}

export function hashTitle(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Where a cover is loaded from; `version` changes after an upload so the browser refetches. */
export function coverUrl(bookId: string, version?: number): string {
  return `/api/covers/${bookId}${version ? `?v=${version}` : ""}`;
}

export interface ShelfSeries extends Series {
  books: Book[];
}

/** The shelves as shown: series (reading order) with their matching books, then the rest. */
export function groupShelf(
  books: Book[],
  series: Series[],
  filter: string
): { series: ShelfSeries[]; ungrouped: Book[] } {
  const needle = filter.toLowerCase();
  const filtered = filter
    ? books.filter(
        (b) =>
          b.title.toLowerCase().includes(needle) ||
          (b.author && b.author.toLowerCase().includes(needle))
      )
    : books;
  const byId = new Map(filtered.map((b) => [b.id, b]));
  const visible = series
    .map((s) => ({
      ...s,
      books: s.bookIds
        .map((id) => byId.get(id))
        .filter((b): b is Book => !!b)
        .sort((a, b) => {
          const ao = a.seriesOrder ?? 9999;
          const bo = b.seriesOrder ?? 9999;
          if (ao !== bo) return ao - bo;
          const ay = a.publishedYear ?? 9999;
          const by = b.publishedYear ?? 9999;
          if (ay !== by) return ay - by;
          return a.title.localeCompare(b.title);
        }),
    }))
    .filter((s) => s.books.length > 0);
  const grouped = new Set(visible.flatMap((s) => s.books.map((b) => b.id)));
  return { series: visible, ungrouped: filtered.filter((b) => !grouped.has(b.id)) };
}

export function removeBookQuestion(title: string): string {
  return `Remove “${title}” from your library? Its text, index and notes about it go too.`;
}

export function deleteSeriesQuestion(name: string): string {
  return `Delete the series “${name}”? Its books stay in your library, ungrouped.`;
}

/** Which copy a merge keeps (the oldest) and which it removes. */
export function mergePlan(group: DuplicateGroup): { keep: Book; remove: Book[] } | null {
  if (group.books.length < 2) return null;
  const sorted = [...group.books].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  return { keep: sorted[0], remove: sorted.slice(1) };
}

/** The lines of the "Series grouping fixed" notice. */
export function seriesFixLines(data: Record<string, unknown>): string[] {
  const n = (key: string) => Number(data[key] ?? 0) || 0;
  return [
    `Updated books: ${n("updatedBooks")}`,
    `Ordered books: ${n("orderedBooks")}`,
    `Created: ${n("createdSeries")}`,
    `Merged folders: ${n("mergedSeries")}`,
    `Removed junk: ${n("removedSeries")}`,
    `Open Library matches: ${n("lookedUp")}`,
  ];
}

export interface BookEditPatch {
  bookId: string;
  title?: string;
  author?: string;
}

/**
 * What `PATCH /api/books` should carry for an edit: only the fields that changed.
 * null = nothing changed; an `error` when the title was emptied.
 */
export function bookEditPatch(
  book: { id: string; title: string; author?: string },
  edited: { title: string; author: string }
): BookEditPatch | { error: string } | null {
  const title = edited.title.replace(/\s+/g, " ").trim();
  const author = edited.author.replace(/\s+/g, " ").trim();
  if (!title) return { error: "A book needs a title." };
  const patch: BookEditPatch = { bookId: book.id };
  if (title !== book.title) patch.title = title;
  if (author !== (book.author ?? "").trim()) patch.author = author;
  return patch.title === undefined && patch.author === undefined ? null : patch;
}

export const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Why a file can't be a cover ("" when it can): png/jpeg/webp, 5 MB at most. */
export function coverFileProblem(file: { type: string; size: number }): string {
  if (!COVER_TYPES.includes(file.type)) return "A cover has to be a PNG, JPEG or WebP image.";
  if (file.size > COVER_MAX_BYTES) return "That image is over 5 MB; pick a smaller one.";
  return "";
}
