/**
 * The librarians' model at runtime: pick it, call it, fall back, remember. The rules
 * are in `model-routing.ts`; this file only adds Bedrock and the state file.
 */
import { callClaudeText, type ClaudeCallOptions } from "@/lib/bedrock-claude";
import { DEFAULT_BEDROCK_MODEL_ID } from "@/lib/bedrock-client";
import { logChatEvent } from "@/lib/chat-debug";
import { isDryRun } from "@/lib/chat/request-context";
import {
  attemptOrder,
  classifyModelError,
  currentSpecialistModel,
  describeRouting,
  recordModelOutcome,
  specialistCandidates,
  type ModelRoutingStatus,
} from "@/lib/model-routing";
import { clearModelRoutingState, loadModelRoutingState, saveModelRoutingState } from "@/lib/model-routing-store";

const candidates = () => specialistCandidates(DEFAULT_BEDROCK_MODEL_ID, process.env.BEDROCK_SPECIALIST_MODEL_IDS);

/** The model the next librarian call starts with. Reads only; never probes. */
export function resolveSpecialistModel(fixedModelId?: string | null): string {
  const fixed = fixedModelId?.trim();
  if (fixed) return fixed;
  return currentSpecialistModel(candidates(), DEFAULT_BEDROCK_MODEL_ID, loadModelRoutingState(), Date.now());
}

export function getModelRoutingStatus(fixedModelId?: string | null): ModelRoutingStatus {
  return describeRouting({
    fixedModelId,
    mainModelId: DEFAULT_BEDROCK_MODEL_ID,
    candidates: candidates(),
    state: loadModelRoutingState(),
    now: Date.now(),
  });
}

export function recheckSpecialistModels(): void {
  clearModelRoutingState();
  logChatEvent("specialist_models_recheck", {});
}

/**
 * One librarian call. With a fixed model (Settings) it is used as is. In auto mode the
 * cheaper candidates are tried in order and the main model last: a model this account
 * can't invoke is remembered as unusable, a throttled or otherwise failing cheap model
 * is skipped for this call only, and an expired login, a network error or a cancelled
 * request is thrown as is without touching what is remembered.
 */
export async function callSpecialistClaude(
  prompt: string,
  maxTokens: number,
  temperature: number,
  opts: ClaudeCallOptions & { fixedModelId?: string | null }
): Promise<{ text: string; modelId: string }> {
  const { fixedModelId, ...callOpts } = opts;
  const fixed = fixedModelId?.trim();
  // A dry run plans the call on the model it would start with; nothing is probed or saved.
  if (fixed || isDryRun()) {
    const modelId = fixed || resolveSpecialistModel();
    return { text: await callClaudeText(prompt, maxTokens, temperature, modelId, callOpts), modelId };
  }

  const order = attemptOrder(candidates(), DEFAULT_BEDROCK_MODEL_ID, loadModelRoutingState(), Date.now());
  for (let i = 0; i < order.length; i++) {
    const modelId = order[i];
    const isMain = i === order.length - 1;
    try {
      const text = await callClaudeText(prompt, maxTokens, temperature, modelId, callOpts);
      if (!isMain) remember(modelId, "ok");
      logChatEvent("specialist_model_used", { modelId, mode: "auto", fallbacks: i });
      return { text, modelId };
    } catch (error) {
      const kind = classifyModelError(error);
      if (isMain || kind === "aborted" || kind === "auth" || kind === "network") throw error;
      const message = error instanceof Error ? error.message : String(error);
      remember(modelId, kind, message);
      logChatEvent("specialist_model_fallback", {
        modelId,
        kind,
        next: order[i + 1],
        remembered: kind === "model_unavailable",
        error: message.slice(0, 300),
      });
    }
  }
  // Unreachable: the main model either answers or throws.
  throw new Error("No model available for the librarians");
}

function remember(modelId: string, outcome: Parameters<typeof recordModelOutcome>[2], reason?: string): void {
  const state = loadModelRoutingState();
  const next = recordModelOutcome(state, modelId, outcome, Date.now(), reason);
  if (next !== state) saveModelRoutingState(next);
}
