/** AI/answer settings (settings.json). */
import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "@/lib/runtime-config";
import { SETTINGS_FILE, ensureStoreDirs } from "./paths";

export interface AISettings {
  language: string;
  tone: string;
  customInstructions: string;
  focusAreas: string[];
  groundedMode?: boolean;
  answerMode?: "Quick" | "Evidence-heavy" | "Exact count" | "Compare books";
  useConversationMemory?: boolean;
  countMode?: "whole_word" | "phrase" | "loose";
  /** When true (default): friend voice, welcome, presence copy. When false: raw answers only. */
  companionMode?: boolean;
  modelRouting?: {
    specialistModelId?: string;
    orchestratorModelId?: string;
    extractionModelId?: string;
  };
}

const DEFAULT_SETTINGS: AISettings = {
  language: "Auto",
  tone: "Casual",
  customInstructions: "",
  focusAreas: [],
  groundedMode: false,
  answerMode: "Evidence-heavy",
  useConversationMemory: true,
  countMode: "whole_word",
  companionMode: true,
  modelRouting: {},
};

const ANSWER_MODES = ["Quick", "Evidence-heavy", "Exact count", "Compare books"] as const;
const COUNT_MODES = ["whole_word", "phrase", "loose"] as const;

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  allowed.find((v) => v === value);
const modelId = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Settings from anything (the file on disk, a request body): unknown values fall back
 * to the defaults. The one place that knows what a valid setting is.
 */
export function normalizeSettings(input: unknown): AISettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const routing = (raw.modelRouting && typeof raw.modelRouting === "object" ? raw.modelRouting : {}) as Record<
    string,
    unknown
  >;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
    language: String(raw.language || DEFAULT_SETTINGS.language),
    tone: String(raw.tone || DEFAULT_SETTINGS.tone),
    customInstructions: String(raw.customInstructions || ""),
    focusAreas: Array.isArray(raw.focusAreas) ? raw.focusAreas.map(String) : [],
    groundedMode: Boolean(raw.groundedMode),
    answerMode: oneOf(ANSWER_MODES, raw.answerMode) ?? DEFAULT_SETTINGS.answerMode,
    useConversationMemory: flag(raw.useConversationMemory, true),
    countMode: oneOf(COUNT_MODES, raw.countMode) ?? DEFAULT_SETTINGS.countMode,
    companionMode: flag(raw.companionMode, true),
    modelRouting: {
      specialistModelId: modelId(routing.specialistModelId),
      orchestratorModelId: modelId(routing.orchestratorModelId),
      extractionModelId: modelId(routing.extractionModelId),
    },
  };
}

export function loadSettings(): AISettings {
  ensureStoreDirs();
  if (!existsSync(SETTINGS_FILE)) return normalizeSettings(null);
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")));
  } catch {
    return normalizeSettings(null);
  }
}

/** Saves what `normalizeSettings` makes of the input and returns it. */
export function saveSettings(settings: unknown): AISettings {
  ensureStoreDirs();
  const normalized = normalizeSettings(settings);
  writeJsonAtomic(SETTINGS_FILE, normalized);
  return normalized;
}
