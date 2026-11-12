import { describe, expect, it } from "vitest";
import {
  cleanDisplayTitle,
  formatDuration,
  formatLabelSummary,
  askingHint,
  formatAskingLine,
  formatScopeLine,
  formatTitlesPhrase,
  formatTokenCount,
  formatUsageLine,
  parseScope,
  parseUsage,
  scopeReasonHint,
  type ScopeInfo,
} from "../src/components/chat/format";
import {
  chatTitleFrom,
  fromSavedMessages,
  toSavedMessage,
} from "../src/components/chat/messages";

const books = (...titles: string[]) => titles.map((title, i) => ({ id: `b${i}`, title }));

describe("formatScopeLine", () => {
  it("names a single book", () => {
    expect(formatScopeLine({ books: books("Columbus Day"), reason: "named" })).toBe(
      "Read from Columbus Day"
    );
  });

  it("lists up to three titles and counts the rest", () => {
    const scope: ScopeInfo = { books: books("A", "B", "C"), reason: "series", more: 3 };
    expect(formatScopeLine(scope)).toBe("Read from 6 books: A, B, C +3");
    expect(formatScopeLine({ books: books("A", "B", "C", "D", "E"), reason: "semantic" })).toBe(
      "Read from 5 books: A, B, C +2"
    );
    expect(formatScopeLine({ books: books("A", "B"), reason: "semantic" })).toBe(
      "Read from 2 books: A, B"
    );
  });

  it("copes with no listed books", () => {
    expect(formatScopeLine({ books: [], reason: "all" })).toBe("Read from the whole library");
    expect(formatScopeLine({ books: [], reason: "all", more: 12 })).toBe("Read from 12 books");
  });

  it("shows cleaned titles", () => {
    expect(formatScopeLine({ books: books("Columbus Day (EPUB)"), reason: "focus" })).toBe(
      "Read from Columbus Day"
    );
  });
});

describe("scopeReasonHint", () => {
  it("has a hint for every reason", () => {
    expect(scopeReasonHint("named")).toBe("named in your question");
    expect(scopeReasonHint("focus")).toBe("your focus book");
    expect(scopeReasonHint("series")).toBe("this series");
    expect(scopeReasonHint("semantic")).toBe("closest matches");
    expect(scopeReasonHint("all")).toBe("whole library");
  });
});

describe("formatUsageLine", () => {
  it("shows calls, tokens and time, never money", () => {
    const line = formatUsageLine({
      claudeCalls: 2,
      inputTokens: 10_480,
      outputTokens: 1_210,
      embedCalls: 1,
      ms: 12_300,
    });
    expect(line).toBe("2 calls · 10.5k tokens in · 1.2k out · 12 s");
    expect(line).not.toMatch(/[$€]/);
  });

  it("uses the singular for one call", () => {
    expect(
      formatUsageLine({ claudeCalls: 1, inputTokens: 850, outputTokens: 90, embedCalls: 0, ms: 2400 })
    ).toBe("1 call · 850 tokens in · 90 out · 2.4 s");
  });

  it("says so when no AI was called", () => {
    expect(
      formatUsageLine({ claudeCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 0, ms: 300 })
    ).toBe("No AI calls · exact text search · 0.3 s");
    expect(
      formatUsageLine({ claudeCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 2, ms: 800 })
    ).toBe("No AI answer calls · 2 meaning searches · 0.8 s");
  });
});

describe("formatTokenCount / formatDuration", () => {
  it("abbreviates token counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(10_500)).toBe("10.5k");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(40)).toBe("0.1 s");
    expect(formatDuration(300)).toBe("0.3 s");
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(75_000)).toBe("1 min 15 s");
    expect(formatDuration(120_000)).toBe("2 min");
  });
});

describe("parseScope / parseUsage", () => {
  it("reads the server's payloads", () => {
    expect(
      parseScope('{"books":[{"id":"a","title":"Columbus Day"}],"reason":"named","more":2}')
    ).toEqual({ books: [{ id: "a", title: "Columbus Day" }], reason: "named", more: 2 });
    expect(
      parseUsage('{"claudeCalls":2,"inputTokens":10,"outputTokens":5,"embedCalls":1,"ms":900}')
    ).toEqual({ claudeCalls: 2, inputTokens: 10, outputTokens: 5, embedCalls: 1, ms: 900 });
  });

  it("rejects junk instead of throwing", () => {
    expect(parseScope("not json")).toBeNull();
    expect(parseScope('{"reason":"named"}')).toBeNull();
    expect(parseScope('{"books":[],"reason":"named"}')).toBeNull();
    expect(parseUsage("[]")).toBeNull();
    expect(parseUsage('{"other":1}')).toBeNull();
  });

  it("falls back on an unknown reason and bad numbers", () => {
    expect(parseScope('{"books":[{"id":"a","title":"A"}],"reason":"vibes"}')?.reason).toBe("all");
    expect(parseUsage('{"claudeCalls":"x","ms":-4}')).toEqual({
      claudeCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      embedCalls: 0,
      ms: 0,
    });
  });
});

