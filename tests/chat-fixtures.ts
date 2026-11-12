/**
 * In-memory library for the chat handler tests: three books in the series "Star Run"
 * plus one standalone book, with canned pages. Mirrors the `@/lib/book-store` functions the
 * chat pipeline uses (whole-word keyword search, counts, exact quotes, "semantic" passages).
 */

export const BOOKS = [
  { id: "book-1", title: "Iron Dawn", filename: "iron-dawn.epub", wordCount: 1000, addedAt: "2026-01-01T00:00:00.000Z", author: "Jo Vance", seriesId: "series-1", seriesOrder: 1 },
  { id: "book-2", title: "Silver Noon", filename: "silver-noon.epub", wordCount: 1000, addedAt: "2026-01-02T00:00:00.000Z", author: "Jo Vance", seriesId: "series-1", seriesOrder: 2 },
  { id: "book-3", title: "Golden Dusk", filename: "golden-dusk.epub", wordCount: 1000, addedAt: "2026-01-03T00:00:00.000Z", author: "Jo Vance", seriesId: "series-1", seriesOrder: 3 },
  { id: "book-4", title: "Lonely Harbor", filename: "lonely-harbor.epub", wordCount: 1000, addedAt: "2026-01-04T00:00:00.000Z", author: "Ann Reed" },
];

export const SERIES = [
  { id: "series-1", name: "Star Run", bookIds: ["book-1", "book-2", "book-3"], createdAt: "2026-01-05T00:00:00.000Z" },
];

export const PAGES: Record<string, Array<{ label: string; text: string }>> = {
  "book-1": [
    { label: "Chapter 1", text: "Joe met Skippy in a dusty warehouse. Skippy called Joe a monkey. The stars looked very different today from the ridge." },
    { label: "Chapter 2", text: "Skippy thinks humans are filthy monkeys, but he likes Joe. Joe quoted Star Trek at the Klingon joke." },
  ],
  "book-2": [
    { label: "Chapter 1", text: "Skippy sang opera badly. Imagine this: A cheeseburger, with raw onions, hot and spicy chili sauce, a pat of butter, and Marshmallow Fluff on top. He called it the Fluff Screamer." },
    { label: "Chapter 2", text: "Joe laughed. Skippy insisted humans were barely sentient." },
  ],
  "book-3": [{ label: "Chapter 1", text: "Skippy and Joe watched Star Wars. Joe missed home." }],
  "book-4": [
    { label: "Page 1", text: "The harbor was quiet. Mara repaired nets by lamplight." },
    { label: "Page 2", text: "Mara quoted Shakespeare to the gulls." },
  ],
};

export const settings: Record<string, unknown> = {};

export function resetSettings(overrides: Record<string, unknown> = {}): void {
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(
    settings,
    {
      language: "Auto",
      tone: "Casual",
      customInstructions: "",
      focusAreas: [],
      groundedMode: false,
      answerMode: "Evidence-heavy",
      useConversationMemory: true,
      countMode: "whole_word",
      companionMode: true,
    },
    overrides
  );
}
resetSettings();

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRe(keyword: string, flags = "gi"): RegExp {
  return new RegExp(`\\b${escapeRegex(keyword.trim())}\\b`, flags);
}

function bookTitle(bookId: string): string {
  return BOOKS.find((b) => b.id === bookId)?.title || "Unknown book";
}

function seriesBookIds(seriesId: string): string[] {
  return SERIES.find((s) => s.id === seriesId)?.bookIds || [];
}

function searchBookKeyword(bookId: string, keywords: string[], maxMatches = 500) {
  const out: Array<{ label: string; snippet: string }> = [];
  for (const page of PAGES[bookId] || []) {
    if (keywords.some((k) => k.trim() && wordRe(k, "i").test(page.text))) {
      out.push({ label: page.label, snippet: page.text });
    }
  }
  return out.slice(0, maxMatches);
}

function searchInBooks(bookIds: string[], keywords: string[], maxMatches: number) {
  return bookIds
    .flatMap((id) => searchBookKeyword(id, keywords).map((m) => ({ ...m, bookTitle: bookTitle(id) })))
    .slice(0, maxMatches);
}

function countBookKeywordMentions(bookId: string, keyword: string, _mode = "whole_word"): number {
  void _mode;
  return (PAGES[bookId] || []).reduce((sum, p) => sum + (p.text.match(wordRe(keyword)) || []).length, 0);
}

