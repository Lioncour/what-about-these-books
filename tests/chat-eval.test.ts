import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/book-store", () => ({ listBooks: () => [], listSeries: () => [] }));
vi.mock("@/lib/chat/display-title", () => ({ cleanBookDisplayTitle: (t: string) => t }));
vi.mock("@/lib/chat/handler", () => ({ runChatInProcess: vi.fn() }));

import { checkChatCase, observeChat, type ChatEvalObserved } from "@/lib/chat-eval";
import { DRY_RUN_TEXT } from "@/lib/chat/request-context";
import { encodeStreamField } from "@/lib/chat/stream-protocol";

const line = (type: string, data: string) => encodeStreamField(type, data).trimEnd();
const json = (type: string, value: unknown) => line(type, JSON.stringify(value));

const base: ChatEvalObserved = {
  route: "mention_count",
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
