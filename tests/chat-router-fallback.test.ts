import { describe, expect, it, vi } from "vitest";
import {
  buildRouterPrompt,
  parseRouterAnswer,
  resolveRouteWithModel,
  routeChatQuestion,
  routerFallbackReason,
  type ChatRoute,
} from "@/lib/chat/router";

const OPEN: ChatRoute = { kind: "open_rag", reason: "Open question — specialists / RAG", usesTool: false };
const known = (name: string) => ["skippy", "joe", "nagatha"].includes(name.toLowerCase());
const rule = (question: string) => routeChatQuestion({ question, messages: [{ role: "user", content: question }] });

describe("routerFallbackReason", () => {
  it.each([
    ["What's the tally for Skippy across the library?", "count word"],
    ["How frequently is Nagatha brought up?", "count word"],
    ['Who said "Trust the awesomeness"?', "quote mark"],
    ["Which books is Hans Chotek in?", "which book"],
    ["Where did Joe grow up?", "where"],
    ["List the people on the ship", "list"],
    ["Does Joe survive?", "short question about a known name"],
    ["Nagatha?", "short question about a known name"],
  ])("finds %j ambiguous (%s)", (question, why) => {
    expect(routerFallbackReason(question, known)).toBe(why);
  });

  it.each([
    "What does Skippy think of humans?",
    "Why did the Kristang attack?",
    "What is the name of Joe's hometown?",
    "Does Margaret survive?",
    "",
  ])("leaves %j alone", (question) => {
    expect(routerFallbackReason(question, known)).toBeNull();
  });

  it("asks the name lookup only for short questions", () => {
    const lookup = vi.fn(() => true);
    routerFallbackReason("What does Skippy think of the people he travels with?", lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("the phrasings it is for are ones no rule claims", () => {
    for (const q of ["What's the tally for Skippy in Columbus Day?", "Which books is Nagatha in?"]) {
      expect(rule(q).kind).toBe("open_rag");
      expect(routerFallbackReason(q)).not.toBeNull();
    }
  });
});

describe("parseRouterAnswer", () => {
  const q = "What's the tally for Skippy in Columbus Day?";

  it("accepts one line of JSON with a known route and a target from the question", () => {
    expect(parseRouterAnswer('{"route": "mention_count", "target": "Skippy"}', q)).toEqual({
      route: "mention_count",
      target: "Skippy",
    });
    expect(parseRouterAnswer('```json\n{"route":"open_rag","target":""}\n```', q)).toEqual({ route: "open_rag", target: null });
    expect(parseRouterAnswer('{"route": "main_characters"}', "List the main people")).toEqual({
      route: "main_characters",
      target: null,
    });
  });

  it("takes a quote without its quote marks", () => {
    expect(parseRouterAnswer('{"route":"quote_lookup","target":"Trust the awesomeness"}', 'Who said “Trust the awesomeness”?')).toEqual({
      route: "quote_lookup",
      target: "Trust the awesomeness",
    });
  });

  it.each([
    ["prose around the JSON", 'Sure! {"route": "mention_count", "target": "Skippy"}'],
    ["an unknown route", '{"route": "library_count", "target": ""}'],
    ["a route the rules own", '{"route": "bypass_general"}'],
    ["a target that is not in the question", '{"route": "mention_count", "target": "Nagatha"}'],
    ["a missing target", '{"route": "who_is", "target": ""}'],
    ["a target of the wrong type", '{"route": "who_is", "target": 7}'],
    ["two lines", '{"route": "open_rag",\n"target": ""}'],
    ["an array", '[{"route": "open_rag"}]'],
    ["no JSON", "open_rag"],
    ["the dry-run placeholder", "[dry run: Claude call skipped]"],
    ["nothing", ""],
  ])("rejects %s", (_what, raw) => {
    expect(parseRouterAnswer(raw, q)).toBeNull();
  });
});

describe("resolveRouteWithModel", () => {
  const question = "What's the tally for Skippy in Columbus Day?";

  it("follows a valid answer and says it asked", async () => {
    const ask = vi.fn<(prompt: string, signal: AbortSignal) => Promise<string>>(
      async () => '{"route": "mention_count", "target": "Skippy"}'
    );
    const result = await resolveRouteWithModel({ route: OPEN, question, ask });
    expect(result.asked).toBe(true);
    expect(result.route).toMatchObject({ kind: "mention_count", target: "Skippy", usesTool: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe(buildRouterPrompt(question));
    expect(ask.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it("never asks for a question a rule already routed", async () => {
    const ask = vi.fn(async () => '{"route": "who_is", "target": "Skippy"}');
    const routed = rule("How many times is Skippy mentioned?");
    const result = await resolveRouteWithModel({ route: routed, question: "How many times is Skippy mentioned?", ask });
    expect(result).toMatchObject({ route: routed, asked: false, outcome: "rule_routed" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("never asks for an open question that isn't ambiguous", async () => {
    const ask = vi.fn(async () => "{}");
    const result = await resolveRouteWithModel({ route: OPEN, question: "Why did the Kristang attack?", ask });
    expect(result).toMatchObject({ route: OPEN, asked: false, outcome: "not_ambiguous" });
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid answer", async () => "I think mention_count"],
    ["an answer that says open_rag", async () => '{"route": "open_rag", "target": ""}'],
    [
      "an error",
      async () => {
        throw new Error("ThrottlingException");
      },
    ],
  ])("keeps open_rag on %s", async (_what, ask) => {
    const result = await resolveRouteWithModel({ route: OPEN, question, ask });
    expect(result.asked).toBe(true);
    expect(result.route).toBe(OPEN);
  });

  it("gives up after the timeout and keeps open_rag", async () => {
    const ask = (_prompt: string, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const started = Date.now();
    const result = await resolveRouteWithModel({ route: OPEN, question, ask, timeoutMs: 30 });
    expect(result).toMatchObject({ route: OPEN, asked: true });
    expect(result.outcome).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("passes the reader's Stop on instead of answering", async () => {
    const stop = new AbortController();
    const ask = (_prompt: string, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        stop.abort();
      });
    await expect(resolveRouteWithModel({ route: OPEN, question, ask, signal: stop.signal })).rejects.toThrow();
  });

  it("plans the call in a dry run without reading the answer", async () => {
    const ask = vi.fn(async () => '{"route": "mention_count", "target": "Skippy"}');
    const result = await resolveRouteWithModel({ route: OPEN, question, ask, dryRun: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ route: OPEN, asked: true });
    expect(result.outcome).toContain("dry run");
  });
});