function exactQuoteIn(bookIds: string[], quote: string, maxMatches: number) {
  const needle = quote.toLowerCase();
  const out: Array<{ label: string; snippet: string; bookTitle: string }> = [];
  for (const id of bookIds) {
    for (const page of PAGES[id] || []) {
      if (page.text.toLowerCase().includes(needle)) {
        out.push({ label: page.label, snippet: page.text, bookTitle: bookTitle(id) });
      }
    }
  }
  return out.slice(0, maxMatches);
}

function passagesOf(bookIds: string[], max: number) {
  return bookIds
    .flatMap((id) =>
      (PAGES[id] || []).map((p) => ({ bookId: id, bookTitle: bookTitle(id), text: p.text, location: p.label }))
    )
    .slice(0, max);
}

const allIds = () => BOOKS.map((b) => b.id);

/** The subset of `@/lib/book-store` the chat pipeline touches. */
export const fakeStore = {
  isPublicMode: false,
  listBooks: () => BOOKS.map((b) => ({ ...b })),
  listSeries: () => SERIES.map((s) => ({ ...s, bookIds: [...s.bookIds] })),
  getBookById: (bookId: string) => BOOKS.find((b) => b.id === bookId) || null,
  getSeriesForBook: (bookId: string) => SERIES.find((s) => s.bookIds.includes(bookId)) || null,
  findBooksByTitleQuery: (query: string) =>
    BOOKS.filter((b) => b.title.toLowerCase().includes(query.toLowerCase())),
  loadSettings: () => settings,
  loadBookPages: (bookId: string) => PAGES[bookId] || null,
  loadBookSpecialistProfile: (_bookId: string) => {
    void _bookId;
    return null;
  },
  deleteAllBooks: async () => BOOKS.length,
  deleteBook: async (_bookId: string) => {
    void _bookId;
  },

  searchBookKeyword,
  searchAllBooksKeyword: (keywords: string[], maxMatches = 500) => searchInBooks(allIds(), keywords, maxMatches),
  searchSeriesKeyword: (seriesId: string, keywords: string[], maxMatches = 500) =>
    searchInBooks(seriesBookIds(seriesId), keywords, maxMatches),
  countBookKeywordMentions,
  countAllBooksKeywordMentions: (keyword: string, mode = "whole_word") =>
    BOOKS.map((b) => ({ bookId: b.id, bookTitle: b.title, count: countBookKeywordMentions(b.id, keyword, mode) }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count),
  searchExactQuoteInBook: (bookId: string, quote: string, maxMatches = 100) => exactQuoteIn([bookId], quote, maxMatches),
  searchExactQuoteAllBooks: (quote: string, maxMatches = 200) => exactQuoteIn(allIds(), quote, maxMatches),
  searchExactQuoteInSeries: (seriesId: string, quote: string, maxMatches = 200) =>
    exactQuoteIn(seriesBookIds(seriesId), quote, maxMatches),

  queryBook: async (bookId: string, _query: string, maxChunks = 20) => {
    void _query;
    return passagesOf([bookId], maxChunks).map((p) => ({ text: p.text, location: p.location }));
  },
  queryAllBooks: async (_query: string, maxChunks = 20) => {
    void _query;
    return passagesOf(allIds(), maxChunks);
  },
  querySeriesBooks: async (seriesId: string, _query: string, maxChunks = 20) => {
    void _query;
    return passagesOf(seriesBookIds(seriesId), maxChunks);
  },
};

export const ENTITY_NODES = [
  { name: "Skippy", type: "character", mentions: 40, books: ["book-1", "book-2", "book-3"] },
  { name: "Joe", type: "character", mentions: 30, books: ["book-1", "book-2", "book-3"] },
  { name: "Mara", type: "character", mentions: 9, books: ["book-4"] },
];

/** What a specialist "returns" for any book: one provable finding. */
export const SPECIALIST_JSON = JSON.stringify({
  confidence: "high",
  directAnswer: "Skippy thinks humans are filthy monkeys.",
  numericEstimate: null,
  findings: [{ finding: "Skippy calls humans monkeys", location: "Chapter 2", evidence: "filthy monkeys" }],
  caveats: [],
});

export const STREAMED_ANSWER = "Streamed answer: Skippy thinks humans are monkeys, and says so in several chapters.";
