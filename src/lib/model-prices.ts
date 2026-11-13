/**
 * Approximate list prices, US dollars per million tokens, used to turn token counts
 * into a rough cost. Tokens alone mislead once calls are split over models: a Haiku
 * token costs a fifth of an Opus token.
 *
 * These are on-demand list prices as known in November 2026 and are NOT read from your
 * AWS bill: regional inference profiles, discounts and price changes are not reflected.
 * Override or extend with the env var MODEL_PRICES_JSON, e.g.
 *   {"claude-haiku-4-5": [1, 5], "my-model": [0.5, 2]}
 * (substring of the model id → [input, output] per million tokens).
 */

type Price = { input: number; output: number };

/** First match wins, so more specific ids come first. */
const DEFAULT_PRICES: Array<[RegExp, Price]> = [
  [/claude-opus-4-[5-9]/, { input: 5, output: 25 }],
  [/claude-opus-4/, { input: 15, output: 75 }],
  [/claude-sonnet-4/, { input: 3, output: 15 }],
  [/claude-haiku-4-5/, { input: 1, output: 5 }],
  [/claude-3-5-haiku/, { input: 0.8, output: 4 }],
  [/claude-3-haiku/, { input: 0.25, output: 1.25 }],
  [/titan-embed-text-v2/, { input: 0.02, output: 0 }],
];

function overrides(): Array<[string, Price]> {
  const raw = process.env.MODEL_PRICES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed)
      .filter(
        (entry): entry is [string, [number, number]] =>
          Array.isArray(entry[1]) && entry[1].length === 2 && entry[1].every((n) => typeof n === "number" && n >= 0)
      )
      .map(([key, [input, output]]) => [key, { input, output }]);
  } catch {
    return [];
  }
}

/** Price per million tokens for a model id, or null when the model isn't in the table. */
export function priceFor(modelId: string): Price | null {
  const id = modelId.toLowerCase();
  for (const [key, price] of overrides()) {
    if (id.includes(key.toLowerCase())) return price;
  }
  for (const [pattern, price] of DEFAULT_PRICES) {
    if (pattern.test(id)) return price;
  }
  return null;
}

/** Rough cost in US dollars, or null when the model has no known price. */
export function costUsd(modelId: string, inputTokens: number, outputTokens: number): number | null {
  const price = priceFor(modelId);
  if (!price) return null;
  return (Math.max(0, inputTokens) * price.input + Math.max(0, outputTokens) * price.output) / 1_000_000;
}
