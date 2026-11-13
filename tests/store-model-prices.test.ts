import { afterEach, describe, expect, it } from "vitest";
import { costUsd, priceFor } from "@/lib/model-prices";
import { emptyUsage, recordRequestClaudeCall, runWithRequestContext } from "@/lib/chat/request-context";
import { formatCost, formatUsageLine, normalizeUsage } from "../src/components/chat/format";

afterEach(() => {
  delete process.env.MODEL_PRICES_JSON;
});

describe("model prices", () => {
  it("knows the models the app uses, whatever the region prefix", () => {
    expect(priceFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual({ input: 1, output: 5 });
    expect(priceFor("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({ input: 3, output: 15 });
    expect(priceFor("eu.anthropic.claude-opus-4-6-v1")).toEqual({ input: 5, output: 25 });
    expect(priceFor("amazon.titan-embed-text-v2:0")).toEqual({ input: 0.02, output: 0 });
    expect(priceFor("some.unknown-model")).toBeNull();
  });

  it("turns tokens into dollars", () => {
    // 15k Haiku tokens in, 1.5k out: 0.015 + 0.0075
    expect(costUsd("eu.anthropic.claude-haiku-4-5-20251001-v1:0", 15_000, 1_500)).toBeCloseTo(0.0225, 6);
    // the same on Opus is five times that
    expect(costUsd("eu.anthropic.claude-opus-4-6-v1", 15_000, 1_500)).toBeCloseTo(0.1125, 6);
    expect(costUsd("mystery", 1000, 1000)).toBeNull();
  });

  it("takes overrides from MODEL_PRICES_JSON and ignores a broken value", () => {
    process.env.MODEL_PRICES_JSON = JSON.stringify({ "claude-haiku-4-5": [2, 10], mystery: [0.5, 2], bad: "x" });
    expect(priceFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual({ input: 2, output: 10 });
    expect(priceFor("my.mystery.model")).toEqual({ input: 0.5, output: 2 });
    process.env.MODEL_PRICES_JSON = "{not json";
    expect(priceFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual({ input: 1, output: 5 });
  });
});

describe("cost per request", () => {
  it("adds up across models and gives up when one has no price", async () => {
    const usage = emptyUsage();
    await runWithRequestContext({ usage }, async () => {
      recordRequestClaudeCall(5_000, 500, "eu.anthropic.claude-haiku-4-5-20251001-v1:0");
      recordRequestClaudeCall(1_000, 500, "eu.anthropic.claude-opus-4-6-v1");
    });
    // 0.005 + 0.0025 + 0.005 + 0.0125
    expect(usage.costUsd).toBeCloseTo(0.025, 6);

    const unknown = emptyUsage();
    await runWithRequestContext({ usage: unknown }, async () => {
      recordRequestClaudeCall(5_000, 500, "eu.anthropic.claude-haiku-4-5-20251001-v1:0");
      recordRequestClaudeCall(1_000, 500, "mystery");
      recordRequestClaudeCall(1_000, 500, "eu.anthropic.claude-opus-4-6-v1");
    });
    expect(unknown.costUsd).toBeNull();
  });

  it("a planned call in a dry run costs nothing", async () => {
    const usage = emptyUsage();
    await runWithRequestContext({ usage, dryRun: true }, async () => {
      recordRequestClaudeCall(0, 0);
    });
    expect(usage).toMatchObject({ claudeCalls: 1, costUsd: 0 });
  });
});

describe("cost on the usage line", () => {
  it("formats small and larger amounts, always as approximate", () => {
    expect(formatCost(0.004)).toBe("< $0.01");
    expect(formatCost(0.0421)).toBe("≈ $0.04");
    expect(formatCost(1.2)).toBe("≈ $1.20");
    expect(formatCost(42.6)).toBe("≈ $43");
    expect(formatCost(0)).toBe("");
  });

  it("shows the cost between the tokens and the time, and nothing when unknown", () => {
    const base = { claudeCalls: 4, inputTokens: 16_800, outputTokens: 2_700, embedCalls: 1, ms: 23_700 };
    expect(formatUsageLine({ ...base, costUsd: 0.0421 })).toBe("4 calls · 16.8k tokens in · 2.7k out · ≈ $0.04 · 24 s");
    expect(formatUsageLine({ ...base, costUsd: null })).toBe("4 calls · 16.8k tokens in · 2.7k out · 24 s");
    expect(formatUsageLine(base)).toBe("4 calls · 16.8k tokens in · 2.7k out · 24 s");
  });

  it("keeps a valid cost from the stream and drops anything else", () => {
    expect(normalizeUsage({ claudeCalls: 1, ms: 5, costUsd: 0.03 })?.costUsd).toBe(0.03);
    expect(normalizeUsage({ claudeCalls: 1, ms: 5, costUsd: null })?.costUsd).toBeUndefined();
    expect(normalizeUsage({ claudeCalls: 1, ms: 5, costUsd: "1" })?.costUsd).toBeUndefined();
  });
});
