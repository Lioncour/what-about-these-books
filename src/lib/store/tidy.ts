/**
 * Library tidy for books that are already in the library: clean display titles and
 * EPUB chapter labels the way a fresh upload would get them now.
 *
 * Books are identified by id everywhere (catalog, texts/, index, knowledge, quality,
 * chats), so a title is only what gets shown. The copies of it kept in other stores
 * (specialist profile, timeline, scorecards, saved chats) are refreshed here; the
 * Vectra document metadata keeps the old title until the next re-index and is never
 * read for lookups. Page text is never touched, so the index stays valid.
 */
import { createBackupSnapshot } from "@/lib/ops-store";
import { renameBookInKnowledge } from "@/lib/knowledge-store";
import { dropSpecialistCacheForBook, renameBookInQuality } from "@/lib/quality-store";
import { isValidBookId } from "@/lib/runtime-config";
import { cleanIngestTitle, titleFromFilename } from "@/lib/series-detection";
import { loadCatalog, renameBooks, type BookEntry } from "./catalog";
import { renameBookInChats } from "./chats";
import { relabelEpubPages } from "./labels";
import { loadBookPages, saveBookPages, type BookPage } from "./pages";
import { renameBookSpecialistProfile } from "./specialist-profiles";

export interface TidyResult {
  /** Books whose display title changes. */
  titles: { id: string; from: string; to: string }[];
  /** EPUBs whose chapter labels change; `title` is the title after the tidy. */
  labels: { id: string; title: string; changed: number }[];
  dryRun: boolean;
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

function isEpub(book: BookEntry): boolean {
  return (book.fileType || "").toUpperCase() === "EPUB" || /\.epub$/i.test(book.filename);
}

/**
 * The title a fresh upload of this file would get, or null to leave the book alone:
 * a title that isn't the raw filename was typed by someone or came from the book's
 * own metadata, which isn't stored, so it can't be recomputed and mustn't be replaced.
 */
function tidyTitle(book: BookEntry, seriesName: string | undefined): string | null {
  if (!book.filename || !sameText(book.title, titleFromFilename(book.filename))) return null;
  const cleaned = cleanIngestTitle({ filename: book.filename, author: book.author, seriesName });
  return cleaned && cleaned !== book.title ? cleaned : null;
}

export function tidyLibrary(opts: { dryRun?: boolean } = {}): TidyResult {
  const dryRun = opts.dryRun === true;
  const catalog = loadCatalog();
  const books = catalog.books.filter((b) => isValidBookId(b.id));
  const seriesNameOf = (book: BookEntry) =>
    catalog.series.find((s) => s.id === book.seriesId || s.bookIds.includes(book.id))?.name;

  // 1) Titles. Two books must not end up with the same title: the chat pipeline still
  //    groups passages by title, so a clash would merge two books' evidence.
  const titles: TidyResult["titles"] = [];
  const taken = new Map<string, number>();
  const key = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();
  for (const b of catalog.books) taken.set(key(b.title), (taken.get(key(b.title)) || 0) + 1);
  for (const book of books) {
    const to = tidyTitle(book, seriesNameOf(book));
    if (!to) continue;
    const fromKey = key(book.title);
    const toKey = key(to);
    const others = (taken.get(toKey) || 0) - (fromKey === toKey ? 1 : 0);
    if (others > 0) continue;
    taken.set(fromKey, (taken.get(fromKey) || 1) - 1);
    taken.set(toKey, (taken.get(toKey) || 0) + 1);
    titles.push({ id: book.id, from: book.title, to });
  }
  const newTitle = new Map(titles.map((t) => [t.id, t.to]));

  // 2) Chapter labels of EPUBs, from each section's own heading.
  const labels: TidyResult["labels"] = [];
  const relabelled = new Map<string, BookPage[]>();
  for (const book of books) {
    if (!isEpub(book)) continue;
    const pages = loadBookPages(book.id);
    if (!pages?.length) continue;
    const next = relabelEpubPages(pages);
    const changed = next.reduce((n, page, i) => n + (page.label !== pages[i].label ? 1 : 0), 0);
    if (!changed) continue;
    labels.push({ id: book.id, title: newTitle.get(book.id) ?? book.title, changed });
    relabelled.set(book.id, next);
  }

  if (dryRun || (!titles.length && !labels.length)) return { titles, labels, dryRun };

  // 3) Apply: snapshot first, then atomic writes (both stores drop their caches on save).
  createBackupSnapshot();
  for (const [bookId, pages] of relabelled) {
    saveBookPages(bookId, pages);
    // Cached specialist answers quote the old labels as locations.
    dropSpecialistCacheForBook(bookId);
  }
  if (titles.length) {
    const applied = renameBooks(newTitle);
    for (const { id, to } of titles) {
      if (!applied.has(id)) continue;
      for (const [what, fn] of [
        ["specialist profile", () => renameBookSpecialistProfile(id, to)],
        ["knowledge", () => renameBookInKnowledge(id, to)],
        ["quality", () => renameBookInQuality(id, to)],
        ["chats", () => renameBookInChats(id, to)],
      ] as Array<[string, () => void]>) {
        try {
          fn();
        } catch (error) {
          console.error(`tidyLibrary: could not update the title in ${what} for ${id}:`, error);
        }
      }
    }
  }
  return { titles, labels, dryRun };
}
