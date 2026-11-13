import { describe, expect, it } from "vitest";
import { isScopeShortcut } from "../src/components/chat/Composer";
import {
  followUpAction,
  followUpScope,
  oneOffRequest,
  questionIndexFor,
} from "../src/components/chat/followUp";
import {
  formatUsageLine,
  formatUsageParts,
  savedScopeWords,
  usageTooltip,
  type ScopeInfo,
  type ScopeReason,
} from "../src/components/chat/format";
import { fromSavedMessages, toSavedMessage } from "../src/components/chat/messages";

const books = [
  { id: "e1", title: "Columbus Day" },
  { id: "e2", title: "SpecOps" },
  { id: "e3", title: "Paradise" },
  { id: "e4", title: "Black Ops" },
  { id: "d1", title: "Dune" },
  { id: "d2", title: "Dune Messiah" },
  { id: "s1", title: "Solo" },
];
const series = [
  { id: "exfor", name: "Expeditionary Force", bookIds: ["e1", "e2", "e3", "e4"] },
  { id: "dune", name: "Dune", bookIds: ["d1", "d2"] },
];
const library = { books, series };

const scope = (reason: ScopeReason, ...ids: string[]): ScopeInfo => ({
  reason,
  books: ids.map((id) => ({ id, title: books.find((b) => b.id === id)?.title ?? id })),
});

describe("followUpAction: closest books in the library", () => {
  it("offers the library's other books, in shelf order", () => {
    expect(followUpAction(scope("semantic", "e2", "d1", "s1"), library, { bookId: "all" })).toEqual({
      label: "Check the other 4 books",
      kind: "others",
      bookIds: ["e1", "e3", "e4", "d2"],
    });
  });

  it("asks a single remaining book as a focus book", () => {
    const small = { books: books.slice(0, 4), series };
    expect(followUpAction(scope("semantic", "e1", "e2", "e3"), small)).toEqual({
      label: "Check the other 1 book",
      kind: "others",
      focusId: "e4",
      focusTitle: "Black Ops",
    });
  });

  it("shows nothing when every book was read, or when the scope lists none", () => {
    const three = { books: books.slice(0, 3), series };
    expect(followUpAction(scope("semantic", "e1", "e2", "e3"), three)).toBeNull();
    expect(followUpAction({ books: [], reason: "semantic", more: 3 }, library)).toBeNull();
  });
});

describe("followUpAction: a series read in part", () => {
  it("offers the rest of the focused series", () => {
    expect(
      followUpAction(scope("series", "e1", "e2"), library, { bookId: "series:exfor" })
    ).toEqual({ label: "Check the rest of the series", kind: "series", bookIds: ["e3", "e4"] });
  });

  it("finds the series by the books read when it was named in the question", () => {
    expect(followUpAction(scope("series", "d1"), library, { bookId: "all" })).toEqual({
      label: "Check the rest of the series",
      kind: "series",
      focusId: "d2",
      focusTitle: "Dune Messiah",
    });
  });

  it("shows nothing when the whole series was read or the series is gone", () => {
    expect(followUpAction(scope("series", "d1", "d2"), library, { bookId: "series:dune" })).toBeNull();
    expect(followUpAction(scope("series", "s1"), library, { bookId: "series:gone" })).toBeNull();
  });
});

describe("followUpAction: a pick read in part", () => {
  it("offers the other picked books", () => {
    expect(
      followUpAction(scope("picked", "e1", "e2"), library, { bookIds: ["e1", "e2", "d1", "d2", "gone"] })
    ).toEqual({ label: "Check the other 2 picked books", kind: "picked", bookIds: ["d1", "d2"] });
  });

  it("calls them just books in a chain of follow-ups", () => {
    expect(
      followUpAction(scope("picked", "e1", "e3"), library, {
        bookIds: ["e1", "e3", "e4", "d2"],
        followUp: true,
      })?.label
    ).toBe("Check the other 2 books");
  });

  it("shows nothing when the pick was read in full or is unknown", () => {
    expect(followUpAction(scope("picked", "e1", "d1"), library, { bookIds: ["e1", "d1"] })).toBeNull();
    expect(followUpAction(scope("picked", "e1", "d1"), library)).toBeNull();
  });
});

describe("followUpAction: a named or focus book", () => {
  it("offers the whole library", () => {
    const whole = { label: "Ask the whole library instead", kind: "library", library: true };
    expect(followUpAction(scope("named", "e1"), library, { bookId: "all" })).toEqual(whole);
    expect(followUpAction(scope("focus", "d1"), library, { bookId: "d1" })).toEqual(whole);
  });

  it("shows nothing at the end of a chain, in a one-book library, or for the whole library", () => {
    expect(followUpAction(scope("focus", "e4"), library, { bookId: "e4", followUp: true })).toBeNull();
    expect(followUpAction(scope("focus", "e1"), { books: books.slice(0, 1), series: [] })).toBeNull();
    expect(followUpAction({ books: [], reason: "all", more: 7 }, library)).toBeNull();
    expect(followUpAction(undefined, library)).toBeNull();
  });
});

