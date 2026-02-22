import { Ollama } from "ollama";
import type { EmbeddingsModel, EmbeddingsResponse } from "vectra";

const ollama = new Ollama({ host: "http://127.0.0.1:11434" });

export class OllamaEmbeddings implements EmbeddingsModel {
  readonly maxTokens = 8192;

  async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
    try {
      const inputArray = Array.isArray(inputs) ? inputs : [inputs];
      const response = await ollama.embed({
        model: "nomic-embed-text",
        input: inputArray,
      });

      return {
        status: "success",
        output: response.embeddings,
      };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
