import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTITY_NODES, SPECIALIST_JSON, STREAMED_ANSWER, resetSettings } from "./chat-fixtures";

type ClaudeOpts = { signal?: AbortSignal; system?: string } | undefined;

/** Per-test overrides for the mocked Bedrock calls. */
const claude = vi.hoisted(() => ({
  text: null as null | ((prompt: string, opts: ClaudeOpts) => Promise<string>),
}));

vi.mock("@/lib/book-store", async () => {
  const { fakeStore } = await import("./chat-fixtures");
  return Object.fromEntries(
    Object.entries(fakeStore).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(value as (...args: never[]) => unknown) : value,
    ])
  );
});

vi.mock("@/lib/bedrock-client", () => ({
  DEFAULT_BEDROCK_MODEL_ID: "test-model",
  isAbortError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const err = error as { name?: string; message?: string };
    return err.name === "AbortError" || /\baborted\b/i.test(err.message || "");
  },
}));

vi.mock("@/lib/bedrock-claude", async () => {
  const fixtures = await import("./chat-fixtures");
  // Like the real wrappers: every completed call is added to the request's usage.
  const { recordRequestClaudeCall } = await import("@/lib/chat/request-context");
  const defaultText = async (prompt: string, opts: ClaudeOpts) => {
    if (opts?.system?.includes("specialist AI")) return fixtures.SPECIALIST_JSON;
    if (prompt.includes("Facts you MUST preserve")) {
      return `NATURAL: ${prompt.split("Facts you MUST preserve exactly:\n")[1].split("\n\nInstructions:")[0]}`;
    }
    if (prompt.includes("User asks: \"Who is")) return "Skippy is an ancient AI.\n\n## Evidence notes\n- [1]";
    return "Direct reply.";
  };
  return {
    callClaudeText: vi.fn(
      async (prompt: string, _maxTokens?: number, _temperature?: number, _modelId?: string, opts?: ClaudeOpts) => {
        opts?.signal?.throwIfAborted();
        const text = await (claude.text || defaultText)(prompt, opts);
        recordRequestClaudeCall(100, 20);
        return text;
      }
    ),
    callClaudeStream: vi.fn(
      async (
        _prompt: string,
        onToken: (delta: string) => void,
        _maxTokens?: number,
        _temperature?: number,
        _modelId?: string,
        opts?: ClaudeOpts
      ) => {
        opts?.signal?.throwIfAborted();
        const half = Math.floor(fixtures.STREAMED_ANSWER.length / 2);
        onToken(fixtures.STREAMED_ANSWER.slice(0, half));
        onToken(fixtures.STREAMED_ANSWER.slice(half));
        recordRequestClaudeCall(300, 50);
        return fixtures.STREAMED_ANSWER;
      }
    ),
    extractJsonObject: (raw: string) => {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      return start === -1 || end <= start ? null : raw.slice(start, end + 1);
    },
  };
});

vi.mock("@/lib/knowledge-store", async () => {
  const fixtures = await import("./chat-fixtures");
  return {
    getEntityGraph: vi.fn(() => ({ nodes: fixtures.ENTITY_NODES, edges: [] })),
    queryEntityGraph: vi.fn(() => ({ nodes: fixtures.ENTITY_NODES.slice(0, 2), edges: [] })),
    detectChronologyConflicts: vi.fn(() => [] as string[]),
  };
});

vi.mock("@/lib/quality-store", () => ({
  fingerprintQuestion: (bookId: string, question: string) => `${bookId}::${question}`,
  getCachedSpecialistAnswer: vi.fn(() => null),
  setCachedSpecialistAnswer: vi.fn(),
  updateSpecialistScorecard: vi.fn(() => ({ precisionEstimate: 0.5, recallEstimate: 0.5, total: 1 })),
}));

vi.mock("@/lib/chat-debug", () => ({ logChatEvent: vi.fn() }));

vi.mock("@/lib/reindex-manager", () => ({
  getReindexState: vi.fn(() => ({ running: false, processed: 0, total: 0, finishedAt: "" })),
  startFullReindex: vi.fn(async () => ({ running: true, processed: 0, total: 4 })),
}));

import * as store from "@/lib/book-store";
import { callClaudeStream, callClaudeText } from "@/lib/bedrock-claude";
import { logChatEvent } from "@/lib/chat-debug";
import { getEntityGraph } from "@/lib/knowledge-store";
import { POST } from "@/lib/chat/handler";
import { decodeStreamLine } from "@/lib/chat/stream-protocol";
import type { ChatMessage, ChatSource } from "@/lib/chat/types";

type Line = { type: string; data: string };

const ALL = { bookId: "all", bookTitle: "All books" };
const SERIES_SCOPE = { bookId: "series:series-1", bookTitle: "Star Run" };
const BOOK = { bookId: "book-2", bookTitle: "Silver Noon" };

/** New stream lines (added by the Scope refactor) are checked on their own, not in sequences. */
const META_TYPES = new Set(["SCOPE", "USAGE"]);

