import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataDir, removeDataDir, writeLibrary } from "./store-env";

// The tidy never touches the vector index; make sure a stray import can't reach Bedrock.
vi.mock("vectra/lib/LocalDocumentIndex", () => ({ LocalDocumentIndex: class {} }));
vi.mock("@/lib/bedrock-embeddings", () => ({ BedrockEmbeddings: class {} }));

const FLOW = [
  { label: "Chapter 1", text: "Failure Mode Craig Alanson" },
  { label: "Chapter 2", text: "Copyright © 2020 Craig Alanson" },
  { label: "Chapter 3", text: "CHAPTER ONE SKIPPY I woke up." },
  { label: "Chapter 4", text: "CHAPTER TWO The ship was quiet." },
];

let dir: string;
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(dir, ...parts), "utf-8"));

beforeEach(() => {
  dir = freshDataDir();
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
        pages: FLOW,
      },
      {
        // Hand-edited title: not what the filename gives, so it stays.
        id: "book-2",
        title: "My Favourite One",
        filename: "9 Valkyrie (Expeditionary Force) Craig Alanson.epub",
        author: "Craig Alanson",
        fileType: "EPUB",
        seriesId: "series-1",
        pages: [{ label: "Chapter 1", text: "No headings in this one." }],
      },
      {
        // Would become "Columbus Day", which book-4 already has: skipped.
        id: "book-3",
        title: "Craig Alanson Columbus Day",
        filename: "Craig Alanson Columbus Day.pdf",
        author: "Craig Alanson",
        fileType: "PDF",
        seriesId: "series-1",
        pages: [
          { label: "Page 1", text: "CHAPTER ONE A PDF keeps its page labels." },
          { label: "Page 2", text: "CHAPTER TWO Still pages." },
        ],
      },
      { id: "book-4", title: "Columbus Day", filename: "other.txt", fileType: "TXT" },
    ],
    [{ id: "series-1", name: "Expeditionary Force", bookIds: ["book-1", "book-2", "book-3"] }]
  );
  mkdirSync(join(dir, "chats"), { recursive: true });
  writeFileSync(
    join(dir, "chats", "chat-1.json"),
    JSON.stringify({ id: "chat-1", bookId: "book-1", bookTitle: "old", title: "t", messages: [], updatedAt: "x" })
  );
  mkdirSync(join(dir, "specialists"), { recursive: true });
  writeFileSync(
    join(dir, "specialists", "book-1.json"),
    JSON.stringify({ bookId: "book-1", bookTitle: "old", summary: "s", keyTopics: [], notableEntities: [], styleNotes: [], updatedAt: "x" })
  );
});
afterEach(() => removeDataDir(dir));

const EXPECTED = {
  titles: [{ id: "book-1", from: "Failure Mode (Expeditionary For Craig Alanson", to: "Failure Mode" }],
  labels: [{ id: "book-1", title: "Failure Mode", changed: 4 }],
};

describe("tidyLibrary", () => {
  it("dry run reports the changes and writes nothing", async () => {
    const { tidyLibrary } = await import("@/lib/store/tidy");
    const before = readFileSync(join(dir, "books.json"), "utf-8");
    expect(tidyLibrary({ dryRun: true })).toEqual({ ...EXPECTED, dryRun: true });
    expect(readFileSync(join(dir, "books.json"), "utf-8")).toBe(before);
    expect(readJson("texts", "book-1.json")).toEqual(FLOW);
    expect(existsSync(join(dir, "backups"))).toBe(false);
    expect(readJson("chats", "chat-1.json").bookTitle).toBe("old");
  });

  it("real run backs up first, then renames and relabels without touching text", async () => {
    const { tidyLibrary } = await import("@/lib/store/tidy");
    const { listBooks } = await import("@/lib/store/catalog");
    const { loadBookPages } = await import("@/lib/store/pages");
    expect(loadBookPages("book-1")?.[2].label).toBe("Chapter 3"); // warm the cache

    expect(tidyLibrary()).toEqual({ ...EXPECTED, dryRun: false });

    // The snapshot holds the library as it was.
    const backups = readdirSync(join(dir, "backups"));
    expect(backups).toHaveLength(1);
    expect(readJson("backups", backups[0], "books.json").books[0].title).toBe(
      "Failure Mode (Expeditionary For Craig Alanson"
    );
    expect(readJson("backups", backups[0], "texts", "book-1.json")).toEqual(FLOW);

    expect(listBooks().map((b) => b.title)).toEqual([
      "Failure Mode",
      "My Favourite One",
      "Craig Alanson Columbus Day",
      "Columbus Day",
    ]);
    const pages = loadBookPages("book-1")!;
    expect(pages.map((p) => p.label)).toEqual(["Front matter", "Copyright", "Chapter 1 · Skippy", "Chapter 2"]);
    expect(pages.map((p) => p.text)).toEqual(FLOW.map((p) => p.text));
    // Untouched: no headings, and a PDF.
    expect(loadBookPages("book-2")?.[0].label).toBe("Chapter 1");
    expect(loadBookPages("book-3")?.map((p) => p.label)).toEqual(["Page 1", "Page 2"]);

    // Copies of the title in other stores follow the rename.
    expect(readJson("chats", "chat-1.json").bookTitle).toBe("Failure Mode");
    expect(readJson("specialists", "book-1.json").bookTitle).toBe("Failure Mode");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("is idempotent: a second run finds nothing and takes no backup", async () => {
    const { tidyLibrary } = await import("@/lib/store/tidy");
    tidyLibrary();
    expect(tidyLibrary()).toEqual({ titles: [], labels: [], dryRun: false });
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
  });

  it("skips catalog entries with malformed ids", async () => {
    writeLibrary(dir, [
      { id: "../evil", title: "evil book 1", filename: "evil book 1.epub", fileType: "EPUB", pages: undefined },
    ]);
    const { tidyLibrary } = await import("@/lib/store/tidy");
    expect(tidyLibrary()).toEqual({ titles: [], labels: [], dryRun: false });
  });
});
