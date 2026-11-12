/** The book/series catalog (books.json): cached load, atomic save with a .bak copy, simple lookups. */
import { copyFileSync, existsSync, readFileSync, statSync } from "fs";
import { writeJsonAtomic } from "@/lib/runtime-config";
import { CATALOG_FILE, ensureStoreDirs } from "./paths";

export interface BookEntry {
  id: string;
  title: string;
  filename: string;
  wordCount: number;
  addedAt: string;
  hasCover?: boolean;
  author?: string;
  fileType?: string;
  seriesId?: string;
  /** Reading / publication order within the series (supports .5 novellas). */
  seriesOrder?: number;
  isbn?: string;
  publishedYear?: number;
}

export interface SeriesEntry {
  id: string;
  name: string;
  bookIds: string[];
  createdAt: string;
}

export interface BookCatalog {
  books: BookEntry[];
  series: SeriesEntry[];
}

export function normalizeIdentity(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Author key that treats "Alanson, Craig" and "Craig Alanson" as the same person. */
export function normalizeAuthorKey(input: string): string {
  const parts = normalizeIdentity(input).split(/\s+/).filter(Boolean).sort();
  return parts.join(" ");
}

const CATALOG_BACKUP_FILE = `${CATALOG_FILE}.bak`;
let catalogCache: { mtimeMs: number; size: number; catalog: BookCatalog } | null = null;

/** Forget the parsed catalog (after a restore replaced books.json behind our back). */
export function resetCatalogCache(): void {
  catalogCache = null;
}

function parseCatalogFile(path: string): BookCatalog {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BookCatalog>;
  return {
    books: Array.isArray(parsed.books) ? parsed.books : [],
    series: Array.isArray(parsed.series) ? parsed.series : [],
  };
}

/**
 * Parsed catalog cached by books.json mtime/size; callers get a clone so they can
 * mutate freely before `saveCatalog`. An unparsable books.json falls back to the
 * `.bak` copy written just before the last save.
 */
export function loadCatalog(): BookCatalog {
  ensureStoreDirs();
  if (!existsSync(CATALOG_FILE)) return { books: [], series: [] };
  const st = statSync(CATALOG_FILE);
  if (catalogCache && catalogCache.mtimeMs === st.mtimeMs && catalogCache.size === st.size) {
    return structuredClone(catalogCache.catalog);
  }
  let catalog: BookCatalog;
  try {
    catalog = parseCatalogFile(CATALOG_FILE);
  } catch (error) {
    console.error(`books.json is unreadable (${error instanceof Error ? error.message : String(error)})`);
    if (existsSync(CATALOG_BACKUP_FILE)) {
      console.error("Falling back to books.json.bak");
      try {
        catalog = parseCatalogFile(CATALOG_BACKUP_FILE);
      } catch (bakError) {
        throw new Error(
          `Both ${CATALOG_FILE} and its .bak copy are unreadable: ${bakError instanceof Error ? bakError.message : String(bakError)}`
        );
      }
    } else {
      throw new Error(`${CATALOG_FILE} is corrupt and no .bak copy exists; fix or remove it to continue.`);
    }
  }
  catalogCache = { mtimeMs: st.mtimeMs, size: st.size, catalog };
  return structuredClone(catalog);
}

export function saveCatalog(catalog: BookCatalog): void {
  ensureStoreDirs();
  try {
    if (existsSync(CATALOG_FILE)) copyFileSync(CATALOG_FILE, CATALOG_BACKUP_FILE);
  } catch (error) {
    console.warn("Could not write books.json.bak:", error);
  }
  writeJsonAtomic(CATALOG_FILE, catalog);
  const st = statSync(CATALOG_FILE);
  catalogCache = { mtimeMs: st.mtimeMs, size: st.size, catalog: structuredClone(catalog) };
}

export function findBookByFilename(filename: string): BookEntry | undefined {
  const catalog = loadCatalog();
  return catalog.books.find(
    (b) => b.filename.toLowerCase() === filename.toLowerCase()
  );
}

export function findBooksByTitleQuery(query: string): BookEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return listBooks().filter((b) => {
    const title = b.title.toLowerCase();
    const fileTitle = b.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").toLowerCase();
    return title.includes(q) || fileTitle.includes(q) || q.includes(title);
  });
}

export function listBooks(): BookEntry[] {
  return loadCatalog().books;
}

export function getBookById(bookId: string): BookEntry | null {
  return loadCatalog().books.find((b) => b.id === bookId) || null;
}

export function listSeries(): SeriesEntry[] {
  return loadCatalog().series;
}

export function getSeriesForBook(bookId: string): SeriesEntry | null {
  const catalog = loadCatalog();
  return catalog.series.find((s) => s.bookIds.includes(bookId)) || null;
}

/**
 * Change display titles by book id on a freshly loaded catalog (books added meanwhile
 * are kept). Returns the ids that were found and changed.
 */
export function renameBooks(titlesById: ReadonlyMap<string, string>): Set<string> {
  const catalog = loadCatalog();
  const changed = new Set<string>();
  for (const book of catalog.books) {
    const title = titlesById.get(book.id)?.trim();
    if (!title || title === book.title) continue;
    book.title = title;
    changed.add(book.id);
  }
  if (changed.size) saveCatalog(catalog);
  return changed;
}
