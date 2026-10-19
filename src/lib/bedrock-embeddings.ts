import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingsModel, EmbeddingsResponse } from "vectra";
import { sendBedrockCommand } from "@/lib/bedrock-client";
import { recordTokenUsage } from "@/lib/token-usage-store";

const BEDROCK_EMBED_MODEL_ID =
  process.env.BEDROCK_EMBED_MODEL_ID || "amazon.titan-embed-text-v2:0";

const EMBED_CONCURRENCY = 4;

function normalizeVector(vector: number[]): number[] {
  let sumSquares = 0;
  for (const n of vector) sumSquares += n * n;
  const norm = Math.sqrt(sumSquares) || 1;
  return vector.map((n) => n / norm);
}

async function embedOne(text: string): Promise<number[] | null> {
  const command = new InvokeModelCommand({
    modelId: BEDROCK_EMBED_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({ inputText: text }),
  });
  const response = await sendBedrockCommand(command);
  const raw = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(raw) as {
    embedding?: number[];
    inputTextTokenCount?: number;
  };
  if (!Array.isArray(parsed.embedding)) return null;
  if (typeof parsed.inputTextTokenCount === "number" && parsed.inputTextTokenCount > 0) {
    recordTokenUsage({
      kind: "embedding",
      modelId: BEDROCK_EMBED_MODEL_ID,
      inputTokens: parsed.inputTextTokenCount,
      outputTokens: 0,
    });
  }
  return normalizeVector(parsed.embedding);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export class BedrockEmbeddings implements EmbeddingsModel {
  readonly maxTokens = 8192;

  async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
    const inputArray = Array.isArray(inputs) ? inputs : [inputs];

    try {
      const vectors = await mapWithConcurrency(inputArray, EMBED_CONCURRENCY, async (text) =>
        embedOne(text)
      );
      if (vectors.some((v) => v === null)) {
        return {
          status: "error",
          message: "Bedrock embedding response missing embedding vector",
        };
      }
      return {
        status: "success",
        output: vectors as number[][],
      };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
