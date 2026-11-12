import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataDir, removeDataDir, writeLibrary } from "./store-env";

let dir: string;
beforeEach(() => {
  dir = freshDataDir();
});
afterEach(() => {
  vi.restoreAllMocks();
  removeDataDir(dir);
});

describe("runtime-config", () => {
  it("resolves DATA_DIR from the environment", async () => {
    const { DATA_DIR } = await import("@/lib/runtime-config");
    expect(DATA_DIR).toBe(dir);
  });

  it("writeJsonAtomic replaces the file and leaves no temp file", async () => {
    const { writeJsonAtomic } = await import("@/lib/runtime-config");
    const file = join(dir, "nested", "thing.json");
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["thing.json"]);
  });

  it("writeJsonAtomic keeps the old file when serialising fails", async () => {
    const { writeJsonAtomic } = await import("@/lib/runtime-config");
    const file = join(dir, "thing.json");
    writeJsonAtomic(file, { ok: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJsonAtomic(file, circular)).toThrow();
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ ok: true });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("id validators accept generated ids and reject path tricks", async () => {
    const rc = await import("@/lib/runtime-config");
    expect(rc.isValidBookId("book-1731400000000")).toBe(true);
    expect(rc.isValidSeriesId("series-1731400000000-ab12c")).toBe(true);
    expect(rc.isValidChatId("chat-1731400000000")).toBe(true);
    expect(rc.isValidBackupId("backup-1731400000000")).toBe(true);
    for (const bad of ["", "book-", "../book-1", "book-1/../../x", "book-1.json", "chat-1", "book-1\\x", 42, null, undefined]) {
      expect(rc.isValidBookId(bad)).toBe(false);
    }
    expect(rc.isValidChatId("book-1")).toBe(false);
    expect(rc.isValidBackupId("..")).toBe(false);
  });
});

describe("catalog", () => {
  it("falls back to books.json.bak when books.json is corrupt", async () => {
    writeLibrary(dir, [{ id: "book-1", title: "One", filename: "one.epub" }]);
    const catalog = await import("@/lib/store/catalog");
    vi.spyOn(console, "error").mockImplementation(() => {});

    // A save copies the previous books.json to .bak before replacing it.
    const loaded = catalog.loadCatalog();
    loaded.books.push({ id: "book-2", title: "Two", filename: "two.epub", wordCount: 1, addedAt: "x" });
    catalog.saveCatalog(loaded);
    expect(existsSync(join(dir, "books.json.bak"))).toBe(true);
    expect(catalog.listBooks().map((b) => b.id)).toEqual(["book-1", "book-2"]);

    writeFileSync(join(dir, "books.json"), "{ not json");
    catalog.resetCatalogCache();
    expect(catalog.listBooks().map((b) => b.id)).toEqual(["book-1"]);
  });

  it("throws when books.json is corrupt and there is no .bak", async () => {
    writeFileSync(join(dir, "books.json"), "{ not json");
    const catalog = await import("@/lib/store/catalog");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => catalog.listBooks()).toThrow(/corrupt/);
  });

  it("hands out copies, so callers cannot change the cache", async () => {
    writeLibrary(dir, [{ id: "book-1", title: "One", filename: "one.epub" }]);
    const catalog = await import("@/lib/store/catalog");
    catalog.listBooks()[0].title = "Changed";
    expect(catalog.getBookById("book-1")?.title).toBe("One");
  });

  it("renameBooks changes titles by id only", async () => {
    writeLibrary(dir, [
      { id: "book-1", title: "One", filename: "one.epub" },
      { id: "book-2", title: "Two", filename: "two.epub" },
    ]);
    const catalog = await import("@/lib/store/catalog");
    const changed = catalog.renameBooks(new Map([["book-2", "Second"], ["book-9", "Nope"]]));
    expect([...changed]).toEqual(["book-2"]);
    expect(catalog.listBooks().map((b) => b.title)).toEqual(["One", "Second"]);
  });
});

describe("pages", () => {
  it("rejects malformed book ids before touching the disk", async () => {
    const pages = await import("@/lib/store/pages");
    expect(() => pages.saveBookPages("../evil", [{ label: "Page 1", text: "x" }])).toThrow(/Invalid book id/);
    expect(pages.loadBookPages("../evil")).toBeNull();
    expect(readdirSync(dir).filter((f) => f.includes("evil"))).toEqual([]);
  });

  it("re-reads a page map after it is saved again", async () => {
    const pages = await import("@/lib/store/pages");
    pages.saveBookPages("book-1", [{ label: "Chapter 1", text: "Alpha" }]);
    expect(pages.loadBookPages("book-1")?.[0].label).toBe("Chapter 1");
    pages.saveBookPages("book-1", [{ label: "Chapter 1 · Start", text: "Alpha" }]);
    expect(pages.loadBookPages("book-1")?.[0].label).toBe("Chapter 1 · Start");
    expect(pages.findPageForText("book-1", "alpha")).toBe("Chapter 1 · Start");
    expect(pages.findPageForText("book-1", "not in the book")).toBe("Unknown location");
  });
});
