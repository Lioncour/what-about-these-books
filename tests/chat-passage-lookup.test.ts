import { beforeEach, describe, expect, it, vi } from "vitest";

const books = [
  { id: "book-1", title: "Columbus Day" },
  { id: "book-2", title: "Black Ops" },
  { id: "book-3", title: "Ops" },
];

const pagesByBook: Record<string, Array<{ label: string; text: string }>> = {
  "book-1": [
    { label: "Front matter", text: "Copyright and dedication." },
    { label: "Chapter 1 · The Morning", text: "CHAPTER ONE\nIt was a quiet morning   in Maine, until the sky fell." },
    {
      label: "Chapter 10 · Skippy",
      text: "CHAPTER TEN SKIPPY The Dodo only flew another twenty minutes, before landing at an old Ruhar base.\n“I think I’ll call you Skippy.” “Don’t call me that, monkey.”",
    },
    { label: "Chapter 12", text: "Later on, the beer can had opinions about everything." },
  ],
  "book-2": [{ label: "Chapter 1", text: "A different book entirely, with a beer can in it." }],
  "book-3": [{ label: "Chapter 1", text: "Short title book." }],
};

vi.mock("@/lib/book-store", () => ({
  listBooks: () => books,
  getBookById: (id: string) => books.find((b) => b.id === id) || null,
  loadBookPages: (id: string) => pagesByBook[id] || null,
}));
vi.mock("@/lib/chat/display-title", () => ({
  cleanBookDisplayTitle: (t: string) => t.replace(/\s*\((?:EPUB|PDF|TXT)\)\s*/gi, " ").trim(),
}));

import {
  excerptProbes,
  findPageIndexByLabel,
  lookupPassage,
  rankBooksByTitle,
} from "@/lib/chat/passage-lookup";

beforeEach(() => vi.clearAllMocks());

describe("lookupPassage", () => {
  it("finds the page by the citation's words, not by a stale label", () => {
    // Saved before the library was tidied: flow label "Chapter 12", old long title.
    const hit = lookupPassage({
      book: "Craig Alanson Columbus Day",
      position: "Chapter 12",
      excerpt: "CHAPTER TEN SKIPPY The Dodo only flew another twenty minutes, before landing at an old Ruh…",
    });
    expect(hit?.bookId).toBe("book-1");
    expect(hit?.position).toBe("Chapter 10 · Skippy");
    expect(hit?.matchedBy).toBe("excerpt");
    expect(hit!.text.slice(hit!.matchStart!, hit!.matchStart! + hit!.matchLength!)).toMatch(/^CHAPTER TEN SKIPPY The Dodo/);
  });

  it("matches through quote styles, wrapping quotes and collapsed whitespace", () => {
    const hit = lookupPassage({
      bookId: "book-1",
      position: "somewhere",
      excerpt: '"I think I\'ll call you Skippy." "Don\'t call me that, monkey."',
    });
    expect(hit?.position).toBe("Chapter 10 · Skippy");
    const spaced = lookupPassage({ bookId: "book-1", excerpt: "It was a quiet morning in Maine, until" });
    expect(spaced?.position).toBe("Chapter 1 · The Morning");
  });

  it("uses the words to find the book when the title resolves to nothing", () => {
    const hit = lookupPassage({ book: "Some Renamed Thing", excerpt: "the beer can had opinions about everything" });
    expect(hit?.bookId).toBe("book-1");
    expect(hit?.position).toBe("Chapter 12");
  });

  it("falls back to the label, then to the start, and says which", () => {
    const byLabel = lookupPassage({ bookId: "book-1", position: "Chapter 10 (SKIPPY) / later context", excerpt: "words that are not in the book at all" });
    expect(byLabel?.position).toBe("Chapter 10 · Skippy");
    expect(byLabel?.matchedBy).toBe("label");
    expect(byLabel?.matchStart).toBeUndefined();

    const start = lookupPassage({ bookId: "book-1", position: "Appendix Q" });
    expect(start?.position).toBe("Front matter");
    expect(start?.matchedBy).toBe("start");
  });

  it("returns null for an unknown book with nothing to search for", () => {
    expect(lookupPassage({ book: "No Such Book" })).toBeNull();
  });
});

describe("findPageIndexByLabel", () => {
  const pages = pagesByBook["book-1"].map((p) => ({ ...p }));
  it("does not confuse chapter 1 with chapter 10", () => {
    expect(findPageIndexByLabel(pages, "Chapter 1")).toBe(1);
    expect(findPageIndexByLabel(pages, "chapter 10")).toBe(2);
    expect(findPageIndexByLabel(pages, "Chapter 12")).toBe(3);
  });
  it("returns -1 when nothing fits", () => {
    expect(findPageIndexByLabel(pages, "Chapter 99")).toBe(-1);
    expect(findPageIndexByLabel(pages, "")).toBe(-1);
  });
});

describe("rankBooksByTitle", () => {
  it("prefers an exact title, then the longest contained one", () => {
    expect(rankBooksByTitle("Ops", books)[0].id).toBe("book-3");
    expect(rankBooksByTitle("Black Ops Craig Alanson (EPUB)", books).map((b) => b.id)).toEqual(["book-2", "book-3"]);
    expect(rankBooksByTitle("Craig Alanson Columbus Day", books)[0].id).toBe("book-1");
  });
  it("matches whole words only", () => {
    expect(rankBooksByTitle("Blackops", books)).toEqual([]);
  });
});

describe("excerptProbes", () => {
  it("tries the longest unbroken run first, then shorter openings", () => {
    const probes = excerptProbes("“short bit”… and then a much longer unbroken run of words follows right here …");
    expect(probes[0]).toBe("and then a much longer unbroken run of words follows right here");
    expect(probes.some((p) => p.length <= 30)).toBe(true);
  });
  it("ignores fragments too short to be distinctive", () => {
    expect(excerptProbes("he said")).toEqual([]);
  });
});
