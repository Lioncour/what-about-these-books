import { AsyncLocalStorage } from "node:async_hooks";
import { costUsd } from "@/lib/model-prices";

/** What one chat request spent on Bedrock (the USAGE stream line). */
export interface RequestUsage {
  claudeCalls: number;
  inputTokens: number;
  outputTokens: number;
  embedCalls: number;
  /**
   * Rough cost of the Claude calls in US dollars at list prices (see model-prices.ts);
   * null when a call used a model without a known price.
   */
  costUsd: number | null;
}

interface RequestContext {
  /** Aborts every Bedrock call of the request, including embeddings made by Vectra. */
  signal?: AbortSignal;
  usage: RequestUsage;
  /** Eval dry run: Claude calls are counted but not made. */
  dryRun?: boolean;
  /** Eval run: answer from the books now, never from the specialist cache. */
  fresh?: boolean;
}

/** What a skipped Claude call returns in a dry run. */
export const DRY_RUN_TEXT = "[dry run: Claude call skipped]";

const storage = new AsyncLocalStorage<RequestContext>();

export function emptyUsage(): RequestUsage {
  return { claudeCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 0, costUsd: 0 };
}

/**
 * Run `fn` with a request-scoped usage collector and abort signal. Everything awaited
 * inside (Claude calls, Vectra → Titan embeddings) sees the same context without it
 * being passed along; code outside any request (ingest, reindex) sees none.
 */
export function runWithRequestContext<T>(
  context: { signal?: AbortSignal; usage?: RequestUsage; dryRun?: boolean; fresh?: boolean },
  fn: () => T
): T {
  return storage.run(
    {
      signal: context.signal,
      usage: context.usage ?? emptyUsage(),
      dryRun: context.dryRun,
      fresh: context.fresh || context.dryRun,
    },
    fn
  );
}

/**
 * True when cached librarian answers must not be used: every eval run, dry or live.
 * An eval measures what a question costs and says today; an answer cached last week
 * would hide both.
 */
export function skipSpecialistCache(): boolean {
  return storage.getStore()?.fresh === true;
}

/** True inside an eval dry run: plan the Claude calls, don't spend them. */
export function isDryRun(): boolean {
  return storage.getStore()?.dryRun === true;
}

/** The current request's abort signal, if this code runs inside a chat request. */
export function currentRequestSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/** Add one Claude call to the current request (no-op outside a request). */
export function recordRequestClaudeCall(inputTokens: number, outputTokens: number, modelId?: string): void {
  const usage = storage.getStore()?.usage;
  if (!usage) return;
  usage.claudeCalls += 1;
  usage.inputTokens += Math.max(0, Math.floor(inputTokens || 0));
  usage.outputTokens += Math.max(0, Math.floor(outputTokens || 0));
  // A planned (dry-run) call has no tokens and no model: it costs nothing.
  if (!inputTokens && !outputTokens) return;
  const cost = modelId ? costUsd(modelId, inputTokens, outputTokens) : null;
  usage.costUsd = cost === null || usage.costUsd === null ? null : usage.costUsd + cost;
}

/** Add one Titan embedding call to the current request (no-op outside a request). */
export function recordRequestEmbedCall(): void {
  const usage = storage.getStore()?.usage;
  if (usage) usage.embedCalls += 1;
}
