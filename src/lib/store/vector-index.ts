/**
 * The Vectra semantic index (index/): one in-process instance, serialised updates, and
 * the operations that have to keep index, catalog and text files in step.
 */
import { LocalDocumentIndex } from "vectra";
import { BedrockEmbeddings } from "@/lib/bedrock-embeddings";
import { removeBookFromKnowledge } from "@/lib/knowledge-store";
import { removeBookFromQuality } from "@/lib/quality-store";
import { removeBookFromShares } from "@/lib/ops-store";
import { getBookById, listBooks, loadCatalog, resetCatalogCache, saveCatalog, type BookEntry } from "./catalog";
import { deleteChatsForBook } from "./chats";
import { deleteCoverFiles } from "./covers";
import {
  deleteBookPagesFile,
  findPageForText,
  loadBookPages,
  resetPagesCache,
  saveBookPages,
  type BookPage,
} from "./pages";
import { INDEX_DIR, assertBookId, ensureStoreDirs } from "./paths";
import { deleteBookSpecialistProfile } from "./specialist-profiles";

function createIndex(): LocalDocumentIndex {
  ensureStoreDirs();
  return new LocalDocumentIndex({
    folderPath: INDEX_DIR,
    embeddings: new BedrockEmbeddings(),
    chunkingConfig: {
      chunkSize: 512,
      chunkOverlap: 64,
    },
  });
}

let _index: LocalDocumentIndex | null = null;

async function getIndex(): Promise<LocalDocumentIndex> {
  if (!_index) {
    _index = createIndex();
    if (!(await _index.isCatalogCreated())) {
      await _index.createIndex({ version: 1 });
    }
  }
  return _index;
}

/**
 * Drop the in-memory Vectra index so the next access re-reads `index/` from disk.
 * Call after anything that replaces the index files behind our back (backup restore),
 * otherwise the stale `_data` would be written over the restored index on the next update.
 */
export function resetIndexCache(): void {
  _index = null;
  resetPagesCache();
  resetCatalogCache();
}

/**
 * Serializes Vectra updates. `upsertDocument`/`deleteDocument` each do
 * beginUpdate → endUpdate and throw "Update already in progress" when they overlap
 * (an upload during a reindex). Simple promise-chain mutex; errors don't break the chain.
 */
let indexLock: Promise<void> = Promise.resolve();

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function addBook(
  title: string,
  filename: string,
  text: string,
  wordCount: number,
  opts: {
    hasCover?: boolean;
    author?: string;
    fileType?: string;
    seriesId?: string;
    /** When given, the page map is written to texts/ before the index and catalog, and removed again if either fails. */
    pages?: BookPage[];
  } = {}
): Promise<BookEntry> {
  const id = `book-${Date.now()}`;
  const index = await getIndex();

  if (opts.pages) saveBookPages(id, opts.pages);

  try {
    await withIndexLock(() => index.upsertDocument(id, text, "book", { title, bookId: id }));

    const catalog = loadCatalog();
    const entry: BookEntry = {
      id,
      title,
      filename,
      wordCount,
      addedAt: new Date().toISOString(),
      hasCover: opts.hasCover,
      author: opts.author,
      fileType: opts.fileType,
      seriesId: opts.seriesId,
    };
    catalog.books.push(entry);
    if (opts.seriesId) {
      const series = catalog.series.find((s) => s.id === opts.seriesId);
      if (series && !series.bookIds.includes(entry.id)) {
        series.bookIds.push(entry.id);
      }
    }
    try {
      saveCatalog(catalog);
    } catch (error) {
      // Catalog write failed after the index took the document: don't leave an orphan.
      await withIndexLock(() => index.deleteDocument(id)).catch((e) =>
        console.error("Rollback of index document failed:", e)
      );
      throw error;
    }

    return entry;
  } catch (error) {
    if (opts.pages) {
      try {
        deleteBookPagesFile(id);
      } catch (e) {
        console.error("Rollback of pages file failed:", e);
      }
    }
    throw error;
  }
}

