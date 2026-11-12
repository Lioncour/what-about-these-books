import { AsyncLocalStorage } from "node:async_hooks";

/** What one chat request spent on Bedrock (the USAGE stream line). */
export interface RequestUsage {
  claudeCalls: number;
  inputTokens: number;
  outputTokens: number;
  embedCalls: number;
}

interface RequestContext {
  /** Aborts every Bedrock call of the request, including embeddings made by Vectra. */
  signal?: AbortSignal;
  usage: RequestUsage;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function emptyUsage(): RequestUsage {
  return { claudeCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 0 };
}

/**
 * Run `fn` with a request-scoped usage collector and abort signal. Everything awaited
 * inside (Claude calls, Vectra → Titan embeddings) sees the same context without it
 * being passed along; code outside any request (ingest, reindex) sees none.
 */
export function runWithRequestContext<T>(
  context: { signal?: AbortSignal; usage?: RequestUsage },
  fn: () => T
): T {
  return storage.run({ signal: context.signal, usage: context.usage ?? emptyUsage() }, fn);
}

/** The current request's abort signal, if this code runs inside a chat request. */
export function currentRequestSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/** Add one Claude call to the current request (no-op outside a request). */
export function recordRequestClaudeCall(inputTokens: number, outputTokens: number): void {
  const usage = storage.getStore()?.usage;
  if (!usage) return;
  usage.claudeCalls += 1;
  usage.inputTokens += Math.max(0, Math.floor(inputTokens || 0));
  usage.outputTokens += Math.max(0, Math.floor(outputTokens || 0));
}

/** Add one Titan embedding call to the current request (no-op outside a request). */
export function recordRequestEmbedCall(): void {
  const usage = storage.getStore()?.usage;
  if (usage) usage.embedCalls += 1;
}
