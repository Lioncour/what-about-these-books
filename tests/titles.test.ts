import { describe, expect, it } from "vitest";
import { cleanIngestTitle } from "../src/lib/series-detection";
import { extractBooksMentioningTarget, extractWhoIsTarget, shouldBypassSpecialists } from "../src/lib/chat/intent";

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

  describe("truncated and odd filenames from the real library", () => {
    const clean = (name: string, seriesName: string | null = "Expeditionary Force") =>
      cleanIngestTitle({ filename: `${name}.epub`, author: "Craig Alanson", seriesName });

    it.each([
      ["Failure Mode (Expeditionary For Craig Alanson", "Failure Mode"],
      ["Fallout Expeditionary Force Bo Craig Alanson", "Fallout"],
      ["9 Valkyrie (Expeditionary Force) Craig Alanson", "Valkyrie"],
      ["Critical Mass (Expeditionary Force #10) by Craig Alanson", "Critical Mass"],
      ["Match Game (Expeditionary Force Book 14) Craig Alanson", "Match Game"],
      ["Craig Alanson Task Force Hammer", "Task Force Hammer"],
      ["Craig Alanson Columbus Day", "Columbus Day"],
    ])("%s → %s", (filename, title) => {
      expect(clean(filename)).toBe(title);
    });

    it("handles other cut-off tails", () => {
      expect(clean("Armageddon (Expeditionary Force Book")).toBe("Armageddon");
      expect(clean("Renegades (Expeditionary Force Book 7) Craig Alans")).toBe("Renegades");
      expect(clean("Zero Hour (Expeditionary Force, Book 5) - Craig Alanson")).toBe("Zero Hour");
      expect(clean("03 - Paradise - Craig Alanson")).toBe("Paradise");
      // A bracket that never closes is dropped even when the series isn't known.
      expect(clean("Black Ops (Expeditionary Force Bo", null)).toBe("Black Ops");
    });

    it("leaves real title words alone", () => {
      // "Force" is part of the title, not a fragment of the series name.
      expect(clean("Task Force Hammer")).toBe("Task Force Hammer");
      // Only a series number is stripped from the front, and only when a series is known.
      expect(clean("1984", null)).toBe("1984");
      expect(clean("2001 A Space Odyssey", null)).toBe("2001 A Space Odyssey");
      // The last word of a title is not a truncated series name.
      expect(
        cleanIngestTitle({ filename: "Children of Dune.epub", author: "Frank Herbert", seriesName: "Dune Chronicles" })
      ).toBe("Children of Dune");
    });
  });
});

describe("intent heuristics", () => {
  it("who-is accepts names and single lower-case words, not function words", () => {
    expect(extractWhoIsTarget("Who is Skippy?")).toBe("Skippy");
    expect(extractWhoIsTarget("who is skippy?")).toBe("skippy");
    // A question about the person is not a "who is" lookup; a place after the name is fine.
    expect(extractWhoIsTarget("Who is Joe in love with?")).toBeNull();
    expect(extractWhoIsTarget("Who is Joe and why does he matter?")).toBeNull();
    expect(extractWhoIsTarget("Who is Skippy in Columbus Day?")).toBe("Skippy");
    expect(extractWhoIsTarget("Who is the author?")).toBeNull();
  });

  it("'they' and short plot questions are not small talk", () => {
    expect(shouldBypassSpecialists("Who are they fighting?")).toBe(false);
    expect(shouldBypassSpecialists("Does Joe survive?")).toBe(false);
    expect(shouldBypassSpecialists("hey there")).toBe(true);
  });
});

describe("extractBooksMentioningTarget", () => {
  it.each([
    ["Which books in my library mention Mars?", "Mars"],
    // A capitalised name keeps its article, as in the counts.
    ["which books mention the Elders?", "the Elders"],
    ["which books mention the planet?", "planet"],
    ["Which books mention the Elders?".replace("the Elders", "The Elders"), "The Elders"],
    ["Which of the books reference Star Trek", "Star Trek"],
    ["In which books is Skippy mentioned?", "Skippy"],
    ["Does any book mention a beer can?", "beer can"],
    ["What books does Count Chocula appear in?", "Count Chocula"],
    ["Which books mention the word \"monkey\"?", "monkey"],
  ])("%s → %s", (question, target) => {
    expect(extractBooksMentioningTarget(question)).toBe(target);
  });

  it.each([
    "Which books talk about grief?",
    "Which book should I reread?",
    "Which books mention the time Joe got stuck in the airlock with Skippy?",
    "How many times is Skippy mentioned?",
    "Which books mention it?",
  ])("leaves %s to the other routes", (question) => {
    expect(extractBooksMentioningTarget(question)).toBeNull();
  });
});
