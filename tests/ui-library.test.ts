import { describe, expect, it } from "vitest";
import {
  bookEditPatch,
  coverFileProblem,
  coverUrl,
  deleteSeriesQuestion,
  formatWordCount,
  groupShelf,
  mergePlan,
  removeBookQuestion,
  seriesFixLines,
} from "../src/components/library/shelf";
import type { Book, Series } from "../src/components/library/types";
import { isDuplicateError, uploadProblem, DuplicateBookError } from "../src/components/upload/extract";

const book = (id: string, extra: Partial<Book> = {}): Book => ({
  id,
  title: id,
  wordCount: 1000,
  filename: `${id}.epub`,
  addedAt: "2026-01-01",
  ...extra,
});

describe("groupShelf", () => {
  const books = [
    book("b", { seriesOrder: 2 }),
    book("a", { seriesOrder: 1 }),
    book("loose", { author: "Ann Leckie" }),
  ];
  const series: Series[] = [
    { id: "s", name: "S", bookIds: ["b", "a", "missing"], createdAt: "" },
    { id: "empty", name: "Empty", bookIds: [], createdAt: "" },
  ];

  it("puts series books in reading order and the rest under ungrouped", () => {
    const shelf = groupShelf(books, series, "");
    expect(shelf.series.map((s) => s.id)).toEqual(["s"]);
    expect(shelf.series[0].books.map((b) => b.id)).toEqual(["a", "b"]);
    expect(shelf.ungrouped.map((b) => b.id)).toEqual(["loose"]);
  });

  it("filters by title or author, hiding series with no match", () => {
    const shelf = groupShelf(books, series, "leckie");
    expect(shelf.series).toEqual([]);
    expect(shelf.ungrouped.map((b) => b.id)).toEqual(["loose"]);
  });
});

describe("dialog wording", () => {
  it("names the book and the series", () => {
    expect(removeBookQuestion("Columbus Day")).toBe(
      "Remove “Columbus Day” from your library? Its text, index and notes about it go too."
    );
    expect(deleteSeriesQuestion("Dune")).toContain("“Dune”");
  });

  it("keeps the oldest copy when merging", () => {
    const plan = mergePlan({
      key: "k",
      books: [book("new", { addedAt: "2026-03-01" }), book("old", { addedAt: "2025-01-01" })],
    });
    expect(plan?.keep.id).toBe("old");
    expect(plan?.remove.map((b) => b.id)).toEqual(["new"]);
    expect(mergePlan({ key: "k", books: [book("only")] })).toBeNull();
  });

  it("lists what a series fix did, zero when unreported", () => {
    expect(seriesFixLines({ updatedBooks: 3 })).toEqual([
      "Updated books: 3",
      "Ordered books: 0",
      "Created: 0",
      "Merged folders: 0",
      "Removed junk: 0",
      "Open Library matches: 0",
    ]);
  });
});

describe("editing a book", () => {
  const original = { id: "b1", title: "Columbus Day", author: "Craig Alanson" };

  it("sends only what changed", () => {
    expect(bookEditPatch(original, { title: "Columbus Day", author: "Craig Alanson" })).toBeNull();
    expect(bookEditPatch(original, { title: " Columbus  Day! ", author: "Craig Alanson" })).toEqual({
      bookId: "b1",
      title: "Columbus Day!",
    });
    expect(bookEditPatch(original, { title: "Columbus Day", author: "" })).toEqual({
      bookId: "b1",
      author: "",
    });
  });

  it("refuses an empty title", () => {
    expect(bookEditPatch(original, { title: "  ", author: "x" })).toEqual({
      error: "A book needs a title.",
    });
  });

  it("accepts png/jpeg/webp covers up to 5 MB", () => {
    expect(coverFileProblem({ type: "image/webp", size: 5 * 1024 * 1024 })).toBe("");
    expect(coverFileProblem({ type: "image/gif", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(coverFileProblem({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
  });

  it("changes the cover URL only after an upload", () => {
    expect(coverUrl("b1")).toBe("/api/covers/b1");
    expect(coverUrl("b1", 42)).toBe("/api/covers/b1?v=42");
  });
});

describe("small formatting and upload checks", () => {
  it("formats word counts", () => {
    expect(formatWordCount(950)).toBe("950 words");
    expect(formatWordCount(123456)).toBe("123.5k words");
  });

  it("skips unsupported or oversized uploads", () => {
    expect(uploadProblem({ name: "book.EPUB", size: 10 })).toBe("");
    expect(uploadProblem({ name: "notes.docx", size: 10 })).toMatch(/unsupported format/);
    expect(uploadProblem({ name: "big.pdf", size: 51 * 1024 * 1024 })).toMatch(/too large/);
  });

  it("recognises a duplicate-book failure", () => {
    expect(isDuplicateError(new DuplicateBookError("x"))).toBe(true);
    expect(isDuplicateError(new Error("You have this book already"))).toBe(true);
    expect(isDuplicateError(new Error("Boom"))).toBe(false);
  });
});
