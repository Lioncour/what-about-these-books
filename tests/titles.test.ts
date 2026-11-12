import { describe, expect, it } from "vitest";
import { cleanIngestTitle } from "../src/lib/series-detection";
import { extractWhoIsTarget, shouldBypassSpecialists } from "../src/lib/chat/intent";

describe("cleanIngestTitle", () => {
  it("prefers the book's metadata title", () => {
    expect(
      cleanIngestTitle({ filename: "whatever.epub", metadataTitle: "Columbus Day", author: "Craig Alanson" })
    ).toBe("Columbus Day");
  });

  it("strips author, format and series tails from filenames", () => {
    expect(
      cleanIngestTitle({
        filename: "paradise expeditionary force book 3 alanson craig.epub",
        author: "Craig Alanson",
        seriesName: "Expeditionary Force",
      })
    ).toBe("Paradise");
    expect(
      cleanIngestTitle({ filename: "SpecOps Craig Alanson (EPUB).epub", author: "Craig Alanson" })
    ).toBe("SpecOps");
    expect(
      cleanIngestTitle({
        filename: "Mavericks (Expeditionary Force Book 6) Craig Alanson.epub",
        author: "Craig Alanson",
        seriesName: "Expeditionary Force",
      })
    ).toBe("Mavericks");
  });

  it("falls back to the filename when nothing is left", () => {
    expect(cleanIngestTitle({ filename: "Craig Alanson.epub", author: "Craig Alanson" })).toBe(
      "Craig Alanson"
    );
  });
});

describe("intent heuristics", () => {
  it("who-is accepts names and single lower-case words, not function words", () => {
    expect(extractWhoIsTarget("Who is Skippy?")).toBe("Skippy");
    expect(extractWhoIsTarget("who is skippy?")).toBe("skippy");
    expect(extractWhoIsTarget("Who is Joe in love with?")).toBe("Joe");
    expect(extractWhoIsTarget("Who is the author?")).toBeNull();
  });

  it("'they' and short plot questions are not small talk", () => {
    expect(shouldBypassSpecialists("Who are they fighting?")).toBe(false);
    expect(shouldBypassSpecialists("Does Joe survive?")).toBe(false);
    expect(shouldBypassSpecialists("hey there")).toBe(true);
  });
});
