import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOKS, ENTITY_NODES, SPECIALIST_JSON, STREAMED_ANSWER, resetSettings } from "./chat-fixtures";

type ClaudeOpts = { signal?: AbortSignal; system?: string } | undefined;

/** Per-test overrides for the mocked Bedrock calls. */
const claude = vi.hoisted(() => ({
  text: null as null | ((prompt: string, opts: ClaudeOpts, modelId?: string) => Promise<string>),
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
        const text = await (claude.text || defaultText)(prompt, opts, _modelId);
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

vi.mock("@/lib/knowledge-rebuild", () => ({ ensureKnowledgeCurrent: vi.fn(() => 0) }));
vi.mock("@/lib/quality-store", () => ({
  fingerprintQuestion: (bookId: string, question: string) => `${bookId}::${question}`,
  getCachedSpecialistAnswer: vi.fn(() => null),
  setCachedSpecialistAnswer: vi.fn(),
  updateSpecialistScorecard: vi.fn(() => ({ precisionEstimate: 0.5, recallEstimate: 0.5, total: 1 })),
}));

vi.mock("@/lib/chat-debug", () => ({ logChatEvent: vi.fn() }));

// What is remembered about the cheaper librarian models: in memory, never the real data dir.
const routing = vi.hoisted(() => ({ state: { models: {} } as { models: Record<string, unknown> } }));
vi.mock("@/lib/model-routing-store", () => ({
  loadModelRoutingState: () => routing.state,
  saveModelRoutingState: (next: { models: Record<string, unknown> }) => {
    routing.state = next;
  },
  clearModelRoutingState: () => {
    routing.state = { models: {} };
  },
}));

vi.mock("@/lib/reindex-manager", () => ({
  getReindexState: vi.fn(() => ({ running: false, processed: 0, total: 0, finishedAt: "" })),
  startFullReindex: vi.fn(async () => ({ running: true, processed: 0, total: 4 })),
}));

import * as store from "@/lib/book-store";
import { callClaudeStream, callClaudeText } from "@/lib/bedrock-claude";
import { logChatEvent } from "@/lib/chat-debug";
import { getEntityGraph } from "@/lib/knowledge-store";
import { MAX_SPECIALIST_CALLS_PER_REQUEST } from "@/lib/chat/constants";
import { POST } from "@/lib/chat/handler";
import { previewScope } from "@/lib/chat/scope";
import { decodeStreamLine } from "@/lib/chat/stream-protocol";
import type { ChatMessage, ChatSource } from "@/lib/chat/types";

type Line = { type: string; data: string };

/** Auto routing: the first cheaper candidate for the mocked main model "test-model" (no region prefix). */
const CHEAP_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0";

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
  /** Sources as sent; each carries the id of its book. */
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
  routing.state = { models: {} };
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
      bookId: BOOKS.find((b) => b.title === firstBook)?.id,
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

describe("main characters from a noisy graph", () => {
  it("adds up a name's per-book nodes and drops sentence starters", async () => {
    vi.mocked(getEntityGraph).mockImplementation(
      () =>
        ({
          nodes: [
            { name: "The", type: "character", mentions: 50, books: ["book-1"] },
            { name: "The", type: "character", mentions: 45, books: ["book-2"] },
            { name: "That", type: "character", mentions: 43, books: ["book-3"] },
            { name: "Skippy", type: "character", mentions: 20, books: ["book-1"] },
            { name: "Skippy", type: "character", mentions: 22, books: ["book-2"] },
            { name: "Joe", type: "character", mentions: 30, books: ["book-3"] },
            { name: "Mara", type: "character", mentions: 40, books: ["book-4"] },
          ],
          edges: [],
        }) as never
    );
    const a = await ask(SERIES_SCOPE, "Who are the main characters?");
    const text = a.text + a.tokens;
    expect(text).toContain("- **Skippy** (mentions: 42)");
    expect(text).toContain("- **Joe** (mentions: 30)");
    expect(text).not.toMatch(/\*\*(The|That|Mara)\*\*/);
    expect(text).toContain("about **2 main characters**");
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
    expect(a.sources[0]).toEqual({ book: "Iron Dawn", bookId: "book-1", excerpt: expect.any(String), position: "Chapter 1" });
    // Every citation names its book by id, so the reader can open it after a retitle.
    expect(a.sources.every((r) => r.bookId)).toBe(true);
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
      { book: "Silver Noon", bookId: "book-2", excerpt: expect.any(String), position: "Chapter 1" },
      { book: "Silver Noon", bookId: "book-2", excerpt: expect.any(String), position: "Chapter 2" },
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
      // Routed as a count: answered first, nothing is searched or embedded.
      expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
      expect(a.statuses[0]).toContain('Counting exact mentions of "Joe"');
      expect(a.text).toContain(sentence);
      expect(logged("chat_routed")[0][1]).toMatchObject({ kind: "mention_count", target: "Joe" });
      expect(textCalls()).toHaveLength(0);
      expect(streamCalls()).toHaveLength(0);
      expect(store.queryAllBooks).not.toHaveBeenCalled();
    });

    it("counts where the count before it did", async () => {
      const inBook: ChatMessage[] = [
        { role: "user", content: "How many times is Skippy mentioned in Silver Noon?" },
        { role: "assistant", content: "Skippy appears 2 times in Silver Noon." },
        { role: "user", content: "and Joe?" },
      ];
      const a = await ask(ALL, inBook);
      expect(a.text).toContain("**Joe** appears **1** times in Silver Noon.");
      expect(a.json<{ reason: string; books: Array<{ id: string }> }>("SCOPE")).toEqual([
        { books: [{ id: "book-2", title: "Silver Noon" }], reason: "named" },
      ]);
      expect(a.sources.every((s) => s.bookId === "book-2")).toBe(true);

      const firstTwo: ChatMessage[] = [
        { role: "user", content: "How many times is Skippy mentioned in the first 2 books?" },
        { role: "assistant", content: "Skippy appears 5 times." },
        { role: "user", content: "and Joe?" },
      ];
      const b = await ask(ALL, firstTwo);
      expect(b.json<{ books: Array<{ id: string }> }>("SCOPE")[0].books.map((x) => x.id)).toEqual(["book-1", "book-2"]);
    });

    it("leaves a greeting or a real question after a count alone", async () => {
      const after = (content: string): ChatMessage[] => [...followUp.slice(0, 2), { role: "user", content }];
      expect((await ask(ALL, after("hello there"))).text).not.toContain("appears");
      expect(logged("chat_routed")[0][1]).toMatchObject({ kind: "bypass_general" });
      vi.clearAllMocks();
      await ask(ALL, after("Why does Joe trust him so much?"));
      expect(logged("chat_routed")[0][1]).toMatchObject({ kind: "open_rag" });
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
    expect(a.sources).toEqual([{ book: "Iron Dawn", bookId: "book-1", excerpt: expect.any(String), position: "Chapter 1" }]);
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
    expect(a.sources).toEqual([{ book: "Iron Dawn", bookId: "book-1", excerpt: expect.any(String), position: "Chapter 1" }]);
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
      "Found 8 semantic + 0 keyword matches from 4 books",
      8,
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
      { groundedMode: false, sourceCount, specialistModelId: CHEAP_MODEL, orchestratorModelId: "test-model" },
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
    expect(a.text).toBe(
      [
        "**Fluff Screamer**",
        "",
        "- Cheeseburger",
        "- Raw onions",
        "- Hot and spicy chili sauce",
        "- A pat of butter",
        "- Marshmallow Fluff",
        "",
        "From **Silver Noon · Chapter 1**. Open **Sources** below to read the passage.",
      ].join("\n")
    );
    expect(a.sources).toEqual([
      { book: "Silver Noon", bookId: "book-2", excerpt: expect.stringContaining("Fluff Screamer"), position: "Chapter 1" },
    ]);
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it("says so when the focused book has none", async () => {
    const a = await ask({ bookId: "book-1", bookTitle: "Iron Dawn" }, "Can you find the cheeseburger recipe?");
    expect(a.types).toEqual(["STATUS", "TEXT"]);
    expect(a.text).toBe("I couldn’t find a passage about **cheeseburger** in your indexed books.");
  });

  it.each([
    "What is the chowder recipe?",
    "How do you make chowder?",
    "What are the ingredients of the chowder?",
  ])("builds a card for any dish the text lists: %s", async (question) => {
    const a = await ask(ALL, question);
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.text).toBe(
      [
        "**Chowder**",
        "",
        "- Smoked haddock",
        "- Potatoes",
        "- Leeks",
        "- A splash of cream",
        "",
        "From **Lonely Harbor · Page 3**. Open **Sources** below to read the passage.",
      ].join("\n")
    );
    expect(a.sources[0]).toMatchObject({ book: "Lonely Harbor", bookId: "book-4", position: "Page 3" });
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it("answers with the passage itself when it lists nothing", async () => {
    const a = await ask(ALL, "Is there a recipe for nets?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.text).toBe(
      "The harbor was quiet. Mara repaired nets by lamplight.\n\nFrom **Lonely Harbor · Page 1**. Open **Sources** below to read the passage."
    );
    expect(textCalls()).toHaveLength(0);
  });

  it("does not take company for ingredients", async () => {
    // "with Joe, Skippy and the others" follows no dish: a passage, not a list.
    vi.mocked(store.loadBookPages).mockImplementationOnce(() => [
      { label: "Chapter 9", text: "The stew simmered all night. Mara ate with Joe, Skippy, the gulls, and the harbor master." },
    ]);
    const a = await ask(BOOK, "Find the stew recipe");
    expect(a.text).toMatch(/^The stew simmered all night\./);
    expect(a.text).not.toContain("- Joe");
  });

  it("finds the dish inside a longer word, and reads numbered and line lists", async () => {
    vi.mocked(store.loadBookPages).mockImplementationOnce(() => [
      { label: "Chapter 4", text: "Joe wrote it down.\nPancake ingredients:\nflour\ntwo eggs\na cup of milk\nThen he lost the note." },
    ]);
    expect((await ask(BOOK, "Find the pancake recipe")).text).toContain("**Pancake**\n\n- Flour\n- Two eggs\n- A cup of milk\n\nFrom");

    vi.mocked(store.loadBookPages).mockImplementationOnce(() => [
      { label: "Chapter 5", text: "How to brew sludge coffee: 1. Boil the water twice. 2. Add the grounds. 3. Wait until it fights back." },
    ]);
    expect((await ask(BOOK, "Is there a coffee recipe?")).text).toContain(
      "- Boil the water twice\n- Add the grounds\n- Wait until it fights back"
    );

    // The last item held back for effect, and the dish named before the list.
    vi.mocked(store.loadBookPages).mockImplementationOnce(() => [
      {
        label: "Chapter 30",
        text: "It was called a ‘Mud Pie’. The crew stared. Imagine this, if you dare. A brownie, with whipped cream, a hot fudge sauce, a pat of butter on top, and- Wait for it. Waaaaaait for it. Crushed pretzels. Genius, right? Mara, with Joe, Skippy, and the gulls, ate it all.",
      },
    ]);
    expect((await ask(BOOK, "How do you make a mud pie?")).text).toContain(
      "**Mud Pie**\n\n- Brownie\n- Whipped cream\n- A hot fudge sauce\n- A pat of butter\n- Crushed pretzels\n\nFrom"
    );

    // "burger" finds the cheeseburger; no dish names are built in.
    expect((await ask(BOOK, "burger recipe?")).text).toContain("**Fluff Screamer**");
  });

  it("leaves 'how do you make…' to the librarians when no passage lists anything", async () => {
    const a = await ask(ALL, "How do you make a warehouse feel dusty?");
    expect(a.types).toContain("SPECIALISTS");
    expect(a.text).toBe("");
    expect(a.tokens).toBe(STREAMED_ANSWER);
    expect(logged("passage_find_passed")).toHaveLength(1);
  });

  it("…also when a passage lists things but is about something else", async () => {
    // A real list next to one of the words ("chowder"), but not about a "chowder cannon".
    const a = await ask(ALL, "How do you make a chowder cannon?");
    expect(a.types).toContain("SPECIALISTS");
    expect(a.text).toBe("");
    // Said outright, the same passage is still the closest recipe.
    expect((await ask(ALL, "chowder cannon recipe?")).text).toContain("- Smoked haddock");
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
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[0]).toBe("Thinking about how to answer you…");
    expect(a.statuses[2]).toBe("Picking which books to reread with you…");
    // The closest three are asked first; the fourth is only read if they come back thin.
    expect(a.statuses[3]).toBe("Reading Iron Dawn, Silver Noon and Golden Dusk…");
    expect(a.statuses[4]).toBe("Putting the pieces together…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual([
      "Iron Dawn",
      "Silver Noon",
      "Golden Dusk",
    ]);
    expect(a.tokens).toBe(STREAMED_ANSWER);
    expect(a.text).toBe("");
    expect(a.sources).toEqual(
      ["Iron Dawn", "Silver Noon", "Golden Dusk"].map((book) => ({
        book,
        bookId: BOOKS.find((b) => b.title === book)?.id,
        excerpt: "filthy monkeys",
        position: "Chapter 2",
      }))
    );
    // One seed query for the request; the specialists reuse its passages.
    expect(store.queryAllBooks).toHaveBeenCalledTimes(1);
    expect(store.queryAllBooks).toHaveBeenCalledWith(QUESTION, 40);
    expect(store.queryBook).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(3);
    expect(textCalls().every((c) => c[4]?.system?.includes("specialist AI"))).toBe(true);
    // The librarians run on the cheaper model, the orchestrator on the main one.
    expect(textCalls().map((c) => c[3])).toEqual([CHEAP_MODEL, CHEAP_MODEL, CHEAP_MODEL]);
    expect(streamCalls()).toHaveLength(1);
    expect(streamCalls()[0][4]).toBe("test-model");
    expect(logged("specialist_model_used")).toHaveLength(3);
    expect(streamCalls()[0][0]).toContain(`User question: ${QUESTION}`);
    expect(streamCalls()[0][0]).toContain(SPECIALIST_JSON.slice(1, 40));
  });

  it("reads only the book the question names", async () => {
    const a = await ask(ALL, `In Silver Noon, ${QUESTION.toLowerCase()}`);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[3]).toBe("Reading Silver Noon…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(a.sources).toEqual([{ book: "Silver Noon", bookId: "book-2", excerpt: "filthy monkeys", position: "Chapter 2" }]);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
    expect(store.queryBook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.queryBook).mock.calls[0][0]).toBe("book-2");
    expect(textCalls()).toHaveLength(1);
    expect(textCalls()[0][4]?.system).toContain('single book "Silver Noon"');
    expect(streamCalls()).toHaveLength(1);
  });

  it("reads the books of the series in focus", async () => {
    const a = await ask(SERIES_SCOPE, QUESTION);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[2]).toBe("Reading Iron Dawn, Silver Noon and Golden Dusk…");
    expect(a.statuses[3]).toBe("Putting the pieces together…");
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
    expect(a.statuses[2]).toBe("Reading Silver Noon…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(store.querySeriesBooks).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(1);
  });

  it("puts named books first inside a series when the question compares", async () => {
    const a = await ask(SERIES_SCOPE, "Compare Golden Dusk with the other books: what does Skippy think about humans?");
    expect(a.statuses[2]).toBe("Reading Golden Dusk, Iron Dawn and Silver Noon…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Golden Dusk", "Iron Dawn", "Silver Noon"]);
    expect(store.querySeriesBooks).toHaveBeenCalledTimes(1);
    expect(textCalls()).toHaveLength(3);
  });

  it("asks the one librarian of the book in focus", async () => {
    const a = await ask(BOOK, QUESTION);
    expect(a.types).toEqual(["STATUS", "STATUS", "STATUS", "STATUS", "SPECIALISTS", "TOKEN", "SOURCES"]);
    expect(a.statuses[2]).toBe("Reading Silver Noon…");
    expect(a.statuses[3]).toBe("Writing this down for you…");
    expect(a.json<Report[]>("SPECIALISTS")[0].map((r) => r.bookTitle)).toEqual(["Silver Noon"]);
    expect(a.sources).toEqual([{ book: "Silver Noon", bookId: "book-2", excerpt: "filthy monkeys", position: "Chapter 2" }]);
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

  it("names the books being read the same way in raw mode", async () => {
    resetSettings({ companionMode: false });
    const a = await ask(ALL, QUESTION);
    expect(a.statuses).toContain("Reading Iron Dawn, Silver Noon and Golden Dusk…");
    expect(a.statuses.join("\n")).not.toMatch(/Librarian|Consulting/);
  });

  it("uses the model fixed in Settings for the librarians, without trying a cheaper one", async () => {
    resetSettings({ modelRouting: { specialistModelId: "eu.fixed-model" } });
    await ask(BOOK, QUESTION);
    expect(textCalls().map((c) => c[3])).toEqual(["eu.fixed-model"]);
    expect(logged("specialist_model_used")).toHaveLength(0);
  });

  it("falls back to the main model when this account can't invoke the cheaper ones, and remembers it", async () => {
    const refused = Object.assign(new Error("You don't have access to the model with the specified model ID."), {
      name: "AccessDeniedException",
    });
    const seen: string[] = [];
    claude.text = async (_prompt, _opts, modelId) => {
      seen.push(String(modelId));
      if (modelId !== "test-model") throw refused;
      return SPECIALIST_JSON;
    };
    const a = await ask(BOOK, QUESTION);
    expect(a.of("ERROR")).toEqual([]);
    expect(a.tokens).toBe(STREAMED_ANSWER);
    expect(seen).toEqual([CHEAP_MODEL, "anthropic.claude-sonnet-4-5-20250929-v1:0", "test-model"]);
    expect(Object.keys(routing.state.models)).toEqual([CHEAP_MODEL, "anthropic.claude-sonnet-4-5-20250929-v1:0"]);

    seen.length = 0;
    await ask({ bookId: "book-1", bookTitle: "Iron Dawn" }, QUESTION);
    expect(seen).toEqual(["test-model"]);
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
      if (!aborted && seen.length === 3) {
        aborted = true;
        controller.abort();
      }
      if (!aborted && body.includes("Reading Iron Dawn")) {
        await vi.waitFor(() => expect(seen).toHaveLength(3));
        aborted = true;
        controller.abort();
      }
    }
    const a = new Answer(parseLines(body));
    expect(aborted).toBe(true);
    expect(a.types.every((t) => t === "STATUS")).toBe(true);
    expect(a.of("ERROR")).toEqual([]);
    expect(a.of("USAGE")).toEqual([]);
    expect(seen).toHaveLength(3);
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
    ["semantic selection", ALL, SPECIALIST_Q, "semantic", SERIES_IDS],
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
    expect(usage).toMatchObject({ claudeCalls: 4, inputTokens: 3 * 100 + 300, outputTokens: 3 * 20 + 50, embedCalls: 0 });
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
    expect(usageOf(a).claudeCalls).toBe(4);
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

describe("books picked by hand", () => {
  const picked = (...ids: string[]) => ({ bookId: "all", bookTitle: "All books", bookIds: ids });

  it("counts only in the picked books, whatever the library holds", async () => {
    const a = await ask(picked("book-1", "book-3"), "How many times is Skippy mentioned?");
    expect(a.text).toContain("**Skippy** appears **4** times in the 2 books you picked.");
    expect(a.text).toContain("- **Iron Dawn**: 3");
    expect(a.text).toContain("- **Golden Dusk**: 1");
    expect(a.text).not.toContain("Silver Noon");
    expect(a.sources.every((s) => s.bookId === "book-1" || s.bookId === "book-3")).toBe(true);
    expect(a.json("SCOPE")).toEqual([
      { books: [{ id: "book-1", title: "Iron Dawn" }, { id: "book-3", title: "Golden Dusk" }], reason: "picked" },
    ]);
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });

  it("sends the librarians of exactly those books", async () => {
    const a = await ask(picked("book-2", "book-4"), "What does Skippy think about humans in general?");
    expect(a.json<{ books: Array<{ id: string }>; reason: string }>("SCOPE")[0]).toMatchObject({
      books: [{ id: "book-2" }, { id: "book-4" }],
      reason: "picked",
    });
    expect(logged("specialist_books_selected")[0][1]).toMatchObject({ chosen: ["Silver Noon", "Lonely Harbor"] });
    // The library-wide seed query is never run for a hand-picked set.
    expect(store.queryAllBooks).not.toHaveBeenCalled();
  });

  it("treats one picked book as a focus book and ignores unknown ids", async () => {
    const a = await ask(picked("book-2", "book-nope"), "How many times is Skippy mentioned?");
    expect(a.text).toContain("**Skippy** appears **2** times in **Silver Noon**");
    expect(a.json<{ reason: string }>("SCOPE")[0].reason).toBe("focus");
  });
});

describe("scope preview (no Bedrock)", () => {
  const preview = (question: string, extra: Partial<Parameters<typeof previewScope>[0]> = {}) =>
    previewScope({ bookId: "all", bookTitle: "All books", question, ...extra });

  it("says the whole library until the question names a book", () => {
    expect(preview("What happens to the crew?")).toEqual({ books: [], reason: "all", more: 4 });
    expect(preview("In Silver Noon, what happens to the crew?")).toEqual({
      books: [{ id: "book-2", title: "Silver Noon" }],
      reason: "named",
    });
  });

  it("knows a focus book, a series and a picked set", () => {
    expect(preview("anything", { bookId: "book-2", bookTitle: "Silver Noon" }).reason).toBe("focus");
    const series = preview("anything", { bookId: "series:series-1", bookTitle: "Star Run" });
    expect(series.reason).toBe("series");
    expect(series.books.map((b) => b.id)).toEqual(["book-1", "book-2", "book-3"]);
    expect(preview("In Silver Noon, who wins?", { bookId: "series:series-1", bookTitle: "Star Run" })).toEqual({
      books: [{ id: "book-2", title: "Silver Noon" }],
      reason: "named",
    });
    expect(preview("anything", { pickedIds: ["book-4", "book-1", "book-4", 7] })).toEqual({
      books: [{ id: "book-4", title: "Lonely Harbor" }, { id: "book-1", title: "Iron Dawn" }],
      reason: "picked",
    });
  });

  it("never embeds or calls Claude", () => {
    preview("In Iron Dawn, how does it start?");
    expect(store.queryAllBooks).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(0);
  });
});

describe("dry run (the chat eval)", () => {
  it("plans the librarians without writing their cache or scorecards", async () => {
    const { runChatInProcess } = await import("@/lib/chat/handler");
    const { setCachedSpecialistAnswer, updateSpecialistScorecard } = await import("@/lib/quality-store");
    const run = await runChatInProcess(
      { bookId: "all", bookTitle: "All books", question: "What does Skippy think about humans in general?" },
      { dryRun: true }
    );
    const a = new Answer(parseLines(run.lines.join("\n")));
    expect(run.route?.kind).toBe("open_rag");
    expect(a.json<{ reason: string }>("SCOPE")[0].reason).toBe("semantic");
    expect(a.json<{ claudeCalls: number }>("USAGE")).toHaveLength(1);
    expect(setCachedSpecialistAnswer).not.toHaveBeenCalled();
    expect(updateSpecialistScorecard).not.toHaveBeenCalled();
  });
});

describe("specialists in two waves (open library questions)", () => {
  const Q = "What does Skippy think about humans?";
  const THIN = JSON.stringify({ confidence: "low", directAnswer: "Nothing here.", numericEstimate: null, findings: [], caveats: [] });
  type Scope = { books: Array<{ id: string }>; reason: string };

  it("reads the rest of the selection when the closest books come back thin", async () => {
    claude.text = async () => THIN;
    const a = await ask(ALL, Q);
    // Three librarians, then the fourth; only then do the four that are still empty read once more.
    expect(textCalls()).toHaveLength(8);
    const reasks = textCalls().map((c) => c[0].startsWith("RE-ASK"));
    expect(reasks).toEqual([false, false, false, false, true, true, true, true]);
    expect(logged("specialists_reasked")[0][1]).toEqual({ count: 4, callsBefore: 4 });
    expect(a.statuses).toContain("Not much there — also reading Lonely Harbor");
    const scopes = a.json<Scope>("SCOPE");
    expect(scopes.map((sc) => sc.books.map((b) => b.id))).toEqual([
      ["book-1", "book-2", "book-3"],
      ["book-1", "book-2", "book-3", "book-4"],
    ]);
    expect(scopes.every((sc) => sc.reason === "semantic")).toBe(true);
    expect(logged("specialists_widened")[0][1]).toEqual({ first: 3, more: 1 });
    expect(streamCalls()).toHaveLength(1);
  });

  it("skips the first wave's second reads when it widens, and re-asks only who is still empty", async () => {
    // The fourth book has the answer: nobody needs a second read once it is in.
    claude.text = async (_prompt, opts) => (opts?.system?.includes('"Lonely Harbor"') ? SPECIALIST_JSON : THIN);
    const a = await ask(ALL, Q);
    // 3 thin first reads + the widened book + second reads for the three empty ones.
    expect(textCalls()).toHaveLength(7);
    expect(textCalls().slice(0, 4).every((c) => !c[0].startsWith("RE-ASK"))).toBe(true);
    expect(a.json<Array<{ bookTitle: string; reasked?: boolean }>>("SPECIALISTS")[0].map((r) => [r.bookTitle, !!r.reasked])).toEqual([
      ["Iron Dawn", true],
      ["Silver Noon", true],
      ["Golden Dusk", true],
      ["Lonely Harbor", false],
    ]);
  });

  it("re-asks an empty librarian when the others answered (no widening)", async () => {
    claude.text = async (prompt, opts) =>
      opts?.system?.includes('"Golden Dusk"') && !prompt.startsWith("RE-ASK") ? THIN : SPECIALIST_JSON;
    const a = await ask(ALL, Q);
    expect(textCalls()).toHaveLength(4);
    expect(textCalls()[3][0].startsWith("RE-ASK")).toBe(true);
    expect(textCalls()[3][4]?.system).toContain('"Golden Dusk"');
    expect(a.json<unknown>("SCOPE")).toHaveLength(1);
    expect(a.sources).toHaveLength(3);
  });

  it("caps the librarian calls of one request", async () => {
    expect(MAX_SPECIALIST_CALLS_PER_REQUEST).toBe(8);
    // Six books in the selection, every answer empty: 6 first reads leave room for 2 second reads.
    const six = [
      ...BOOKS,
      { ...BOOKS[3], id: "book-5", title: "Quiet Tide", filename: "quiet-tide.epub" },
      { ...BOOKS[3], id: "book-6", title: "Far Shore", filename: "far-shore.epub" },
    ];
    const passages = six.map((b) => ({ bookId: b.id, bookTitle: b.title, text: `${b.title} text`, location: "Page 1" }));
    vi.mocked(store.listBooks).mockImplementation(() => six as never);
    vi.mocked(store.queryAllBooks).mockImplementation(async () => passages as never);
    claude.text = async () => THIN;
    try {
      const a = await ask(ALL, Q);
      expect(textCalls()).toHaveLength(MAX_SPECIALIST_CALLS_PER_REQUEST);
      const prompts = textCalls().map((c) => c[0]);
      expect(prompts.filter((p) => p.startsWith("RE-ASK"))).toHaveLength(2);
      // The second reads go to the closest books.
      expect(textCalls().slice(6).map((c) => c[4]?.system?.match(/single book "([^"]+)"/)?.[1])).toEqual([
        "Iron Dawn",
        "Silver Noon",
      ]);
      expect(a.json<Scope>("SCOPE")[1].books).toHaveLength(6);
      expect(streamCalls()).toHaveLength(1);
      expect(logged("specialists_completed")[0][1]).toMatchObject({ count: 6, calls: 8 });

      // Breadth: all six at once, same cap.
      vi.clearAllMocks();
      await ask(ALL, "Compare how Skippy treats humans across all the books");
      expect(textCalls()).toHaveLength(MAX_SPECIALIST_CALLS_PER_REQUEST);
    } finally {
      const { fakeStore } = await import("./chat-fixtures");
      vi.mocked(store.listBooks).mockImplementation(fakeStore.listBooks as never);
      vi.mocked(store.queryAllBooks).mockImplementation(fakeStore.queryAllBooks as never);
    }
  });

  it("asks every selected book at once when the question wants breadth", async () => {
    const a = await ask(ALL, "Compare how Skippy treats humans across all the books");
    expect(textCalls()).toHaveLength(4);
    expect(a.json<Scope>("SCOPE")).toHaveLength(1);
    expect(a.json<Scope>("SCOPE")[0].books).toHaveLength(4);
    expect(logged("specialists_widened")).toHaveLength(0);
  });

  it("never narrows a series in focus or hand-picked books", async () => {
    await ask(SERIES_SCOPE, Q);
    expect(textCalls()).toHaveLength(3);
    vi.clearAllMocks();
    const a = await ask({ bookId: "all", bookTitle: "All books", bookIds: ["book-1", "book-2", "book-3", "book-4"] } as never, Q);
    expect(textCalls()).toHaveLength(4);
    expect(a.json<Scope>("SCOPE")[0].reason).toBe("picked");
  });
});

describe("which books mention X", () => {
  it("lists the books with exact counts and makes no AI call", async () => {
    const a = await ask(ALL, "Which books in my library mention Skippy?");
    expect(a.types).toEqual(["STATUS", "TEXT", "SOURCES"]);
    expect(a.statuses[0]).toBe('Checking which books mention "Skippy" across your library...');
    expect(a.text).toContain("**Skippy** is mentioned in **3 of 4** books across your library");
    expect(a.text).toContain("- **Iron Dawn**: 3 times");
    expect(a.text).toContain("- **Golden Dusk**: 1 time");
    expect(a.text).toContain("Not mentioned in: Lonely Harbor.");
    expect(a.sources.length).toBeGreaterThan(0);
    expect(a.json<{ reason: string; books: unknown[] }>("SCOPE")[0]).toMatchObject({ reason: "all" });
    expect(textCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
    expect(store.queryAllBooks).not.toHaveBeenCalled();
  });

  it("says so plainly when nothing mentions it", async () => {
    vi.mocked(store.countBookKeywordMentions).mockReturnValueOnce(0);
    const a = await ask(BOOK, "Does any book mention Zanzibar?");
    expect(a.text).toMatch(/^No — \*\*Zanzibar\*\* isn't mentioned /);
    expect(a.text).toContain("I checked 1 book.");
    expect(textCalls()).toHaveLength(0);
  });
});
