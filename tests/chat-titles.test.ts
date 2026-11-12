import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/book-store", () => ({
  listBooks: () => [
    { id: "book-1", title: "paradise star run book 3 vance jo", author: "Jo Vance", seriesId: "series-1" },
    { id: "book-2", title: "Silver Noon Jo Vance (EPUB)", author: "Jo Vance", seriesId: "series-1" },
    { id: "book-3", title: "Lonely Harbor", author: "Ann Reed" },
  ],
  listSeries: () => [{ id: "series-1", name: "Star Run", bookIds: ["book-1", "book-2"] }],
}));

import { cleanBookDisplayTitle } from "@/lib/chat/display-title";

const hints = { author: "Jo Vance", seriesName: "Star Run" };

describe("cleanBookDisplayTitle", () => {
  it("uses the catalog's author and series for a known title", () => {
    expect(cleanBookDisplayTitle("paradise star run book 3 vance jo")).toBe("paradise");
    expect(cleanBookDisplayTitle("Silver Noon Jo Vance (EPUB)")).toBe("Silver Noon");
    expect(cleanBookDisplayTitle("Lonely Harbor")).toBe("Lonely Harbor");
  });

  it("strips series tails, author names and format tags given as hints", () => {
    expect(cleanBookDisplayTitle("Mavericks (Star Run Book 6) Jo Vance", hints)).toBe("Mavericks");
    expect(cleanBookDisplayTitle("Star Run Book 2 - Silver Noon", hints)).toBe("Silver Noon");
    expect(cleanBookDisplayTitle("Silver Noon: Star Run", hints)).toBe("Silver Noon");
    expect(cleanBookDisplayTitle("Silver Noon by Jo Vance", hints)).toBe("Silver Noon");
    expect(cleanBookDisplayTitle("Vance, Jo - Silver Noon [PDF]", hints)).toBe("Silver Noon");
  });

  it("only removes format tags when it knows nothing about the book", () => {
    expect(cleanBookDisplayTitle("Unknown Tale (EPUB)")).toBe("Unknown Tale");
    expect(cleanBookDisplayTitle("Unknown Tale Expeditionary Force Book 3 Craig Alanson")).toBe(
      "Unknown Tale Expeditionary Force Book 3 Craig Alanson"
    );
  });

  it("leaves real titles alone", () => {
    expect(cleanBookDisplayTitle("Children of Dune", { author: "Frank Herbert", seriesName: "Dune" })).toBe("Children of Dune");
    expect(cleanBookDisplayTitle("Dune Messiah", { author: "Frank Herbert", seriesName: "Dune" })).toBe("Dune Messiah");
    expect(cleanBookDisplayTitle("Dune", { author: "Frank Herbert", seriesName: "Dune" })).toBe("Dune");
    expect(cleanBookDisplayTitle("Mr. Mercedes", { author: "Stephen King" })).toBe("Mr. Mercedes");
    expect(cleanBookDisplayTitle("Catch-22", { author: "Joseph Heller" })).toBe("Catch-22");
    expect(
      cleanBookDisplayTitle("The Autobiography of Benjamin Franklin", { author: "Benjamin Franklin" })
    ).toBe("The Autobiography of Benjamin Franklin");
    expect(cleanBookDisplayTitle("Jo Vance", hints)).toBe("Jo Vance");
  });
});
