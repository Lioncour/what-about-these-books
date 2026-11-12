import { describe, expect, it } from "vitest";
import { compareWithBaseline, mergeBaseline, toBaseline } from "../scripts/eval-baseline.mjs";

const result = (id: string, over: Record<string, unknown> = {}, passed = true) => ({
  id,
  passed,
  observed: {
    route: "open_rag",
    scopeReason: "semantic",
    scopeBooks: ["A", "B", "C"],
    scopeMore: 0,
    claudeCalls: 4,
    inputTokens: 16000,
    outputTokens: 2500,
    ...over,
  },
});
const report = (mode: "dry" | "live", results: ReturnType<typeof result>[]) => ({ mode, results });

describe("eval baseline", () => {
  it("keeps what matters per case", () => {
    const b = toBaseline(report("dry", [result("a")]));
    expect(b).toEqual({
      mode: "dry",
      cases: { a: { passed: true, route: "open_rag", scopeReason: "semantic", books: 3, claudeCalls: 4, inputTokens: 16000, outputTokens: 2500 } },
    });
  });

  it("says nothing changed when nothing did", () => {
    const base = toBaseline(report("dry", [result("a"), result("b")]));
    const diff = compareWithBaseline(report("dry", [result("a"), result("b")]), base);
    expect(diff.lines).toEqual(["Same as the baseline (2 cases)."]);
    expect(diff.worse).toBe(0);
  });

  it("flags a pass that now fails and more calls as worse, fewer calls as better", () => {
    const base = toBaseline(report("dry", [result("a"), result("b"), result("c")]));
    const diff = compareWithBaseline(
      report("dry", [result("a", {}, false), result("b", { claudeCalls: 7 }), result("c", { claudeCalls: 0, route: "books_mentioning", scopeReason: "all" })]),
      base
    );
    expect(diff.lines).toEqual([
      "  worse  a: passed before, FAILS now",
      "  worse  b: calls 4 → 7",
      "  better c: route open_rag → books_mentioning; scope semantic → all; calls 4 → 0",
      "Against the baseline (3 cases): -1 Claude calls; 2 worse, 1 better.",
    ]);
    expect(diff.worse).toBe(2);
    expect(diff.better).toBe(1);
  });

  it("reports token changes for live runs only when they are beyond the noise", () => {
    const base = toBaseline(report("live", [result("a"), result("b")]));
    const diff = compareWithBaseline(
      report("live", [result("a", { inputTokens: 16900 }), result("b", { inputTokens: 9000, outputTokens: 2000 })]),
      base
    );
    expect(diff.lines).toEqual([
      "  change b: tokens in 16.0k → 9.0k (-44%)",
      "Against the baseline (2 cases): 0 Claude calls, -6.1k tokens in, -500 out; 0 worse, 0 better.",
    ]);
  });

  it("notes new and missing cases, and ignores a baseline of the other mode", () => {
    const base = toBaseline(report("dry", [result("a"), result("old")]));
    const diff = compareWithBaseline(report("dry", [result("a"), result("fresh", { claudeCalls: 1 })]), base);
    expect(diff.lines[0]).toBe("  new   fresh: passes, 1 calls");
    expect(diff.lines[1]).toBe("  gone  old");
    expect(compareWithBaseline(report("live", [result("a")]), base).lines).toEqual([]);
    expect(compareWithBaseline(report("dry", [result("a")]), null).lines).toEqual([]);
  });

  it("merges a partial run into an existing baseline", () => {
    const base = toBaseline(report("dry", [result("a"), result("b")]));
    const merged = mergeBaseline(base, toBaseline(report("dry", [result("b", { claudeCalls: 1 })])));
    expect(Object.keys(merged.cases)).toEqual(["a", "b"]);
    expect(merged.cases.b.claudeCalls).toBe(1);
    expect(mergeBaseline(base, toBaseline(report("live", [result("z")]))).mode).toBe("live");
  });
});
