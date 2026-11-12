import { describe, expect, it } from "vitest";
import {
  chapterLabelFromText,
  epubSectionLabels,
  firstHtmlHeading,
  parseChapterHeading,
  relabelEpubPages,
  titleCaseHeading,
} from "@/lib/store/labels";

describe("chapterLabelFromText", () => {
  it("reads the number and title from an upper-case heading", () => {
    expect(chapterLabelFromText("CHAPTER TEN SKIPPY I woke up with a headache.")).toBe("Chapter 10 · Skippy");
    expect(chapterLabelFromText("CHAPTER ONE It was a dark night.")).toBe("Chapter 1");
    expect(chapterLabelFromText('CHAPTER TWENTY-ONE THE BEER CAN "Hey, Joe," he said.')).toBe(
      "Chapter 21 · The Beer Can"
    );
    expect(chapterLabelFromText("CHAPTER NINETY NINE The end was near.")).toBe("Chapter 99");
    expect(chapterLabelFromText("CHAPTER ONE HUNDRED AND FIVE We left.")).toBe("Chapter 105");
  });

  it("reads digits, roman numerals and mixed case", () => {
    expect(chapterLabelFromText("Chapter 10: Skippy I woke up.")).toBe("Chapter 10 · Skippy");
    expect(chapterLabelFromText("Chapter 10 Skippy woke up.")).toBe("Chapter 10");
    expect(chapterLabelFromText("Chapter 3 - The Long Night Joe looked up at the sky.")).toBe(
      "Chapter 3 · The Long Night"
    );
    expect(chapterLabelFromText("CHAPTER XIV Nothing happened.")).toBe("Chapter 14");
    expect(chapterLabelFromText("CHAPTER IV THE RETURN OF THE KING They rode on.")).toBe(
      "Chapter 4 · The Return of the King"
    );
    expect(chapterLabelFromText("Chapter Twelve She ran.")).toBe("Chapter 12");
  });

  it("names prologue, epilogue and other named sections", () => {
    expect(chapterLabelFromText("PROLOGUE The ship drifted.")).toBe("Prologue");
    expect(chapterLabelFromText("Epilogue Joe went home.")).toBe("Epilogue");
    expect(chapterLabelFromText("Copyright © 2016 Craig Alanson All rights reserved")).toBe("Copyright");
    expect(chapterLabelFromText("ABOUT THE AUTHOR Craig lives in")).toBe("About the author");
    expect(chapterLabelFromText("Introduction to quantum physics is hard.")).toBeNull();
  });

  it("prefers the chapter inside a part heading", () => {
    expect(chapterLabelFromText("PART ONE CHAPTER ONE We landed.")).toBe("Chapter 1");
    expect(chapterLabelFromText("PART TWO THE WAR It began.")).toBe("Part 2 · The War");
  });

  it("accepts a bare spelled-out number only when prose follows", () => {
    expect(chapterLabelFromText("TEN The morning was cold.")).toBe("Chapter 10");
    expect(chapterLabelFromText("ONE MORNING, Joe woke up.")).toBeNull();
  });

  it("returns null for ordinary prose and odd input", () => {
    expect(chapterLabelFromText("I woke up with a headache.")).toBeNull();
    expect(chapterLabelFromText("Chapter and verse were quoted.")).toBeNull();
    expect(chapterLabelFromText("chapter 3 of the manual says")).toBeNull();
    expect(chapterLabelFromText("CHAPTER TWENTY-SOMETHING")).toBeNull();
    expect(chapterLabelFromText("")).toBeNull();
    expect(chapterLabelFromText("CHAPTER constructor")).toBeNull();
  });

  it("caps long titles at about 40 characters", () => {
    const label = chapterLabelFromText("CHAPTER TWO IN WHICH OUR HERO DISCOVERS SOMETHING VERY SURPRISING he said")!;
    expect(label.startsWith("Chapter 2 · In Which Our Hero")).toBe(true);
    expect(label.length).toBeLessThanOrEqual("Chapter 2 · ".length + 41);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("parseChapterHeading (whole heading)", () => {
  it("takes everything after the number as the title", () => {
    expect(parseChapterHeading("Chapter 10: Skippy the Magnificent", { whole: true })).toEqual({
      kind: "chapter",
      number: 10,
      word: "Chapter",
      title: "Skippy the Magnificent",
    });
    expect(parseChapterHeading("TEN", { whole: true })?.number).toBe(10);
  });

  it("title-cases, keeping roman numerals and small words", () => {
    expect(titleCaseHeading("SKIPPY'S BIG DAY")).toBe("Skippy's Big Day");
    expect(titleCaseHeading("WORLD WAR II AND THE AFTERMATH")).toBe("World War II and the Aftermath");
  });
});

describe("epubSectionLabels", () => {
  const flow = [
    "Columbus Day by Craig Alanson",
    "Copyright © 2016 Craig Alanson",
    "CHAPTER ONE COLUMBUS DAY The Ruhar hit us on Columbus Day.",
    "CHAPTER TWO PARADISE We shipped out.",
    "More of the same chapter without a heading.",
    "CHAPTER TWO PARADISE Again, a duplicate heading.",
    "EPILOGUE It was over.",
  ];

  it("labels by heading, with neutral labels for the rest", () => {
    expect(epubSectionLabels(flow)).toEqual([
      "Front matter",
      "Copyright",
      "Chapter 1 · Columbus Day",
      "Chapter 2 · Paradise",
      "Section 5",
      "Chapter 2 · Paradise (2)",
      "Epilogue",
    ]);
  });

  it("leaves a book alone when fewer than two chapter headings are found", () => {
    expect(epubSectionLabels(["Some text.", "CHAPTER ONE Only one.", "More text."])).toBeNull();
    const pages = [
      { label: "Chapter 1", text: "Some text." },
      { label: "Chapter 2", text: "More text." },
    ];
    expect(relabelEpubPages(pages)).toEqual(pages);
  });

  it("uses the heading element when the section starts with it", () => {
    const html = "<html><body><h1 class='c'>Chapter 3: The <i>Long</i> Night</h1><p>Joe Bishop looked up.</p></body></html>";
    const hint = firstHtmlHeading(html);
    expect(hint).toBe("Chapter 3: The Long Night");
    const texts = ["Chapter 3: The Long Night Joe Bishop looked up.", "Chapter 4: Dawn The sun rose."];
    expect(epubSectionLabels(texts, [hint, "Unrelated Heading"])).toEqual([
      "Chapter 3 · The Long Night",
      "Chapter 4 · Dawn",
    ]);
  });

  it("never changes page text", () => {
    const pages = flow.map((text, i) => ({ label: `Chapter ${i + 1}`, text }));
    const next = relabelEpubPages(pages);
    expect(next.map((p) => p.text)).toEqual(flow);
    expect(next[2].label).toBe("Chapter 1 · Columbus Day");
    expect(pages[2].label).toBe("Chapter 3");
  });
});
