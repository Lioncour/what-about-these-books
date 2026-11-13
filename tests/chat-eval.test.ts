import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/book-store", () => ({ listBooks: () => [], listSeries: () => [] }));
vi.mock("@/lib/chat/display-title", () => ({ cleanBookDisplayTitle: (t: string) => t }));
vi.mock("@/lib/chat/handler", () => ({ runChatInProcess: vi.fn() }));

import { caseHistory, checkChatCase, observeChat, type ChatEvalObserved } from "@/lib/chat-eval";
import { DRY_RUN_TEXT } from "@/lib/chat/request-context";
import { encodeStreamField } from "@/lib/chat/stream-protocol";

const line = (type: string, data: string) => encodeStreamField(type, data).trimEnd();
const json = (type: string, value: unknown) => line(type, JSON.stringify(value));

const base: ChatEvalObserved = {
  route: "mention_count",
  routerAsked: false,
  scopeReason: "named",
  scopeBooks: ["Columbus Day"],
  scopeMore: 0,
  claudeCalls: 0,
  embedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  ms: 10,
  text: "Skippy appears **766** times in Columbus Day.",
  textIsReal: true,
  sources: ["Columbus Day · Chapter 10 · Skippy"],
  error: null,
};

describe("observeChat", () => {
  it("reads scope, usage, sources and the answer from the stream lines", () => {
    const o = observeChat(
      [
        "STATUS:Counting…",
        json("SCOPE", { books: [{ id: "b1", title: "Columbus Day" }], reason: "named" }),
        line("TEXT", "Skippy appears 766 times.\nSecond line."),
        "SOURCES:" + JSON.stringify([{ book: "Columbus Day", position: "Chapter 10", excerpt: "x" }]),
        json("USAGE", { claudeCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 0, ms: 12 }),
      ],
      "mention_count"
    );
    expect(o).toMatchObject({
      route: "mention_count",
      scopeReason: "named",
      scopeBooks: ["Columbus Day"],
      claudeCalls: 0,
      ms: 12,
      text: "Skippy appears 766 times.\nSecond line.",
      textIsReal: true,
      sources: ["Columbus Day · Chapter 10"],
      error: null,
    });
  });

  it("joins streamed tokens and marks a dry-run answer as not real", () => {
    const o = observeChat(
      [line("TOKEN", "Hello "), line("TOKEN", DRY_RUN_TEXT), json("USAGE", { claudeCalls: 2, ms: 1 })],
      "open_rag"
    );
    expect(o.text).toBe(`Hello ${DRY_RUN_TEXT}`);
    expect(o.textIsReal).toBe(false);
    expect(o.claudeCalls).toBe(2);
  });

  it("keeps an error line", () => {
    expect(observeChat([line("ERROR", "Failed to generate response.")], null).error).toMatch(/Failed/);
  });
});

describe("caseHistory", () => {
  it("is empty for a single-turn case and passes turns through", () => {
    expect(caseHistory({})).toEqual([]);
    expect(
      caseHistory({
        history: [
          { role: "user", content: "How many times is Skippy mentioned?" },
          { role: "assistant", content: "766 times.", sources: [] } as never,
        ],
      })
    ).toEqual([
      { role: "user", content: "How many times is Skippy mentioned?" },
      { role: "assistant", content: "766 times." },
    ]);
  });

  it.each([
    [{ history: "and Joe?" }],
    [{ history: [{ role: "system", content: "x" }] }],
    [{ history: [{ role: "user" }] }],
    [{ history: [{ role: "user", content: "  " }] }],
    [{ history: [null] }],
  ])("refuses a malformed history %j", (testCase) => {
    expect(() => caseHistory(testCase as never)).toThrow(/history/);
  });
});

describe("the cases file", () => {
  it("is well-formed: unique ids, a question, valid history and scope", () => {
    const cases = JSON.parse(readFileSync(join(process.cwd(), "eval", "chat-cases.json"), "utf-8")) as Array<
      Record<string, unknown>
    >;
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(typeof c.id, String(c.id)).toBe("string");
      expect(typeof c.question, String(c.id)).toBe("string");
      expect(c.expect, String(c.id)).toBeTypeOf("object");
      expect(() => caseHistory(c as never), String(c.id)).not.toThrow();
      expect([c.focus, c.series, c.books].filter(Boolean).length, String(c.id)).toBeLessThanOrEqual(1);
    }
    expect(cases.some((c) => Array.isArray(c.history))).toBe(true);
    expect(cases.some((c) => typeof c.series === "string")).toBe(true);
  });
});