describe("cleanDisplayTitle", () => {
  it("drops format tags and extensions", () => {
    expect(cleanDisplayTitle("Columbus  Day (EPUB)")).toBe("Columbus Day");
    expect(cleanDisplayTitle("columbus_day.epub")).toBe("columbus day");
  });

  it("drops author and series tails when it knows them", () => {
    const hints = { author: "Craig Alanson", series: "Expeditionary Force" };
    expect(cleanDisplayTitle("Paradise (Expeditionary Force Book 3)", hints)).toBe("Paradise");
    expect(cleanDisplayTitle("Paradise Expeditionary Force Book 3", hints)).toBe("Paradise");
    expect(cleanDisplayTitle("SpecOps - Expeditionary Force by Craig Alanson", hints)).toBe(
      "SpecOps"
    );
    expect(cleanDisplayTitle("Columbus Day by Craig Alanson", hints)).toBe("Columbus Day");
  });

  it("leaves ordinary titles alone", () => {
    expect(cleanDisplayTitle("Stand by Me")).toBe("Stand by Me");
    expect(cleanDisplayTitle("Dune", { series: "Dune", author: "Frank Herbert" })).toBe("Dune");
    expect(cleanDisplayTitle("Children of Dune", { series: "Dune" })).toBe("Children of Dune");
    expect(cleanDisplayTitle("(PDF)")).toBe("(PDF)");
  });
});

describe("formatTitlesPhrase", () => {
  it("joins one, two or more titles", () => {
    expect(formatTitlesPhrase([])).toBe("");
    expect(formatTitlesPhrase(["A"])).toBe("A");
    expect(formatTitlesPhrase(["A", "B"])).toBe("A and B");
    expect(formatTitlesPhrase(["A", "B", "C"])).toBe("A, B…");
  });
});

describe("formatLabelSummary", () => {
  it("counts labels and the books they are in", () => {
    expect(formatLabelSummary([{ changed: 4 }, { changed: 0 }, { changed: 1 }])).toBe(
      "5 chapter labels in 2 books"
    );
    expect(formatLabelSummary([{ changed: 1 }])).toBe("1 chapter label in 1 book");
    expect(formatLabelSummary([])).toBe("");
  });
});

describe("saved chats", () => {
  const usage = { claudeCalls: 1, inputTokens: 10, outputTokens: 5, embedCalls: 0, ms: 900 };
  const scope: ScopeInfo = { books: books("A"), reason: "focus" };

  it("keeps scope and usage through a save and load", () => {
    const saved = [
      toSavedMessage({ role: "user", content: "hi" }),
      toSavedMessage({ role: "assistant", content: "hello", sources: [], scope, usage }),
    ];
    expect(saved[1]).toEqual({ role: "assistant", content: "hello", scope, usage });
    expect(fromSavedMessages(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("loads chats saved before scope and usage existed", () => {
    const old = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", sources: [{ book: "A", excerpt: "x" }], why: {} },
    ];
    expect(fromSavedMessages(old)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", sources: [{ book: "A", excerpt: "x" }] },
    ]);
    expect(fromSavedMessages(null)).toEqual([]);
  });

  it("titles a chat from the first question", () => {
    expect(chatTitleFrom([])).toBe("Chat");
    expect(chatTitleFrom([{ role: "user", content: "Who is Skippy?" }])).toBe("Who is Skippy?");
    expect(chatTitleFrom([{ role: "user", content: "x".repeat(50) }])).toBe(`${"x".repeat(32)}…`);
  });
});

describe("formatAskingLine (the composer's scope chip)", () => {
  it("says the whole library, with its size when known", () => {
    expect(formatAskingLine({ books: [], reason: "all" })).toBe("Asking the whole library");
    expect(formatAskingLine({ books: [], reason: "all", more: 18 })).toBe("Asking the whole library · 18 books");
  });

  it("names one book, lists a few, counts the rest", () => {
    expect(formatAskingLine({ books: books("Columbus Day"), reason: "named" })).toBe("Asking Columbus Day");
    expect(formatAskingLine({ books: books("A", "B"), reason: "picked" })).toBe("Asking 2 books: A, B");
    expect(formatAskingLine({ books: books("A", "B", "C", "D"), reason: "picked", more: 2 })).toBe(
      "Asking 6 books: A, B, C +3"
    );
  });

  it("explains why", () => {
    expect(askingHint({ books: books("A"), reason: "named" })).toBe("named in your question");
    expect(askingHint({ books: books("A", "B"), reason: "picked" })).toBe("picked by you");
    expect(askingHint({ books: [], reason: "all" })).toBe("the closest books are chosen when you ask");
    expect(scopeReasonHint("picked")).toBe("the books you picked");
  });
});
