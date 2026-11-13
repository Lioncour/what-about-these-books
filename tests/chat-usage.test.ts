import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the fake Bedrock client was asked to do. */
const bedrock = vi.hoisted(() => ({
  sends: [] as Array<{ body: Record<string, unknown>; signal?: AbortSignal }>,
  /** When set, sends hang until their signal aborts (then reject like the SDK does). */
  hang: false,
}));

vi.mock("@/lib/chat-debug", () => ({ logChatEvent: vi.fn() }));
vi.mock("@/lib/token-usage-store", () => ({ recordTokenUsage: vi.fn() }));

vi.mock("@/lib/bedrock-client", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const isAbortError = (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const err = error as { name?: string; message?: string };
    return err.name === "AbortError" || /\baborted\b/i.test(err.message || "");
  };
  const respond = (command: { input: { body: string } }, signal?: AbortSignal) => {
    const body = JSON.parse(command.input.body) as Record<string, unknown>;
    bedrock.sends.push({ body, signal });
    if (bedrock.hang) {
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if ("inputText" in body) {
      return Promise.resolve({ body: encode({ embedding: [3, 4], inputTextTokenCount: 7 }) });
    }
    return Promise.resolve({
      body: encode({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 120, output_tokens: 30 } }),
    });
  };
  const streamEvents = [
    { type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "there" } },
    { type: "message_delta", usage: { output_tokens: 40 } },
  ];
  return {
    DEFAULT_BEDROCK_MODEL_ID: "test-model",
    isAbortError,
    sendBedrockCommand: vi.fn(async (command: { input: { body: string } }, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return respond(command, signal);
    }),
    withBedrockAuthRetry: async <T,>(operation: () => Promise<T>) => operation(),
    bedrockClient: {
      send: vi.fn(async (command: { input: { body: string } }, opts?: { abortSignal?: AbortSignal }) => {
        bedrock.sends.push({ body: JSON.parse(command.input.body), signal: opts?.abortSignal });
        return {
          body: (async function* () {
            for (const event of streamEvents) yield { chunk: { bytes: encode(event) } };
          })(),
        };
      }),
    },
  };
});

import { callClaudeStream, callClaudeText } from "@/lib/bedrock-claude";
import { BedrockEmbeddings } from "@/lib/bedrock-embeddings";
import { recordTokenUsage } from "@/lib/token-usage-store";
import { currentRequestSignal, emptyUsage, runWithRequestContext } from "@/lib/chat/request-context";

beforeEach(() => {
  vi.clearAllMocks();
  bedrock.sends.length = 0;
  bedrock.hang = false;
});

describe("per-request usage accounting", () => {
  it("collects Claude and embedding calls made inside the request", async () => {
    const usage = emptyUsage();
    await runWithRequestContext({ usage }, async () => {
      await callClaudeText("one");
      const tokens: string[] = [];
      const streamed = await callClaudeStream("two", (t) => tokens.push(t));
      expect(streamed).toBe("Hello there");
      expect(tokens).toEqual(["Hello ", "there"]);
      const embedded = await new BedrockEmbeddings().createEmbeddings(["a", "b", "c"]);
      expect(embedded.status).toBe("success");
      // Vectors come back normalised.
      expect(embedded.output?.[0]).toEqual([0.6, 0.8]);
    });
    expect(usage).toMatchObject({ claudeCalls: 2, inputTokens: 320, outputTokens: 70, embedCalls: 3 });
    // A rough cost rides along: a number for a model in the price table, null otherwise.
    expect(usage.costUsd === null || usage.costUsd > 0).toBe(true);
    // The global store still records every call.
    expect(recordTokenUsage).toHaveBeenCalledTimes(5);
  });

  it("keeps two overlapping requests apart", async () => {
    const first = emptyUsage();
    const second = emptyUsage();
    await Promise.all([
      runWithRequestContext({ usage: first }, async () => {
        await callClaudeText("a");
        await callClaudeText("b");
      }),
      runWithRequestContext({ usage: second }, async () => {
        await new BedrockEmbeddings().createEmbeddings("q");
        await callClaudeText("c");
      }),
    ]);
    expect(first).toMatchObject({ claudeCalls: 2, embedCalls: 0 });
    expect(second).toMatchObject({ claudeCalls: 1, embedCalls: 1 });
  });

  it("does nothing outside a request (ingest, reindex)", async () => {
    expect(currentRequestSignal()).toBeUndefined();
    await callClaudeText("outside");
    const embedded = await new BedrockEmbeddings().createEmbeddings("outside");
    expect(embedded.status).toBe("success");
    expect(bedrock.sends.every((s) => s.signal === undefined)).toBe(true);
    expect(recordTokenUsage).toHaveBeenCalledTimes(2);
  });
});

describe("abort for embeddings", () => {
  it("passes the request's signal to Titan although Vectra gives none", async () => {
    const controller = new AbortController();
    await runWithRequestContext({ signal: controller.signal }, () => new BedrockEmbeddings().createEmbeddings(["a", "b"]));
    expect(bedrock.sends).toHaveLength(2);
    expect(bedrock.sends.every((s) => s.signal === controller.signal)).toBe(true);
  });

  it("rejects with an abort error when the request is cancelled mid-embedding", async () => {
    bedrock.hang = true;
    const controller = new AbortController();
    const usage = emptyUsage();
    const pending = runWithRequestContext({ signal: controller.signal, usage }, () =>
      new BedrockEmbeddings().createEmbeddings(["a", "b"])
    );
    await vi.waitFor(() => expect(bedrock.sends).toHaveLength(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(usage.embedCalls).toBe(0);
  });

  it("does not start embedding for a request that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWithRequestContext({ signal: controller.signal }, () => new BedrockEmbeddings().createEmbeddings("a"))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bedrock.sends).toHaveLength(0);
  });

  it("still reports other failures as an error status, as Vectra expects", async () => {
    const { sendBedrockCommand } = await import("@/lib/bedrock-client");
    vi.mocked(sendBedrockCommand).mockRejectedValueOnce(new Error("ThrottlingException"));
    const result = await new BedrockEmbeddings().createEmbeddings("a");
    expect(result).toEqual({ status: "error", message: "ThrottlingException" });
  });
});