function request(scope: { bookId: string; bookTitle: string }, messages: ChatMessage[], signal?: AbortSignal) {
  return new Request("http://127.0.0.1:3000/api/chat", {
    method: "POST",
    body: JSON.stringify({ ...scope, messages }),
    signal,
  }) as never;
}

class Answer {
  constructor(readonly all: Line[]) {}
  /** Lines without the SCOPE/USAGE meta lines. */
  get lines(): Line[] {
    return this.all.filter((l) => !META_TYPES.has(l.type));
  }
  /** Line types in order, consecutive TOKENs collapsed into one. */
  get types(): string[] {
    const out: string[] = [];
    for (const l of this.lines) {
      if (l.type === "TOKEN" && out[out.length - 1] === "TOKEN") continue;
      out.push(l.type);
    }
    return out;
  }
  of(type: string): string[] {
    return this.all.filter((l) => l.type === type).map((l) => l.data);
  }
  get text(): string {
    return this.of("TEXT").join("\n");
  }
  get tokens(): string {
    return this.of("TOKEN").join("");
  }
  get statuses(): string[] {
    return this.of("STATUS");
  }
  get sources(): ChatSource[] {
    const raw = this.of("SOURCES");
    return raw.length ? (JSON.parse(raw[raw.length - 1]) as ChatSource[]) : [];
  }
  json<T>(type: string): T[] {
    return this.of(type).map((d) => JSON.parse(d) as T);
  }
}

function parseLines(body: string): Line[] {
  return body
    .split("\n")
    .filter(Boolean)
    .map((l) => decodeStreamLine(l))
    .filter((l): l is Line => l !== null);
}

async function ask(
  scope: { bookId: string; bookTitle: string },
  question: string | ChatMessage[]
): Promise<Answer> {
  const messages: ChatMessage[] = typeof question === "string" ? [{ role: "user", content: question }] : question;
  const res = await POST(request(scope, messages));
  expect(res.status).toBe(200);
  return new Answer(parseLines(await res.text()));
}

const textCalls = () => vi.mocked(callClaudeText).mock.calls;
const streamCalls = () => vi.mocked(callClaudeStream).mock.calls;
const logged = (event: string) => vi.mocked(logChatEvent).mock.calls.filter((c) => c[0] === event);

beforeEach(() => {
  vi.clearAllMocks();
  claude.text = null;
  resetSettings();
  vi.mocked(getEntityGraph).mockImplementation(() => ({ nodes: ENTITY_NODES, edges: [] }) as never);
});

describe("request validation", () => {
  it("rejects a request without a book id or messages", async () => {
    const res = await POST(request({ bookId: "", bookTitle: "" }, [{ role: "user", content: "hi" }]));
    expect(res.status).toBe(400);
    const res2 = await POST(request(ALL, []));
    expect(res2.status).toBe(400);
    const res3 = await POST(request(ALL, [{ role: "assistant", content: "hello" }]));
    expect(res3.status).toBe(400);
  });
});

