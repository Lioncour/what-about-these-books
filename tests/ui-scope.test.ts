import { describe, expect, it } from "vitest";
import {
  askingHint,
  formatAskingLine,
  pickedLimitNote,
  welcomeSuggestions,
} from "../src/components/chat/format";
import {
  exactSeriesFor,
  localScopePreview,
  restoreSavedScope,
  scopeFromTicked,
  scopeToRequest,
  scopeToSaved,
  seriesIdOfFocus,
  tickedIdsFor,
} from "../src/components/chat/scope";

const books = [
  { id: "e1", title: "Columbus Day" },
  { id: "e2", title: "SpecOps" },
  { id: "e3", title: "Paradise" },
  { id: "d1", title: "Dune" },
  { id: "d2", title: "Dune Messiah" },
  { id: "s1", title: "Solo" },
];
const series = [
  { id: "exfor", name: "Expeditionary Force", bookIds: ["e1", "e2", "e3"] },
  { id: "dune", name: "Dune", bookIds: ["d1", "d2"] },
  { id: "single", name: "One Book Series", bookIds: ["s1"] },
];
const library = { books, series };

describe("exactSeriesFor", () => {
  it("matches a ticked set that is exactly one series, in any order", () => {
    expect(exactSeriesFor(["e3", "e1", "e2"], series)?.id).toBe("exfor");
  });

  it("does not match part of a series, a series plus another book, or two series", () => {
    expect(exactSeriesFor(["e1", "e2"], series)).toBeNull();
    expect(exactSeriesFor(["e1", "e2", "e3", "s1"], series)).toBeNull();
    expect(exactSeriesFor(["e1", "e2", "e3", "d1", "d2"], series)).toBeNull();
  });

  it("leaves a one-book series to be a focus book", () => {
    expect(exactSeriesFor(["s1"], series)).toBeNull();
  });
});

describe("scopeFromTicked", () => {
  it("is the whole library with nothing ticked", () => {
    expect(scopeFromTicked([], books, series)).toEqual({ kind: "all" });
  });

  it("is a focus book with one ticked", () => {
    expect(scopeFromTicked(["d1"], books, series)).toEqual({
      kind: "book",
      focus: { id: "d1", title: "Dune" },
    });
  });

  it("is a series scope when every book of one series is ticked", () => {
    expect(scopeFromTicked(["e1", "e2", "e3"], books, series)).toEqual({
      kind: "series",
      focus: { id: "series:exfor", title: "Expeditionary Force" },
    });
  });

  it("is a picked set otherwise, in shelf order, without unknown ids", () => {
    expect(scopeFromTicked(["d1", "gone", "e2"], books, series)).toEqual({
      kind: "picked",
      ids: ["e2", "d1"],
    });
  });
});

describe("scopeToRequest", () => {
  it("sends a series as bookId series:<id> with the series name", () => {
    expect(scopeToRequest({ id: "series:exfor", title: "Expeditionary Force" }, [])).toEqual({
      bookId: "series:exfor",
      bookTitle: "Expeditionary Force",
    });
  });

  it("sends picked books as bookIds against the whole library", () => {
    expect(scopeToRequest(null, ["e1", "d1"])).toEqual({
      bookId: "all",
      bookTitle: "All Books",
      bookIds: ["e1", "d1"],
    });
  });

  it("sends the whole library with nothing chosen, and no bookIds beside a focus", () => {
    expect(scopeToRequest(null, [])).toEqual({ bookId: "all", bookTitle: "All Books" });
    expect(scopeToRequest({ id: "d1", title: "Dune" }, ["e1", "e2"])).toEqual({
      bookId: "d1",
      bookTitle: "Dune",
    });
  });
});

describe("tickedIdsFor / seriesIdOfFocus", () => {
  it("ticks the series' books for a series focus", () => {
    expect(seriesIdOfFocus("series:exfor")).toBe("exfor");
    expect(seriesIdOfFocus("d1")).toBeNull();
    expect(tickedIdsFor({ id: "series:exfor", title: "x" }, [], series)).toEqual(["e1", "e2", "e3"]);
    expect(tickedIdsFor({ id: "d1", title: "Dune" }, [], series)).toEqual(["d1"]);
    expect(tickedIdsFor(null, ["e1", "d1"], series)).toEqual(["e1", "d1"]);
  });
});

