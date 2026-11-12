import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDataDir, removeDataDir, writeLibrary } from "./store-env";

let dir: string;
let search: typeof import("@/lib/store/search");

beforeEach(async () => {
  dir = freshDataDir();
  writeLibrary(
    dir,
    [
      {
        id: "book-1",
        title: "Columbus Day",
        filename: "columbus day.epub",
        pages: [
          { label: "Chapter 1", text: "The ship left orbit. Our relationship with the Ruhar was over. Ship. SHIP!" },
          { label: "Chapter 2", text: "Skippy the Magnificent said, \"Trust the awesomeness.\" The beer   can laughed." },
        ],
      },
      {
        id: "book-2",
        title: "SpecOps",
        filename: "specops.epub",
        pages: [{ label: "Chapter 1", text: "Another ship arrived. Trust - the awesomeness, he said." }],
      },
      { id: "book-3", title: "No Text", filename: "none.epub" },
    ],
    [{ id: "series-1", name: "Expeditionary Force", bookIds: ["book-2"] }]
  );
  search = await import("@/lib/store/search");
});
afterEach(() => removeDataDir(dir));

describe("searchBookKeyword", () => {
  it("matches plain words as whole words, case-insensitively", () => {
    const hits = search.searchBookKeyword("book-1", ["ship"]);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.label === "Chapter 1")).toBe(true);
    expect(search.searchBookKeyword("book-1", ["relation"])).toHaveLength(0);
    expect(search.searchBookKeyword("book-1", ["relationship"])).toHaveLength(1);
  });

  it("matches phrases with punctuation as substrings and honours maxMatches", () => {
    expect(search.searchBookKeyword("book-1", ["beer can"])).toHaveLength(0)
    expect(search.searchBookKeyword("book-1", ["the magnificent"])).toHaveLength(1);
    expect(search.searchBookKeyword("book-1", ["ship"], 2)).toHaveLength(2);
    expect(search.searchBookKeyword("book-3", ["ship"])).toEqual([]);
    expect(search.searchBookKeyword("../x", ["ship"])).toEqual([]);
  });

  it("multi-book results carry the book id and the catalog title", () => {
    const all = search.searchAllBooksKeyword(["ship"]);
    expect(all.map((h) => h.bookId)).toEqual(["book-1", "book-1", "book-1", "book-2"]);
    expect(all[3].bookTitle).toBe("SpecOps");
    expect(search.searchSeriesKeyword("series-1", ["ship"]).map((h) => h.bookId)).toEqual(["book-2"]);
    expect(search.searchSeriesKeyword("series-missing", ["ship"])).toEqual([]);
  });
});

describe("countBookKeywordMentions", () => {
  it("whole_word (default) counts words, not substrings", () => {
    expect(search.countBookKeywordMentions("book-1", "ship")).toBe(3);
    expect(search.countBookKeywordMentions("book-1", "ship", "whole_word")).toBe(3);
  });

  it("phrase and loose count every occurrence", () => {
    expect(search.countBookKeywordMentions("book-1", "ship", "phrase")).toBe(4);
    expect(search.countBookKeywordMentions("book-1", "ship", "loose")).toBe(4);
  });

  it("whole_word lets the spaces of a phrase match any whitespace", () => {
    expect(search.countBookKeywordMentions("book-1", "beer can", "whole_word")).toBe(1);
    expect(search.countBookKeywordMentions("book-1", "beer can", "phrase")).toBe(0);
  });

  it("empty keywords and missing books count zero; regex characters are literal", () => {
    expect(search.countBookKeywordMentions("book-1", "  ")).toBe(0);
    expect(search.countBookKeywordMentions("book-3", "ship")).toBe(0);
    expect(search.countBookKeywordMentions("book-1", "s.ip", "phrase")).toBe(0);
  });

  it("per-book rows are sorted by count and skip books without hits", () => {
    expect(search.countAllBooksKeywordMentions("ship")).toEqual([
      { bookId: "book-1", bookTitle: "Columbus Day", count: 3 },
      { bookId: "book-2", bookTitle: "SpecOps", count: 1 },
    ]);
    expect(search.countSeriesKeywordMentions("series-1", "ship")).toEqual([
      { bookId: "book-2", bookTitle: "SpecOps", count: 1 },
    ]);
  });
});

describe("exact quote search", () => {
  it("finds an exact quote, case-insensitively", () => {
    const hits = search.searchExactQuoteInBook("book-1", "trust the awesomeness");
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe("Chapter 2");
    expect(hits[0].snippet).toContain("Trust the awesomeness");
  });

  it("tolerates different punctuation and spacing for quotes of four words or more", () => {
    expect(search.searchExactQuoteInBook("book-1", "the beer can laughed")).toHaveLength(1);
    expect(search.searchExactQuoteInBook("book-1", "beer can laughed")).toHaveLength(0); // three words: exact only
    expect(search.searchExactQuoteInBook("book-1", "   ")).toEqual([]);
  });

  it("searches every book or one series, with book ids", () => {
    const all = search.searchExactQuoteAllBooks("Trust the awesomeness, he said");
    expect(all.map((h) => [h.bookId, h.bookTitle])).toEqual([["book-2", "SpecOps"]]);
    expect(search.searchExactQuoteAllBooks("trust the awesomeness").map((h) => h.bookId)).toEqual(["book-1"]);
    expect(search.searchExactQuoteInSeries("series-1", "another ship arrived").map((h) => h.bookId)).toEqual(["book-2"]);
  });
});