export async function deleteBook(bookId: string): Promise<void> {
  assertBookId(bookId);
  const index = await getIndex();
  await withIndexLock(() => index.deleteDocument(bookId));

  const catalog = loadCatalog();
  catalog.books = catalog.books.filter((b) => b.id !== bookId);
  for (const series of catalog.series) {
    series.bookIds = series.bookIds.filter((id) => id !== bookId);
  }
  catalog.series = catalog.series.filter((s) => s.bookIds.length > 0);
  saveCatalog(catalog);

  deleteBookPagesFile(bookId);
  deleteBookSpecialistProfile(bookId);
  deleteCoverFiles(bookId);

  // Everything else that references the id (best effort; the book itself is already gone).
  const cleanups: Array<[string, () => void]> = [
    ["knowledge", () => removeBookFromKnowledge(bookId)],
    ["quality", () => removeBookFromQuality(bookId)],
    ["shares", () => removeBookFromShares(bookId)],
    ["chats", () => deleteChatsForBook(bookId)],
  ];
  for (const [what, fn] of cleanups) {
    try {
      fn();
    } catch (error) {
      console.error(`deleteBook: ${what} cleanup failed for ${bookId}:`, error);
    }
  }
}

export async function deleteAllBooks(): Promise<number> {
  const ids = listBooks().map((b) => b.id);
  for (const id of ids) {
    await deleteBook(id);
  }
  return ids.length;
}

export interface PassageResult {
  text: string;
  location: string;
  /** The book the passage came from. Titles can be renamed; ids cannot. */
  bookId?: string;
}

/** A passage from a multi-book query. `bookTitle` is the catalog's current title for `bookId`. */
export interface BookPassageResult {
  bookId: string;
  bookTitle: string;
  text: string;
  location: string;
}

export async function queryBook(
  bookId: string,
  query: string,
  maxChunks = 20
): Promise<PassageResult[]> {
  const index = await getIndex();
  const results = await index.queryDocuments(query, {
    maxDocuments: 1,
    maxChunks,
    filter: { bookId: { $eq: bookId } },
  });

  if (!results.length) return [];

  const sections = await results[0].renderSections(
    maxChunks * 512,
    1,
    true
  );

  return sections.map((s) => ({
    text: s.text,
    location: findPageForText(bookId, s.text),
    bookId,
  }));
}

/**
 * Semantic search over every indexed book. Results are identified by `bookId` (the Vectra
 * document uri); the title is read from the catalog now, never from the index metadata
 * written at ingest, so renaming a book cannot detach its passages.
 */
export async function queryAllBooks(
  query: string,
  maxChunks = 20
): Promise<BookPassageResult[]> {
  const index = await getIndex();
  const catalog = loadCatalog();
  const bookMap = new Map(catalog.books.map((b) => [b.id, b]));

  const results = await index.queryDocuments(query, {
    maxDocuments: 10,
    maxChunks: Math.ceil(maxChunks / 2),
  });

  const passages: BookPassageResult[] = [];
  for (const doc of results) {
    const bookId = doc.uri;
    const book = bookMap.get(bookId);
    const title = book?.title || "Unknown book";

    const sections = await doc.renderSections(512 * 4, 1, true);
    for (const s of sections) {
      passages.push({
        bookId,
        bookTitle: title,
        text: s.text,
        location: findPageForText(bookId, s.text),
      });
    }
  }

  return passages.slice(0, maxChunks);
}

export async function querySeriesBooks(
  seriesId: string,
  query: string,
  maxChunks = 20
): Promise<BookPassageResult[]> {
  const series = loadCatalog().series.find((s) => s.id === seriesId);
  if (!series) return [];

  // Filter by id, not by title: two books can share a title, and titles get renamed.
  const booksInSeries = new Set(series.bookIds);
  const allResults = await queryAllBooks(query, maxChunks * 3);
  return allResults.filter((r) => booksInSeries.has(r.bookId)).slice(0, maxChunks);
}

export async function rebuildBookIndex(bookId: string): Promise<void> {
  assertBookId(bookId);
  const pages = loadBookPages(bookId);
  if (!pages?.length) return;
  const index = await getIndex();
  // Same text shape as ingest (`addBook` gets the raw page texts joined by blank lines,
  // no `[label]` prefixes), so chunks match `findPageForText` and citations keep their page.
  const merged = pages.map((p) => p.text).join("\n\n");
  const title = getBookById(bookId)?.title;
  await withIndexLock(() => index.upsertDocument(bookId, merged, "book", title ? { title, bookId } : { bookId }));
}
