/**
 * Which Claude model the librarians (specialists) run on. Pure: no Bedrock, no disk.
 *
 * "Auto" tries cheaper models of the same region family as the main model, remembers
 * which ones this AWS account may invoke, and ends at the main model. The runtime side
 * (state file, the actual calls) is `chat/specialist-model.ts`.
 */
import { isAbortError, isAwsAuthExpiredMessage, isNetworkErrorMessage } from "@/lib/bedrock-errors";

/** Cheaper models tried for the librarians, in order, without a region prefix. */
const CHEAP_SPECIALIST_MODELS = [
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
] as const;

/** An unusable model is tried again after this long (access may have been granted). */
export const REPROBE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const REGION_PREFIX_RE = /^(eu|us|apac|global)\./i;

/** The model id inside an inference-profile ARN, or the id itself. */
function bareModelId(modelId: string): string {
  const id = modelId.trim();
  return id.startsWith("arn:") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/** `eu.`, `us.`, `apac.`, `global.` or "" — the inference-profile family of a model id. */
export function regionPrefix(modelId: string): string {
  const m = bareModelId(modelId).match(REGION_PREFIX_RE);
  return m ? `${m[1].toLowerCase()}.` : "";
}

/**
 * Models to try before the main one. `override` is BEDROCK_SPECIALIST_MODEL_IDS (comma
 * separated, used as written); otherwise the cheap models with the main model's prefix.
 * The main model itself is never a candidate: it is always the last resort.
 */
export function specialistCandidates(mainModelId: string, override?: string | null): string[] {
  const fromEnv = (override || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const prefix = regionPrefix(mainModelId);
  const list = fromEnv.length ? fromEnv : CHEAP_SPECIALIST_MODELS.map((id) => `${prefix}${id}`);
  return [...new Set(list)].filter((id) => id !== mainModelId.trim());
}

export type ModelErrorKind =
  /** This account can't invoke this model (no access, unknown id, wrong profile). */
  | "model_unavailable"
  /** Busy right now: use another model for this call, remember nothing. */
  | "throttled"
  /** Login expired: says nothing about the model. */
  | "auth"
  /** Offline: says nothing about the model. */
  | "network"
  | "aborted"
  | "other";

const MODEL_UNAVAILABLE_MESSAGE =
  /model identifier is invalid|don['’]t have access to the model|do not have access to the model|not authorized to (?:perform|invoke)[^.]*bedrock|access to (?:this )?model|on-demand throughput isn['’]t supported|end of its life|legacy model/i;
const VALIDATION_ABOUT_MODEL = /model identifier|model id\b|modelid|inference profile|provided model|on-demand throughput/i;

export function classifyModelError(error: unknown): ModelErrorKind {
  if (isAbortError(error)) return "aborted";
  const err = (error && typeof error === "object" ? error : {}) as { name?: string; message?: string };
  const name = err.name || "";
  const message = err.message || (typeof error === "string" ? error : "");
  const text = `${name} ${message}`;

  if (isAwsAuthExpiredMessage(text)) return "auth";
  // By name before the network patterns: "ResourceNotFound" contains "ENOTFOUND" to a case-blind regex.
  if (/AccessDenied|ResourceNotFound/i.test(name) || /AccessDeniedException|ResourceNotFoundException/.test(message)) {
    return "model_unavailable";
  }
  if (isNetworkErrorMessage(message)) return "network";
  if (/Throttl|TooManyRequests|ServiceQuotaExceeded|rate exceeded/i.test(text)) return "throttled";
  if (MODEL_UNAVAILABLE_MESSAGE.test(message)) return "model_unavailable";
  if (/ValidationException/i.test(text) && VALIDATION_ABOUT_MODEL.test(message)) return "model_unavailable";
  return "other";
}

export interface ModelCheck {
  usable: boolean;
  /** ISO time of the call that showed it. */
  checkedAt: string;
  /** Why it is unusable (the start of Bedrock's message). */
  reason?: string;
}

/** What is remembered about each candidate model, by model id. */
export interface ModelRoutingState {
  models: Record<string, ModelCheck>;
}

export function emptyRoutingState(): ModelRoutingState {
  return { models: {} };
}

/** Read a stored state defensively (the file is hand-editable). */
export function parseRoutingState(raw: unknown): ModelRoutingState {
  const models: Record<string, ModelCheck> = {};
  const input = raw && typeof raw === "object" ? (raw as { models?: unknown }).models : null;
  if (input && typeof input === "object") {
    for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
      const row = value as Partial<ModelCheck> | null;
      if (!row || typeof row.usable !== "boolean" || typeof row.checkedAt !== "string") continue;
      if (Number.isNaN(Date.parse(row.checkedAt))) continue;
      models[id] = {
        usable: row.usable,
        checkedAt: row.checkedAt,
        ...(typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
      };
    }
  }
  return { models };
}

/** Known unusable, and checked recently enough to believe it. */
function isBlocked(state: ModelRoutingState, modelId: string, now: number): boolean {
  const check = state.models[modelId];
  if (!check || check.usable) return false;
  return now - Date.parse(check.checkedAt) < REPROBE_AFTER_MS;
}

/** The models one librarian call tries, in order; the main model is always last. */
export function attemptOrder(
  candidates: string[],
  mainModelId: string,
  state: ModelRoutingState,
  now: number
): string[] {
  return [...candidates.filter((id) => !isBlocked(state, id, now)), mainModelId];
}

/** The model the next librarian call starts with. */
export function currentSpecialistModel(
  candidates: string[],
  mainModelId: string,
  state: ModelRoutingState,
  now: number
): string {
  return attemptOrder(candidates, mainModelId, state, now)[0];
}

/**
 * The state after a call on `modelId` answered (`ok`) or failed with `kind`. Only a
 * model-specific refusal marks a model unusable; throttling, an expired login, a network
 * error or a cancelled request leave what is known untouched. Returns the same object
 * when nothing changes, so callers can skip the write.
 */
export function recordModelOutcome(
  state: ModelRoutingState,
  modelId: string,
  outcome: "ok" | ModelErrorKind,
  now: number,
  reason?: string
): ModelRoutingState {
  const previous = state.models[modelId];
  if (outcome === "ok") {
    if (previous?.usable) return state;
    return { models: { ...state.models, [modelId]: { usable: true, checkedAt: new Date(now).toISOString() } } };
  }
  if (outcome !== "model_unavailable") return state;
  const short = (reason || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    models: {
      ...state.models,
      [modelId]: { usable: false, checkedAt: new Date(now).toISOString(), ...(short ? { reason: short } : {}) },
    },
  };
}

export interface ModelRoutingStatus {
  specialist: {
    mode: "auto" | "fixed";
    /** The model the next librarian call starts with. */
    modelId: string;
    tried: Array<{ modelId: string; usable: boolean; checkedAt?: string; reason?: string }>;
  };
  mainModelId: string;
}

/** What Settings shows: the mode, the model in use and what was found out about the candidates. */
export function describeRouting(opts: {
  fixedModelId?: string | null;
  mainModelId: string;
  candidates: string[];
  state: ModelRoutingState;
  now: number;
}): ModelRoutingStatus {
  const fixed = opts.fixedModelId?.trim();
  if (fixed) return { specialist: { mode: "fixed", modelId: fixed, tried: [] }, mainModelId: opts.mainModelId };
  const tried = opts.candidates
    .filter((id) => opts.state.models[id])
    .map((id) => ({ modelId: id, ...opts.state.models[id] }));
  return {
    specialist: {
      mode: "auto",
      modelId: currentSpecialistModel(opts.candidates, opts.mainModelId, opts.state, opts.now),
      tried,
    },
    mainModelId: opts.mainModelId,
  };
}