describe("library commands", () => {
  it("lists the books without touching Bedrock", async () => {
    const a = await ask(ALL, "list my books");
    expect(a.types).toEqual(["STATUS", "TEXT"]);
    expect(a.statuses[0]).toBe("On it — updating your library…");
    expect(a.text).toContain("You have **4** books");
    expect(a.text).toContain("1. **Iron Dawn** — Jo Vance");
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it("removes everything and tells the UI the library changed", async () => {
    const a = await ask(BOOK, "@remove all books@");
    expect(a.types).toEqual(["STATUS", "TEXT", "LIBRARY_CHANGED"]);
    expect(a.text).toBe("Removed **4** books from your library.");
    expect(a.json("LIBRARY_CHANGED")).toEqual([{ clearFocus: true }]);
    expect(store.deleteAllBooks).toHaveBeenCalledTimes(1);
    expect(textCalls()).toHaveLength(0);
  });
});

describe("have you read", () => {
  it.each([
    [ALL, "Flipping through your whole shelf…", "**4 books**"],
    [SERIES_SCOPE, 'Searching series "Star Run" (semantic search)...', "I currently see **3** books in this series"],
    [BOOK, 'Searching "Silver Noon" (semantic search)...', "I’ve indexed **Silver Noon**"],
  ])("answers from the catalog for %o", async (scope, searchStatus, fragment) => {
    const a = await ask(scope, "Have you read these books?");
    expect(a.types).toEqual(["STATUS", "STATUS", "TEXT"]);
    expect(a.statuses).toEqual(["Checking what I’ve read…", searchStatus]);
    expect(a.text.startsWith("NATURAL: Yes — ")).toBe(true);
    expect(a.text).toContain(fragment);
    expect(textCalls()).toHaveLength(1);
    expect(streamCalls()).toHaveLength(0);
    expect(a.sources).toEqual([]);
  });

  it("skips the Claude rephrase in raw mode", async () => {
    resetSettings({ companionMode: false });
    const a = await ask(ALL, "Have you read these books?");
    expect(a.statuses).toEqual(["Checking what I’ve read…", "Searching across your entire library (semantic search)..."]);
    expect(a.text.startsWith("Yes — I’ve indexed your uploaded library")).toBe(true);
    expect(textCalls()).toHaveLength(0);
  });
});

describe("library count", () => {
  it("counts the catalog when the whole library is in focus", async () => {
    const a = await ask(ALL, "How many books do I have?");
    expect(a.types).toEqual(["STATUS", "STATUS", "TEXT"]);
    expect(a.statuses[0]).toBe("Counting your books…");
    expect(a.text).toBe("NATURAL: You currently have **4 books** in your library.");
    expect(textCalls()).toHaveLength(1);
  });

  it.each([SERIES_SCOPE, BOOK])("is left to the specialists inside %o", async (scope) => {
    const a = await ask(scope, "How many books do I have?");
    expect(a.types).toContain("SPECIALISTS");
    expect(a.types).not.toContain("TEXT");
    expect(streamCalls()).toHaveLength(1);
  });
});

describe("who is", () => {
  it.each([
    [ALL, "your library (mostly in Iron Dawn)", 5, "Iron Dawn"],
    [SERIES_SCOPE, "series Star Run (mostly in Iron Dawn)", 5, "Iron Dawn"],
    [BOOK, "book Silver Noon", 2, "Silver Noon"],
  ])("looks the character up in %o", async (scope, scopeLabel, sourceCount, firstBook) => {
    const a = await ask(scope, "Who is Skippy?");
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe("Looking up Skippy…");
    expect(a.statuses[2]).toBe("Pulling character notes…");
    expect(a.text).toContain("Skippy is an ancient AI.");
    expect(a.sources).toHaveLength(sourceCount);
    expect(a.sources[0]).toEqual({
      book: firstBook,
      excerpt: expect.stringContaining("Skippy"),
      position: "Chapter 1",
    });
    expect(textCalls()).toHaveLength(1);
    expect(textCalls()[0][0]).toContain(`Scope: ${scopeLabel}`);
    expect(streamCalls()).toHaveLength(0);
  });

  it("reports a Bedrock failure as one encoded ERROR line", async () => {
    claude.text = async () => {
      throw new Error("boom\nsecond line");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await ask(ALL, "Who is Skippy?");
    errorSpy.mockRestore();
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "ERROR"]);
    expect(a.of("ERROR")).toEqual(["Failed to generate response. boom\nsecond line"]);
  });
});

describe("main characters", () => {
  it.each([
    [ALL, "about **3 main characters** across the current scope", 3],
    [SERIES_SCOPE, "in **Star Run**, I detect about **2 main characters**", 2],
    [BOOK, "in **Silver Noon**, I detect about **2 main characters**", 2],
  ])("derives them from the entity graph for %o", async (scope, fragment, count) => {
    const a = await ask(scope, "Who are the main characters?");
    expect(a.types).toEqual(["STATUS", "STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe("Finding who matters most…");
    expect(a.text).toContain(fragment);
    expect(a.text).toContain("## Likely main characters");
    expect(a.text.match(/^- \*\*/gm)).toHaveLength(count);
    expect(a.text).toContain("- **Skippy** (mentions: 40)");
    expect(a.sources.length).toBeGreaterThan(0);
    // A structured answer is never rephrased.
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it.each([
    [ALL, "I couldn't confidently identify main characters yet. Try re-indexing this book or asking with a specific book selected."],
    [SERIES_SCOPE, "I couldn't confidently identify main characters in this series yet."],
    [BOOK, "I couldn't confidently identify the main characters yet for this book."],
  ])("says so in the friend voice when the graph has nobody in %o", async (scope, sentence) => {
    vi.mocked(getEntityGraph).mockImplementation(() => ({ nodes: [], edges: [] }) as never);
    const a = await ask(scope, "Who are the main characters?");
    expect(a.types).toEqual(["STATUS", "STATUS", "TEXT"]);
    expect(a.text).toBe(`NATURAL: ${sentence}`);
    expect(textCalls()).toHaveLength(1);
  });
});

describe("small talk bypass", () => {
  it.each([
    [ALL, "Answering without digging into the books…", "friendly, practical digital librarian assistant"],
    [
      SERIES_SCOPE,
      "General prompt detected — replying directly without specialist fan-out...",
      "selected series context (Star Run)",
    ],
    [BOOK, "General prompt detected — replying directly as Claude...", "one selected book (Silver Noon)"],
  ])("answers directly in %o", async (scope, status, promptFragment) => {
    const a = await ask(scope, "hello there");
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "TEXT"]);
    expect(a.statuses[0]).toBe("Answering directly…");
    expect(a.statuses[2]).toBe(status);
    expect(a.text).toBe("Direct reply.");
    expect(textCalls()).toHaveLength(1);
    expect(textCalls()[0][0]).toContain(promptFragment);
    expect(textCalls()[0][0]).toContain("User message: hello there");
    expect(streamCalls()).toHaveLength(0);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
    expect(store.queryBook).not.toHaveBeenCalled();
  });
});

describe("exact mention count", () => {
  const noBedrock = () => {
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
  };

  it("counts across the library", async () => {
    const a = await ask(ALL, "How many times is Skippy mentioned?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe('Counting exact mentions of "Skippy" across your library...');
    expect(a.text).toContain("**Skippy** appears **6** times across your library.");
    expect(a.text).toContain("- **Iron Dawn**: 3");
    expect(a.text).toContain("- **Silver Noon**: 2");
    expect(a.text).toContain("- **Golden Dusk**: 1");
    expect(a.text).not.toContain("Lonely Harbor");
    expect(a.sources).toHaveLength(5);
    expect(a.sources[0]).toEqual({ book: "Iron Dawn", excerpt: expect.any(String), position: "Chapter 1" });
    noBedrock();
  });

  it("counts the first N books of the series", async () => {
    const a = await ask(ALL, "How many times is Skippy mentioned in the first 2 books?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe('Counting exact mentions of "Skippy" in series "Star Run"...');
    expect(a.text).toContain("**Skippy** appears **5** times in the first **2** books of **Star Run**.");
    expect(a.text).toContain("## Books counted (2)");
    expect(a.text).toContain("- **Book 1 · Iron Dawn**: 3");
    expect(a.text).toContain("- **Book 2 · Silver Noon**: 2");
    expect(a.text).not.toContain("Golden Dusk");
    expect(a.sources).toHaveLength(4);
    expect(a.sources[0]).toEqual({
      book: "Iron Dawn",
      bookId: "book-1",
      excerpt: expect.any(String),
      position: "Chapter 1",
    });
    noBedrock();
  });

  it("counts only the book named in the question", async () => {
    const a = await ask(ALL, "How many times is Skippy mentioned in Silver Noon?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe('Counting exact mentions of "Skippy" in Silver Noon...');
    expect(a.text).toContain("**Skippy** appears **2** times in Silver Noon.");
    expect(a.text).toContain("- **Silver Noon**: 2");
    expect(a.text).not.toContain("Iron Dawn");
    expect(a.sources.map((s) => s.book)).toEqual(["Silver Noon", "Silver Noon"]);
    noBedrock();
  });

  it("counts the series in focus", async () => {
    const a = await ask(SERIES_SCOPE, "How many times is Skippy mentioned?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.text).toContain("**Skippy** appears **6** times in **Star Run**.");
    expect(a.text).not.toContain("## Books counted");
    expect(a.text).toContain("- **Book 3 · Golden Dusk**: 1");
    expect(a.sources).toHaveLength(5);
    noBedrock();
  });

  it("counts the book in focus", async () => {
    const a = await ask(BOOK, "How many times is Skippy mentioned?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe('Counting exact mentions of "Skippy" in "Silver Noon"...');
    expect(a.text).toContain("**Skippy** appears **2** times in **Silver Noon**.");
    expect(a.sources).toEqual([
      { book: "Silver Noon", excerpt: expect.any(String), position: "Chapter 1" },
      { book: "Silver Noon", excerpt: expect.any(String), position: "Chapter 2" },
    ]);
    noBedrock();
  });

  it("lets 'first N books' win over the book in focus", async () => {
    const a = await ask(BOOK, "How many times is Skippy mentioned in the first 2 books?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.text).toContain("**Skippy** appears **5** times in the first **2** books of **Star Run**.");
    noBedrock();
  });

  it("asks who to count when the target is a dangling pronoun", async () => {
    const a = await ask(ALL, "How many times is he mentioned?");
    expect(a.types).toEqual(["TEXT"]);
    expect(a.text).toBe("I can count mentions exactly in your indexed text — who should I count?");
    noBedrock();
  });

  describe("short follow-up after a count ('and Joe?')", () => {
    const followUp: ChatMessage[] = [
      { role: "user", content: "How many times is Skippy mentioned?" },
      { role: "assistant", content: "Skippy appears 6 times." },
      { role: "user", content: "and Joe?" },
    ];

    it.each([
      [ALL, "**Joe** appears **7** times across your library."],
      [SERIES_SCOPE, "**Joe** appears **7** times in **Star Run**."],
      [BOOK, "**Joe** appears **1** times in **Silver Noon**."],
    ])("counts again in %o", async (scope, sentence) => {
      const a = await ask(scope, followUp);
      expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "TEXT", "SOURCES"]);
      expect(a.statuses[2]).toContain('Counting exact mentions of "Joe"');
      expect(a.text).toContain(sentence);
      expect(textCalls()).toHaveLength(0);
      expect(streamCalls()).toHaveLength(0);
    });
  });
});

describe("quote lookup", () => {
  const QUOTE = '"the stars looked very different today"';

  it("finds the exact line across the library", async () => {
    const a = await ask(ALL, QUOTE);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses.slice(2)).toEqual(["Hunting for that exact line…", "Exact quote matches found: 1"]);
    expect(a.text).toContain("## Exact Quote Matches\n\nFound **1** matches across **1** book(s).\n\n### Iron Dawn\n- **Chapter 1**: ");
    expect(a.sources).toEqual([{ book: "Iron Dawn", excerpt: expect.any(String), position: "Chapter 1" }]);
    expect(store.searchExactQuoteAllBooks).toHaveBeenCalledWith("the stars looked very different today", 120);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it("finds it inside the series", async () => {
    const a = await ask(SERIES_SCOPE, QUOTE);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[2]).toBe("Hunting for that exact line…");
    expect(a.text).toContain("## Exact Quote Matches in Star Run\n\nFound **1** matches across **1** book(s).\n\n### Iron Dawn");
    expect(store.searchExactQuoteInSeries).toHaveBeenCalledWith("series-1", "the stars looked very different today", 90);
    expect(streamCalls()).toHaveLength(0);
  });

  it("finds it inside one book", async () => {
    const a = await ask({ bookId: "book-1", bookTitle: "Iron Dawn" }, QUOTE);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "TEXT", "SOURCES"]);
    expect(a.text).toContain("## Exact Quote Matches in Iron Dawn\n\nFound **1** matches.\n- **Chapter 1**: ");
    expect(a.sources).toEqual([{ book: "Iron Dawn", excerpt: expect.any(String), position: "Chapter 1" }]);
    expect(store.searchExactQuoteInBook).toHaveBeenCalledWith("book-1", "the stars looked very different today", 70);
    expect(streamCalls()).toHaveLength(0);
  });
});

describe("fallback RAG (a quote that is not in the text)", () => {
  const MISSING = '"a sentence that appears in none of the volumes"';
  const RAG_TYPES = [
    "STATUS", // route
    "STATUS", // searching
    "STATUS", // exact quote lookup
    "STATUS", // no exact match
    "STATUS", // keyword search
    "STATUS", // found n + m
    "STATUS", // building context
    "STATUS", // sending to Claude
    "TOKEN",
    "WHY",
    "STATUS", // done
    "SOURCES",
  ];

  it.each([
    [
      ALL,
      "No exact quote matches found in stored page text",
      "Found 7 semantic + 0 keyword matches from 4 books",
      7,
      '[Passage 1 — from "Iron Dawn", Chapter 1]',
      "You are a close friend who knows this library extremely well.",
    ],
    [
      SERIES_SCOPE,
      "No exact quote matches found in this series",
      "Found 5 semantic + 0 keyword matches from 3 books in this series",
      5,
      '[Passage 1 — from "Iron Dawn", Chapter 1]',
      'You are a close friend who knows the series "Star Run" extremely well.',
    ],
    [
      BOOK,
      "No exact quote matches found in this book",
      "Found 2 semantic + 0 keyword matches",
      2,
      "[Passage 1, Chapter 1]",
      'You are a close friend who knows "Silver Noon" extremely well.',
    ],
  ])("streams a cited answer for %o", async (scope, missStatus, foundStatus, sourceCount, header, opening) => {
    const a = await ask(scope, MISSING);
    expect(a.types).toEqual(RAG_TYPES);
    expect(a.statuses[3]).toBe(missStatus);
    expect(a.statuses[4]).toBe("Scanning for matching words…");
    expect(a.statuses[5]).toBe(foundStatus);
    expect(a.statuses[6]).toBe("Gathering the pages that matter…");
    expect(a.statuses[7]).toBe("Remembering the passages with you…");
    expect(a.statuses[8]).toBe("Done.");
    expect(a.tokens).toBe(STREAMED_ANSWER);
    expect(a.sources).toHaveLength(sourceCount);
    expect(a.json("WHY")).toEqual([
      { groundedMode: false, sourceCount, specialistModelId: "test-model", orchestratorModelId: "test-model" },
    ]);
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(1);
    const [prompt, , maxTokens, temperature, modelId, opts] = streamCalls()[0];
    expect(prompt).toBe(`Conversation so far:\nUSER:\n${MISSING}`);
    expect([maxTokens, temperature, modelId]).toEqual([2500, 0.2, "test-model"]);
    expect(opts?.system?.startsWith(opening)).toBe(true);
    expect(opts?.system).toContain(header);
    expect(opts?.system).toContain("USER PERSONALITY SETTINGS:");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("includes keyword matches after the semantic passages", async () => {
    const a = await ask(BOOK, '"the opera that Skippy never ever sang aloud"');
    expect(a.statuses[5]).toBe("Found 2 semantic + 2 keyword matches");
    expect(a.sources).toHaveLength(4);
    expect(streamCalls()[0][5]?.system).toContain("[Passage 3, Chapter 1]");
    expect(store.searchBookKeyword).toHaveBeenCalledWith("book-2", ["opera", "skippy", "never", "sang", "aloud"], 40);
  });

  it("blocks an uncited answer in grounded mode", async () => {
    resetSettings({ groundedMode: true });
    const a = await ask(ALL, MISSING);
    expect(a.types).toEqual([...RAG_TYPES.slice(0, 8), "STATUS", "TOKEN", "WHY", "STATUS", "SOURCES"]);
    expect(a.statuses[8]).toBe("Grounded mode blocked unsupported answer.");
    expect(a.tokens).toBe("insufficient evidence");
    expect(textCalls()).toHaveLength(1);
    expect(streamCalls()).toHaveLength(0);
  });

  it("lets a cited answer through in grounded mode", async () => {
    resetSettings({ groundedMode: true });
    claude.text = async () => "They met in a warehouse (Passage 1, Chapter 1).";
    const a = await ask(ALL, MISSING);
    expect(a.types).toEqual(RAG_TYPES);
    expect(a.tokens).toBe("They met in a warehouse (Passage 1, Chapter 1).");
  });
});

describe("passage find", () => {
  it.each([ALL, SERIES_SCOPE, BOOK])("finds the recipe in %o", async (scope) => {
    const a = await ask(scope, "Can you find the cheeseburger recipe?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe("Searching for the best matching passages…");
    expect(a.text).toContain("**Fluff Screamer**");
    expect(a.text).toContain("- Raw onions");
    expect(a.text).toContain("From **Silver Noon · Chapter 1**.");
    expect(a.sources).toEqual([
      { book: "Silver Noon", bookId: "book-2", excerpt: expect.stringContaining("Fluff Screamer"), position: "Chapter 1" },
    ]);
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it("says so when the focused book has none", async () => {
    const a = await ask({ bookId: "book-1", bookTitle: "Iron Dawn" }, "Can you find the cheeseburger recipe?");
    expect(a.types).toEqual(["STATUS", "TEXT"]);
    expect(a.text).toContain("I couldn’t find an actual burger recipe");
  });
});

describe("pop-culture survey", () => {
  it.each([
    [ALL, ["Star Trek", "Star Wars", "Shakespeare"]],
    [SERIES_SCOPE, ["Star Trek", "Star Wars"]],
    [{ bookId: "book-4", bookTitle: "Lonely Harbor" }, ["Shakespeare"]],
  ])("scans the stored text of %o", async (scope, labels) => {
    const a = await ask(scope, "Are there any pop culture references?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe("Scanning for movie, TV, and book shout-outs…");
    expect(a.text).toContain(`I spotted references to: **${labels.join("**, **")}**.`);
    expect(a.sources).toHaveLength(labels.length);
    expect(a.sources[0].bookId).toBeTruthy();
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });
});

describe("knowledge shortcuts", () => {
  it("answers entity graph questions from the graph", async () => {
    const a = await ask(ALL, "Show me the entity graph for Skippy");
    expect(a.types).toEqual(["STATUS", "TEXT"]);
    expect(a.text).toContain("## Entity Graph Matches\n\nNodes: 2, Edges: 0\n- **Skippy** (character) mentions: 40");
    expect(textCalls()).toHaveLength(0);
  });

  it("answers timeline conflict questions from the timeline", async () => {
    const a = await ask(SERIES_SCOPE, "Is there a timeline conflict here?");
    expect(a.types).toEqual(["STATUS", "TEXT"]);
    expect(a.text).toBe("## Timeline Conflicts\n\nNo obvious chronology conflicts detected.");
    expect(textCalls()).toHaveLength(0);
  });
});

describe("specialists + orchestrator", () => {
  const QUESTION = "What does Skippy think about humans?";
  type Report = { bookTitle: string; confidence: string; findingsCount: number };

  it("reads the semantically ranked books of the library", async () => {
    const a = await ask(ALL, QUESTION);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[0]).toBe("Thinking about how to answer you…");
    expect(a.statuses[2]).toBe("Picking which books to reread with you…");
    expect(a.statuses[3]).toBe("Reading: Iron Dawn, Silver Noon, Golden Dusk, Lonely Harbor");
    expect(a.statuses[4]).toMatch(/^Reading along in Librarian \w+, Librarian \w+, Librarian \w+, Librarian \w+\.\.\.…$/);
    expect(a.statuses[5]).toBe("Putting the pieces together…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual([
      "Iron Dawn",
      "Silver Noon",
      "Golden Dusk",
      "Lonely Harbor",
    ]);
    expect(a.tokens).toBe(STREAMED_ANSWER);
    expect(a.text).toBe("");
    expect(a.sources).toEqual(
      ["Iron Dawn", "Silver Noon", "Golden Dusk", "Lonely Harbor"].map((book) => ({
        book,
        excerpt: "filthy monkeys",
        position: "Chapter 2",
      }))
    );
    // One seed query for the request; the specialists reuse its passages.
    expect(store.queryAllBooks).toHaveBeenCalledTimes(1);
    expect(store.queryAllBooks).toHaveBeenCalledWith(QUESTION, 40);
    expect(store.queryBook).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(4);
    expect(textCalls().every((c) => c[4]?.system?.includes("specialist AI"))).toBe(true);
    expect(streamCalls()).toHaveLength(1);
    expect(streamCalls()[0][0]).toContain(`User question: ${QUESTION}`);
    expect(streamCalls()[0][0]).toContain(SPECIALIST_JSON.slice(1, 40));
  });

  it("reads only the book the question names", async () => {
    const a = await ask(ALL, `In Silver Noon, ${QUESTION.toLowerCase()}`);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[3]).toBe("Reading Silver Noon (named in your question)");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(a.sources).toEqual([{ book: "Silver Noon", excerpt: "filthy monkeys", position: "Chapter 2" }]);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
    expect(store.queryBook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.queryBook).mock.calls[0][0]).toBe("book-2");
    expect(textCalls()).toHaveLength(1);
    expect(textCalls()[0][4]?.system).toContain('single book "Silver Noon"');
    expect(streamCalls()).toHaveLength(1);
  });

  it("reads the books of the series in focus", async () => {
    const a = await ask(SERIES_SCOPE, QUESTION);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[2]).toBe("Reading: Iron Dawn, Silver Noon, Golden Dusk");
    expect(a.statuses[3]).toMatch(/^Consulting 3 series Librarians: Librarian \w+, Librarian \w+, Librarian \w+\.\.\.$/);
    expect(a.statuses[4]).toBe("Putting the pieces together…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Iron Dawn", "Silver Noon", "Golden Dusk"]);
    expect(a.sources).toHaveLength(3);
    expect(store.querySeriesBooks).toHaveBeenCalledTimes(1);
    expect(store.querySeriesBooks).toHaveBeenCalledWith("series-1", QUESTION, 48);
    expect(store.queryBook).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(3);
    expect(streamCalls()).toHaveLength(1);
    // Series order goes to the orchestrator as a continuity hint.
    expect(streamCalls()[0][5]?.system).toContain("SERIES CONTINUITY: These books are ordered as: Iron Dawn → Silver Noon → Golden Dusk.");
  });

  it("reads only the named book inside a series", async () => {
    const a = await ask(SERIES_SCOPE, `In Silver Noon, ${QUESTION.toLowerCase()}`);
    expect(a.statuses[2]).toBe("Reading Silver Noon (named in your question)");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(store.querySeriesBooks).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(1);
  });

  it("puts named books first inside a series when the question compares", async () => {
    const a = await ask(SERIES_SCOPE, "Compare Golden Dusk with the other books: what does Skippy think about humans?");
    expect(a.statuses[2]).toBe("Reading Golden Dusk (named in your question), then Iron Dawn, Silver Noon");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Golden Dusk", "Iron Dawn", "Silver Noon"]);
    expect(store.querySeriesBooks).toHaveBeenCalledTimes(1);
    expect(textCalls()).toHaveLength(3);
  });

  it("asks the one librarian of the book in focus", async () => {
    const a = await ask(BOOK, QUESTION);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[2]).toMatch(/^Consulting Librarian \w+ for "Silver Noon"\.\.\.$/);
    expect(a.statuses[3]).toBe("Writing this down for you…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(a.sources).toEqual([{ book: "Silver Noon", excerpt: "filthy monkeys", position: "Chapter 2" }]);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
    expect(store.queryBook).toHaveBeenCalledTimes(1);
    expect(textCalls()).toHaveLength(1);
    expect(streamCalls()).toHaveLength(1);
  });

  it("keeps the focused book even when the question names another", async () => {
    const a = await ask(BOOK, "In Iron Dawn, what does Skippy think about humans?");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(textCalls()).toHaveLength(1);
  });
});

describe("abort mid-request", () => {
  it("stops quietly: no ERROR, no answer, Bedrock calls see the aborted signal", async () => {
    const seen: AbortSignal[] = [];
    claude.text = (_prompt, opts) =>
      new Promise<string>((_resolve, reject) => {
        const signal = opts!.signal!;
        seen.push(signal);
        signal.addEventListener("abort", () => {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const controller = new AbortController();
    const res = await POST(
      request(ALL, [{ role: "user", content: "What does Skippy think about humans?" }], controller.signal)
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let aborted = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      // Stop once the specialists are in flight.
      if (!aborted && seen.length === 4) {
        aborted = true;
        controller.abort();
      }
      if (!aborted && body.includes("Librarian")) {
        await vi.waitFor(() => expect(seen).toHaveLength(4));
        aborted = true;
        controller.abort();
      }
    }
    const a = new Answer(parseLines(body));
    expect(aborted).toBe(true);
    expect(a.types.every((t) => t === "STATUS")).toBe(true);
    expect(a.of("ERROR")).toEqual([]);
    expect(a.of("USAGE")).toEqual([]);
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s.aborted)).toBe(true);
    expect(streamCalls()).toHaveLength(0);
    expect(logged("chat_stream_aborted")).toHaveLength(1);
    expect(logged("chat_stream_error")).toHaveLength(0);
  });
});

describe("SCOPE line (the books an answer is drawn from)", () => {
  type ScopeLine = { books: Array<{ id: string; title: string }>; reason: string; more?: number };
  const scopeOf = (a: Answer) => {
    const lines = a.json<ScopeLine>("SCOPE");
    expect(lines).toHaveLength(1);
    return { ...lines[0], ids: lines[0].books.map((b) => b.id) };
  };
  const SPECIALIST_Q = "What does Skippy think about humans?";
  const SERIES_IDS = ["book-1", "book-2", "book-3"];
  const ALL_IDS = [...SERIES_IDS, "book-4"];

  it.each([
    ["semantic selection", ALL, SPECIALIST_Q, "semantic", ALL_IDS],
    ["a named book", ALL, `In Silver Noon, ${SPECIALIST_Q}`, "named", ["book-2"]],
    ["the series in focus", SERIES_SCOPE, SPECIALIST_Q, "series", SERIES_IDS],
    ["a named book in the series", SERIES_SCOPE, `In Silver Noon, ${SPECIALIST_Q}`, "named", ["book-2"]],
    ["the book in focus", BOOK, SPECIALIST_Q, "focus", ["book-2"]],
    ["a library-wide count", ALL, "How many times is Skippy mentioned?", "all", ALL_IDS],
    ["a count in a named book", ALL, "How many times is Skippy mentioned in Silver Noon?", "named", ["book-2"]],
    ["a count over the first N books", ALL, "How many times is Skippy mentioned in the first 2 books?", "series", ["book-1", "book-2"]],
    ["a count in the focused book", BOOK, "How many times is Skippy mentioned?", "focus", ["book-2"]],
    ["who-is in the library", ALL, "Who is Skippy?", "all", ALL_IDS],
    ["who-is in a series", SERIES_SCOPE, "Who is Skippy?", "series", SERIES_IDS],
    ["a quote in a book", BOOK, '"Skippy sang opera badly."', "focus", ["book-2"]],
    ["retrieval in the library", ALL, '"a sentence that appears in none of the volumes"', "all", ALL_IDS],
    ["passage find", SERIES_SCOPE, "Can you find the cheeseburger recipe?", "series", SERIES_IDS],
    ["small talk (reads nothing)", ALL, "hello there", "all", []],
    ["a library command (reads nothing)", BOOK, "list my books", "focus", []],
  ])("reports %s", async (_name, scope, question, reason, ids) => {
    const info = scopeOf(await ask(scope, question));
    expect(info.reason).toBe(reason);
    expect(info.ids).toEqual(ids);
    expect(info.more).toBeUndefined();
  });

  it("comes before the first Bedrock call and carries display titles", async () => {
    const a = await ask(ALL, SPECIALIST_Q);
    const types = a.all.map((l) => l.type);
    expect(types.indexOf("SCOPE")).toBeLessThan(types.indexOf("SPECIALISTS"));
    expect(types.indexOf("SCOPE")).toBeLessThan(types.indexOf("TOKEN"));
    expect(scopeOf(a).books[1]).toEqual({ id: "book-2", title: "Silver Noon" });
  });

  it("caps the list at 20 books and says how many more", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `book-${100 + i}`,
      title: `Volume ${i + 1}`,
      filename: `v${i}.epub`,
      wordCount: 1,
      addedAt: "2026-01-01T00:00:00.000Z",
    }));
    vi.mocked(store.listBooks).mockImplementation(() => many as never);
    try {
      const info = scopeOf(await ask(ALL, "Who is Skippy?"));
      expect(info.books).toHaveLength(20);
      expect(info.more).toBe(5);
      expect(info.reason).toBe("all");
    } finally {
      const { fakeStore } = await import("./chat-fixtures");
      vi.mocked(store.listBooks).mockImplementation(fakeStore.listBooks as never);
    }
  });
});

describe("USAGE line (what this request spent)", () => {
  type Usage = { claudeCalls: number; inputTokens: number; outputTokens: number; embedCalls: number; ms: number };
  const usageOf = (a: Answer) => {
    const lines = a.json<Usage>("USAGE");
    expect(lines).toHaveLength(1);
    // Always the last line of the stream.
    expect(a.all[a.all.length - 1].type).toBe("USAGE");
    expect(lines[0].ms).toBeGreaterThanOrEqual(0);
    return lines[0];
  };

  it("adds up the specialists and the orchestrator", async () => {
    const usage = usageOf(await ask(ALL, "What does Skippy think about humans?"));
    expect(usage).toMatchObject({ claudeCalls: 5, inputTokens: 4 * 100 + 300, outputTokens: 4 * 20 + 50, embedCalls: 0 });
  });

  it("is zero for answers computed from the stored text", async () => {
    const usage = usageOf(await ask(ALL, "How many times is Skippy mentioned?"));
    expect(usage).toMatchObject({ claudeCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 0 });
    expect(usageOf(await ask(BOOK, "list my books")).claudeCalls).toBe(0);
  });

  it("is per request, not cumulative", async () => {
    expect(usageOf(await ask(ALL, "Who is Skippy?")).claudeCalls).toBe(1);
    expect(usageOf(await ask(ALL, "Who is Skippy?")).claudeCalls).toBe(1);
  });

  it("keeps concurrent requests apart", async () => {
    const [a, b] = await Promise.all([ask(ALL, "What does Skippy think about humans?"), ask(BOOK, "Who is Skippy?")]);
    expect(usageOf(a).claudeCalls).toBe(5);
    expect(usageOf(b).claudeCalls).toBe(1);
  });

  it("still closes the stream with USAGE after an ERROR", async () => {
    claude.text = async () => {
      throw new Error("boom");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await ask(ALL, "Who is Skippy?");
    errorSpy.mockRestore();
    expect(a.of("ERROR")).toHaveLength(1);
    expect(usageOf(a).claudeCalls).toBe(0);
  });
});