describe("saved scope", () => {
  it("round-trips a picked set", () => {
    const saved = scopeToSaved(null, ["e1", "d1"]);
    expect(saved).toEqual({ bookId: "all", bookTitle: "2 picked books", pickedIds: ["e1", "d1"] });
    expect(restoreSavedScope(saved, library)).toEqual({ focus: null, pickedIds: ["e1", "d1"] });
  });

  it("round-trips a series and a focus book", () => {
    const seriesSaved = scopeToSaved({ id: "series:dune", title: "Dune" }, []);
    expect(restoreSavedScope(seriesSaved, library)).toEqual({
      focus: { id: "series:dune", title: "Dune" },
      pickedIds: [],
    });
    const bookSaved = scopeToSaved({ id: "s1", title: "Solo" }, []);
    expect(restoreSavedScope(bookSaved, library)).toEqual({
      focus: { id: "s1", title: "Solo" },
      pickedIds: [],
    });
  });

  it("loads chats saved before picks existed", () => {
    expect(restoreSavedScope({ bookId: "all", bookTitle: "All Books" }, library)).toEqual({
      focus: null,
      pickedIds: [],
    });
    expect(restoreSavedScope({ bookId: "d1", bookTitle: "Dune" }, library).focus?.id).toBe("d1");
    expect(restoreSavedScope(null, library)).toEqual({ focus: null, pickedIds: [] });
  });

  it("drops picked books that are gone, down to a focus book or the library", () => {
    expect(
      restoreSavedScope({ bookId: "all", pickedIds: ["e1", "gone", "d1"] }, library).pickedIds
    ).toEqual(["e1", "d1"]);
    expect(restoreSavedScope({ bookId: "all", pickedIds: ["gone", "d1"] }, library)).toEqual({
      focus: { id: "d1", title: "Dune" },
      pickedIds: [],
    });
    expect(restoreSavedScope({ bookId: "all", pickedIds: ["gone", 7] }, library)).toEqual({
      focus: null,
      pickedIds: [],
    });
  });

  it("drops a focus book or series that is gone", () => {
    expect(restoreSavedScope({ bookId: "gone", bookTitle: "Gone" }, library).focus).toBeNull();
    expect(restoreSavedScope({ bookId: "series:gone", bookTitle: "Gone" }, library).focus).toBeNull();
  });

  it("keeps everything as saved while the library is not loaded yet", () => {
    expect(restoreSavedScope({ bookId: "all", pickedIds: ["x", "y"] }, null).pickedIds).toEqual([
      "x",
      "y",
    ]);
    expect(restoreSavedScope({ bookId: "series:exfor", bookTitle: "ExFor" }, null).focus).toEqual({
      id: "series:exfor",
      title: "ExFor",
    });
  });
});

describe("the chip for a series and for many picked books", () => {
  it("reads 'Asking <Series name> · this series'", () => {
    const preview = localScopePreview(
      { id: "series:exfor", title: "Expeditionary Force" },
      [],
      books,
      series
    );
    expect(preview?.reason).toBe("series");
    expect(preview?.books.map((b) => b.id)).toEqual(["e1", "e2", "e3"]);
    expect(`${formatAskingLine(preview!)} · ${askingHint(preview!)}`).toBe(
      "Asking Expeditionary Force · this series"
    );
  });

  it("previews a focus book and a picked set, and leaves the library to the server", () => {
    expect(localScopePreview({ id: "d1", title: "Dune" }, [], books, series)).toEqual({
      books: [{ id: "d1", title: "Dune" }],
      reason: "focus",
    });
    expect(localScopePreview(null, ["e1", "d1"], books, series)?.reason).toBe("picked");
    expect(localScopePreview(null, [], books, series)).toBeNull();
  });

  it("says the librarians read the first six once more are picked", () => {
    const many = (n: number) => ({
      books: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `Book ${i}` })),
      reason: "picked" as const,
    });
    expect(askingHint(many(6))).toBe("picked by you");
    expect(askingHint(many(7))).toBe("picked by you · librarians read the first 6");
    expect(pickedLimitNote(6)).toBe("");
    expect(pickedLimitNote(9)).toBe(
      "Counts and searches use all 9; the librarians read the first 6."
    );
  });
});

describe("welcomeSuggestions", () => {
  it("shows off naming a book when the library has books", () => {
    expect(welcomeSuggestions(null, 3, "Columbus Day")).toContain(
      "In Columbus Day, what happens first?"
    );
    expect(welcomeSuggestions(null, 3).some((s) => s.startsWith("In "))).toBe(false);
  });

  it("fits a focus book, a series and an empty library", () => {
    expect(welcomeSuggestions("book", 3, "Columbus Day")[0]).toBe("What's this one about?");
    expect(welcomeSuggestions("series", 3, "Columbus Day")[0]).toBe("What's this series about?");
    expect(welcomeSuggestions(null, 0)).toEqual(["What can you do?", "How do I add a book?"]);
  });
});
