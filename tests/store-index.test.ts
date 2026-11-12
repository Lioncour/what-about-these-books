import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataDir, removeDataDir, writeLibrary } from "./store-env";

/** In-memory stand-in for Vectra: remembers documents, returns all of them for any query. */
const docs = new Map<string, { text: string; metadata: Record<string, unknown> }>();
let instances = 0;

vi.mock("vectra", () => ({
  LocalDocumentIndex: class {
    constructor() {
      instances++;
    }
    async isCatalogCreated() {
      return true;
    }
    async createIndex() {}
    async upsertDocument(uri: string, text: string, _type: string, metadata: Record<string, unknown>) {
      docs.set(uri, { text, metadata });
    }
    async deleteDocument(uri: string) {
      docs.delete(uri);
    }
    async queryDocuments(_query: string, opts: { filter?: { bookId?: { $eq: string } } }) {
      const only = opts.filter?.bookId?.$eq;
      return [...docs.entries()]
        .filter(([uri]) => !only || uri === only)
        .map(([uri, doc]) => ({ uri, renderSections: async () => [{ text: doc.text }] }));
    }
  },
}));
vi.mock("@/lib/bedrock-embeddings", () => ({ BedrockEmbeddings: class {} }));

let dir: string;
beforeEach(() => {
  dir = freshDataDir();
  docs.clear();
  instances = 0;
});
afterEach(() => removeDataDir(dir));

describe("book-store barrel", () => {
  it("still exports every name other modules import", async () => {
    const store = await import("@/lib/book-store");
    const expected = [
      "DATA_DIR", "isPublicMode", "isValidBookId", "isValidChatId", "isValidSeriesId",
      "saveBookPages", "loadBookPages", "saveBookSpecialistProfile", "loadBookSpecialistProfile",
      "searchBookKeyword", "countBookKeywordMentions", "countAllBooksKeywordMentions",
      "countSeriesKeywordMentions", "searchAllBooksKeyword", "searchSeriesKeyword",
      "searchExactQuoteInBook", "searchExactQuoteAllBooks", "searchExactQuoteInSeries",
      "loadSettings", "saveSettings", "resetIndexCache", "saveCover", "getCoverPath",
      "findBookByFilename", "addBook", "deleteBook", "deleteAllBooks", "findBooksByTitleQuery",
      "listBooks", "getBookById", "listSeries", "saveSeries", "deleteSeries", "reconcileLibrarySeries",
      "autoFixSeriesByAuthor", "listDuplicateBookGroups", "mergeDuplicateBooks", "getSeriesForBook",
      "queryBook", "saveChat", "loadChat", "listChats", "deleteChat", "deleteChatsForBook",
      "queryAllBooks", "querySeriesBooks", "rebuildBookIndex", "tidyLibrary",
    ];
    for (const name of expected) expect(store, name).toHaveProperty(name);
    expect(store.DATA_DIR).toBe(dir);
  });
});

describe("vector index", () => {
  it("addBook writes text, index and catalog; deleteBook removes them", async () => {
    const store = await import("@/lib/book-store");
    const book = await store.addBook("Columbus Day", "columbus day.epub", "The Ruhar hit us.", 4, {
      pages: [{ label: "Chapter 1", text: "The Ruhar hit us." }],
    });
    expect(book.id).toMatch(/^book-\d+$/);
    expect(docs.get(book.id)?.metadata).toEqual({ title: "Columbus Day", bookId: book.id });
    expect(store.loadBookPages(book.id)).toHaveLength(1);
    expect(store.listBooks().map((b) => b.id)).toEqual([book.id]);

    await store.deleteBook(book.id);
    expect(docs.size).toBe(0);
    expect(store.listBooks()).toEqual([]);
    expect(store.loadBookPages(book.id)).toBeNull();
    await expect(store.deleteBook("../evil")).rejects.toThrow(/Invalid book id/);
  });

  it("passages carry the book id and the catalog's current title, also after a rename", async () => {
    writeLibrary(
      dir,
      [
        {
          id: "book-1",
          title: "Failure Mode (Expeditionary For Craig Alanson",
          filename: "Failure Mode (Expeditionary For Craig Alanson.epub",
          author: "Craig Alanson",
          fileType: "EPUB",
          seriesId: "series-1",
          pages: [
            { label: "Chapter 1", text: "CHAPTER ONE SKIPPY I woke up." },
            { label: "Chapter 2", text: "CHAPTER TWO The ship was quiet." },
          ],
        },
        { id: "book-2", title: "Other", filename: "other.txt", pages: [{ label: "Page 1", text: "Elsewhere." }] },
      ],
      [{ id: "series-1", name: "Expeditionary Force", bookIds: ["book-1"] }]
    );
    const store = await import("@/lib/book-store");
    // Index metadata keeps the title from ingest; it must not be what results show.
    docs.set("book-1", { text: "CHAPTER TWO The ship was quiet.", metadata: { title: "stale", bookId: "book-1" } });
    docs.set("book-2", { text: "Elsewhere.", metadata: { title: "Other", bookId: "book-2" } });
    docs.set("book-gone", { text: "Orphan.", metadata: {} });

    const before = await store.queryAllBooks("ship");
    expect(before.map((p) => [p.bookId, p.bookTitle, p.location])).toEqual([
      ["book-1", "Failure Mode (Expeditionary For Craig Alanson", "Chapter 2"],
      ["book-2", "Other", "Page 1"],
      ["book-gone", "Unknown book", "Unknown location"],
    ]);

    store.tidyLibrary();

    const after = await store.queryAllBooks("ship");
    expect(after[0]).toMatchObject({ bookId: "book-1", bookTitle: "Failure Mode", location: "Chapter 2" });
    // Whatever matches on titles downstream sees the same title the catalog lists.
    expect(store.listBooks().map((b) => b.title)).toContain(after[0].bookTitle);

    const series = await store.querySeriesBooks("series-1", "ship");
    expect(series.map((p) => p.bookId)).toEqual(["book-1"]);
    const one = await store.queryBook("book-1", "ship");
    expect(one).toEqual([{ text: "CHAPTER TWO The ship was quiet.", location: "Chapter 2", bookId: "book-1" }]);
  });

  it("resetIndexCache drops the index instance and the catalog and page caches", async () => {
    writeLibrary(dir, [{ id: "book-1", title: "One", filename: "one.txt", pages: [{ label: "Page 1", text: "a" }] }]);
    const store = await import("@/lib/book-store");
    await store.queryAllBooks("x");
    await store.queryAllBooks("x");
    expect(instances).toBe(1);
    expect(store.listBooks()[0].title).toBe("One");
    expect(store.loadBookPages("book-1")?.[0].text).toBe("a");

    // A restore replaces the files behind the store's back, possibly with the same size and mtime.
    const { utimesSync, statSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const [file, from, to] of [
      [join(dir, "books.json"), '"One"', '"Two"'],
      [join(dir, "texts", "book-1.json"), '"a"', '"b"'],
    ]) {
      const st = statSync(file);
      const { readFileSync } = await import("node:fs");
      writeFileSync(file, readFileSync(file, "utf-8").replace(from, to));
      utimesSync(file, st.atime, st.mtime);
    }

    store.resetIndexCache();
    expect(store.listBooks()[0].title).toBe("Two");
    expect(store.loadBookPages("book-1")?.[0].text).toBe("b");
    await store.queryAllBooks("x");
    expect(instances).toBe(2);
  });
});
