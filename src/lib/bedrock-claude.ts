import {
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DEFAULT_BEDROCK_MODEL_ID,
  sendBedrockCommand,
  withBedrockAuthRetry,
  bedrockClient,
} from "@/lib/bedrock-client";
import { logChatEvent } from "@/lib/chat-debug";
import { recordTokenUsage } from "@/lib/token-usage-store";

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

type AnthropicStreamEvent = {
  type?: string;
  delta?: { type?: string; text?: string };
  content_block?: { type?: string; text?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
};

export async function callClaudeText(
  prompt: string,
  maxTokens = 2500,
  temperature = 0.2,
  modelId?: string
): Promise<string> {
  const started = Date.now();
  const resolvedModel = modelId || DEFAULT_BEDROCK_MODEL_ID;
  const command = new InvokeModelCommand({
    modelId: resolvedModel,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
    }),
  });
  const response = await sendBedrockCommand(command);
  const raw = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(raw) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: AnthropicUsage;
  };
  const text = parsed.content?.find((c) => c.type === "text")?.text || "";
  const inputTokens = parsed.usage?.input_tokens || 0;
  const outputTokens = parsed.usage?.output_tokens || 0;
  recordTokenUsage({
    kind: "claude",
    modelId: resolvedModel,
    inputTokens,
    outputTokens,
    streamed: false,
  });
  logChatEvent("bedrock_call_completed", {
    modelId: resolvedModel,
    maxTokens,
    latencyMs: Date.now() - started,
    outputChars: text.length,
    inputTokens,
    outputTokens,
    streamed: false,
  });
  return text;
}

/** Stream Claude tokens via Bedrock; calls onToken for each text delta; returns full text. */
export async function callClaudeStream(
  prompt: string,
  onToken: (delta: string) => void,
  maxTokens = 2500,
  temperature = 0.2,
  modelId?: string
): Promise<string> {
  const started = Date.now();
  const resolvedModel = modelId || DEFAULT_BEDROCK_MODEL_ID;
  const command = new InvokeModelWithResponseStreamCommand({
    modelId: resolvedModel,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
    }),
  });

  let full = "";
  let inputTokens = 0;
  let outputTokens = 0;
  await withBedrockAuthRetry(async () => {
    const response = await bedrockClient.send(command);
    if (!response.body) return;

    for await (const event of response.body) {
      if (!event.chunk?.bytes) continue;
      const raw = new TextDecoder().decode(event.chunk.bytes);
      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(raw) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      if (parsed.type === "message_start" && parsed.message?.usage) {
        inputTokens = parsed.message.usage.input_tokens || inputTokens;
        outputTokens = parsed.message.usage.output_tokens || outputTokens;
      }
      if (parsed.type === "message_delta" && parsed.usage) {
        inputTokens = parsed.usage.input_tokens ?? inputTokens;
        outputTokens = parsed.usage.output_tokens ?? outputTokens;
      }

      const delta =
        parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta"
          ? parsed.delta.text || ""
          : "";
      if (!delta) continue;
      full += delta;
      onToken(delta);
    }
  });

  recordTokenUsage({
    kind: "claude",
    modelId: resolvedModel,
    inputTokens,
    outputTokens,
    streamed: true,
  });
  logChatEvent("bedrock_call_completed", {
    modelId: resolvedModel,
    maxTokens,
    latencyMs: Date.now() - started,
    outputChars: full.length,
    inputTokens,
    outputTokens,
    streamed: true,
  });
  return full;
}

export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
