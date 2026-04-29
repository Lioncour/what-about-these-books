import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingsModel, EmbeddingsResponse } from "vectra";

const AWS_REGION = process.env.AWS_REGION || "eu-central-1";
const BEDROCK_EMBED_MODEL_ID =
  process.env.BEDROCK_EMBED_MODEL_ID || "amazon.titan-embed-text-v2:0";

const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

function normalizeVector(vector: number[]): number[] {
  let sumSquares = 0;
  for (const n of vector) sumSquares += n * n;
  const norm = Math.sqrt(sumSquares) || 1;
  return vector.map((n) => n / norm);
}

export class BedrockEmbeddings implements EmbeddingsModel {
  readonly maxTokens = 8192;

  async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
    const inputArray = Array.isArray(inputs) ? inputs : [inputs];
    const output: number[][] = [];

    try {
      for (const text of inputArray) {
        const command = new InvokeModelCommand({
          modelId: BEDROCK_EMBED_MODEL_ID,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            inputText: text,
          }),
        });

        const response = await bedrockClient.send(command);
        const raw = new TextDecoder().decode(response.body);
        const parsed = JSON.parse(raw) as {
          embedding?: number[];
        };
        if (!Array.isArray(parsed.embedding)) {
          return {
            status: "error",
            message: "Bedrock embedding response missing embedding vector",
          };
        }
        output.push(normalizeVector(parsed.embedding));
      }

      return {
        status: "success",
        output,
      };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