describe("checkChatCase", () => {
  it("passes when everything matches", () => {
    const { failures, skipped } = checkChatCase(
      {
        route: "mention_count",
        routeNot: ["open_rag"],
        scopeReason: "named",
        scopeBooks: ["columbus day"],
        maxClaudeCalls: 0,
        textIncludes: ["766"],
        textExcludes: ["estimate of"],
        sourcesInclude: ["chapter 10"],
        minSources: 1,
      },
      base
    );
    expect(failures).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("reports each mismatch in words", () => {
    const { failures } = checkChatCase(
      {
        route: "who_is",
        routeNot: ["mention_count"],
        scopeReason: "focus",
        scopeBooks: ["Paradise"],
        scopeIncludes: ["SpecOps"],
        scopeExcludes: ["Columbus Day"],
        minClaudeCalls: 1,
        textIncludes: ["886"],
        sourcesInclude: ["Paradise"],
        minSources: 3,
      },
      base
    );
    expect(failures).toEqual([
      "route: expected who_is, got mention_count",
      "route: must not be mention_count",
      "scope reason: expected focus, got named",
      "scope: expected [Paradise], got [Columbus Day]",
      "scope: missing SpecOps",
      "scope: should not read Columbus Day",
      "Claude calls: expected at least 1, got 0",
      'text: missing "886"',
      'sources: none matches "Paradise"',
      "sources: expected at least 3, got 1",
    ]);
  });

  it("textIncludesAny: one spelling of each fact is enough", () => {
    const observed = { ...base, text: "Gunnery Sergeant Margaret Adams, later Joe's wife." };
    expect(checkChatCase({ textIncludesAny: [["Adams", "Margaret"], ["gunny", "gunnery sergeant"]] }, observed).failures).toEqual([]);
    expect(checkChatCase({ textIncludesAny: [["Adams"], ["Shauna", "Jarrett"]] }, observed).failures).toEqual([
      'text: missing any of "Shauna" / "Jarrett"',
    ]);
    // Counted as a text check: skipped, and said so, when the answer is a dry-run placeholder.
    const dry = checkChatCase({ textIncludesAny: [["Adams"]], textIncludes: ["Joe"] }, { ...base, text: DRY_RUN_TEXT, textIsReal: false });
    expect(dry.failures).toEqual([]);
    expect(dry.skipped).toEqual(["2 text checks (generated answer; run live)"]);
  });

  it("checks whether the router model was consulted", () => {
    expect(checkChatCase({ routerAsked: true }, base).failures).toEqual(["router model: expected to be asked"]);
    expect(checkChatCase({ routerAsked: false }, { ...base, routerAsked: true }).failures).toEqual([
      "router model: expected not to be asked",
    ]);
    expect(checkChatCase({ routerAsked: true }, { ...base, routerAsked: true }).failures).toEqual([]);
  });

  it("a route the router model picks waits for a live run, with what follows from it", () => {
    const expectation = {
      routerAsked: true,
      route: "mention_count",
      scopeReason: "named",
      scopeBooks: ["Columbus Day"],
      maxClaudeCalls: 1,
      textIncludes: ["766"],
      minSources: 1,
    };
    // Dry: the call was planned, the route is still open_rag, the librarians were planned.
    const dry = checkChatCase(expectation, {
      ...base,
      route: "open_rag",
      routerAsked: true,
      scopeReason: "semantic",
      scopeBooks: ["Paradise", "SpecOps", "Zero Hour"],
      claudeCalls: 5,
      text: DRY_RUN_TEXT,
      textIsReal: false,
      sources: [],
    });
    expect(dry.failures).toEqual([]);
    expect(dry.skipped).toEqual([
      "route mention_count (the router model decides; run live)",
      "scope, Claude calls, sources (follow from the route; run live)",
      "1 text check (generated answer; run live)",
    ]);
    // Live: everything applies.
    expect(checkChatCase(expectation, { ...base, routerAsked: true, claudeCalls: 1 }).failures).toEqual([]);
    expect(checkChatCase(expectation, { ...base, route: "open_rag", routerAsked: true, claudeCalls: 5 }).failures).toEqual([
      "route: expected mention_count, got open_rag",
      "Claude calls: expected at most 1, got 5",
    ]);
    // A dry run that never planned the router call is a failure, not a skip.
    expect(
      checkChatCase(expectation, { ...base, route: "open_rag", text: DRY_RUN_TEXT, textIsReal: false }).failures
    ).toContain("route: expected mention_count, got open_rag");
  });

  it("a truncated scope list is not an exact match", () => {
    const { failures } = checkChatCase({ scopeBooks: ["Columbus Day"] }, { ...base, scopeMore: 4 });
    expect(failures).toEqual(["scope: expected [Columbus Day], got [Columbus Day] +4"]);
  });

  it("skips text checks on a generated answer in a dry run, and says so", () => {
    const { failures, skipped } = checkChatCase(
      { textIncludes: ["Ruhar"], textExcludes: ["don't have"], maxClaudeCalls: 3 },
      { ...base, claudeCalls: 2, text: DRY_RUN_TEXT, textIsReal: false }
    );
    expect(failures).toEqual([]);
    expect(skipped).toEqual(["2 text checks (generated answer; run live)"]);
  });

  it("an error always fails the case", () => {
    expect(checkChatCase({}, { ...base, error: "boom" }).failures).toEqual(["error: boom"]);
  });
});