describe("one-off scope of a follow-up", () => {
  it("turns an action into the scope of one request", () => {
    expect(followUpScope({ label: "x", kind: "others", bookIds: ["a", "b"] })).toEqual({
      bookIds: ["a", "b"],
    });
    expect(followUpScope({ label: "x", kind: "others", focusId: "a", focusTitle: "A" })).toEqual({
      bookId: "a",
      bookTitle: "A",
    });
    expect(followUpScope({ label: "x", kind: "library", library: true })).toEqual({
      bookId: "all",
      bookTitle: "All Books",
    });
  });

  it("sends several books as bookIds against the library, one as the focus", () => {
    expect(oneOffRequest({ bookIds: ["a", "b"] })).toEqual({
      bookId: "all",
      bookTitle: "All Books",
      bookIds: ["a", "b"],
    });
    expect(oneOffRequest({ bookId: "a", bookTitle: "A" })).toEqual({ bookId: "a", bookTitle: "A" });
  });

  it("finds the question an answer belongs to", () => {
    const messages = [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }];
    expect(questionIndexFor(messages, 3)).toBe(2);
    expect(questionIndexFor(messages, 1)).toBe(0);
    expect(questionIndexFor([{ role: "assistant" }], 0)).toBe(-1);
  });
});

describe("saved follow-up fields", () => {
  it("keeps the label, what was asked and the used action through a save", () => {
    const question = toSavedMessage({
      role: "user",
      content: "Does Joe survive?",
      label: "Check the other 15 books",
      asked: { bookId: "all", bookIds: ["a", "b"], followUp: true },
    });
    const answer = toSavedMessage({ role: "assistant", content: "Yes.", checked: true });
    expect(fromSavedMessages(JSON.parse(JSON.stringify([question, answer])))).toEqual([
      question,
      answer,
    ]);
    expect(answer.checked).toBe(true);
  });

  it("loads messages without them, and drops junk", () => {
    const [m] = fromSavedMessages([
      { role: "user", content: "Hi", asked: { bookIds: [7, ""] }, label: 3, checked: "yes" },
    ]);
    expect(m).toEqual({ role: "user", content: "Hi" });
  });
});

describe("savedScopeWords", () => {
  it("says the scope in words", () => {
    expect(savedScopeWords({ bookId: "all", bookTitle: "All Books" })).toBe("Whole library");
    expect(savedScopeWords({ bookId: "d1", bookTitle: "Dune.epub" })).toBe("Dune");
    expect(savedScopeWords({ bookId: "series:exfor", bookTitle: "Expeditionary Force" })).toBe(
      "Expeditionary Force series"
    );
    expect(savedScopeWords({ bookId: "series:x", bookTitle: "The Expanse Series" })).toBe(
      "The Expanse Series"
    );
    expect(savedScopeWords({ bookId: "all", bookTitle: "whatever", pickedIds: ["a", "b", "c"] })).toBe(
      "3 picked books"
    );
    // The chat list has no pickedIds, only the title a pick was saved with.
    expect(savedScopeWords({ bookId: "all", bookTitle: "4 picked books" })).toBe("4 picked books");
  });

  it("falls back to bookTitle for chats saved without the scope fields", () => {
    expect(savedScopeWords({ bookTitle: "Some Old Title" })).toBe("Some Old Title");
    expect(savedScopeWords({})).toBe("Whole library");
  });
});

describe("usage line pieces", () => {
  const usage = { claudeCalls: 2, inputTokens: 10500, outputTokens: 1200, embedCalls: 1, ms: 12000 };

  it("splits into the pieces the line is joined from", () => {
    expect(formatUsageParts({ ...usage, costUsd: 0.04 })).toEqual([
      "2 calls",
      "10.5k tokens in",
      "1.2k out",
      "≈ $0.04",
      "12 s",
    ]);
    expect(formatUsageLine(usage)).toBe(formatUsageParts(usage).join(" · "));
    expect(formatUsageParts({ ...usage, claudeCalls: 0, embedCalls: 0 })).toEqual([
      "No AI calls",
      "exact text search",
      "12 s",
    ]);
  });

  it("explains the cost only when there is one", () => {
    expect(usageTooltip({ ...usage, costUsd: 0.04 })).toBe("List price estimate, not your AWS bill");
    expect(usageTooltip(usage)).toBeUndefined();
    expect(usageTooltip({ ...usage, costUsd: null })).toBeUndefined();
  });
});

describe("isScopeShortcut", () => {
  const key = (over: object) => ({ altKey: true, ctrlKey: false, metaKey: false, key: "s", ...over });

  it("is Alt+S by physical key", () => {
    expect(isScopeShortcut(key({ code: "KeyS" }))).toBe(true);
    expect(isScopeShortcut(key({ code: "KeyS", key: "ß" }))).toBe(true);
    expect(isScopeShortcut(key({}))).toBe(true);
  });

  it("is not plain S, Ctrl+Alt+S (AltGr) or another key", () => {
    expect(isScopeShortcut(key({ altKey: false, code: "KeyS" }))).toBe(false);
    expect(isScopeShortcut(key({ ctrlKey: true, code: "KeyS" }))).toBe(false);
    expect(isScopeShortcut(key({ code: "KeyD", key: "d" }))).toBe(false);
  });
});
