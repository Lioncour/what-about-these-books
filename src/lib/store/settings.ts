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

export function loadSettings(): AISettings {
  ensureStoreDirs();
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Partial<AISettings>;
    return {
      language: parsed.language || DEFAULT_SETTINGS.language,
      tone: parsed.tone || DEFAULT_SETTINGS.tone,
      customInstructions: parsed.customInstructions || DEFAULT_SETTINGS.customInstructions,
      focusAreas: Array.isArray(parsed.focusAreas) ? parsed.focusAreas.map(String) : [],
      groundedMode: Boolean(parsed.groundedMode),
      answerMode:
        parsed.answerMode === "Quick" ||
        parsed.answerMode === "Evidence-heavy" ||
        parsed.answerMode === "Exact count" ||
        parsed.answerMode === "Compare books"
          ? parsed.answerMode
          : DEFAULT_SETTINGS.answerMode,
      useConversationMemory:
        typeof parsed.useConversationMemory === "boolean"
          ? parsed.useConversationMemory
          : DEFAULT_SETTINGS.useConversationMemory,
      countMode:
        parsed.countMode === "whole_word" || parsed.countMode === "phrase" || parsed.countMode === "loose"
          ? parsed.countMode
          : DEFAULT_SETTINGS.countMode,
      companionMode:
        typeof parsed.companionMode === "boolean"
          ? parsed.companionMode
          : DEFAULT_SETTINGS.companionMode,
      modelRouting:
        parsed.modelRouting && typeof parsed.modelRouting === "object"
          ? {
              specialistModelId: parsed.modelRouting.specialistModelId
                ? String(parsed.modelRouting.specialistModelId)
                : undefined,
              orchestratorModelId: parsed.modelRouting.orchestratorModelId
                ? String(parsed.modelRouting.orchestratorModelId)
                : undefined,
              extractionModelId: parsed.modelRouting.extractionModelId
                ? String(parsed.modelRouting.extractionModelId)
                : undefined,
            }
          : {},
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AISettings): void {
  ensureStoreDirs();
  const normalized: AISettings = {
    language: settings.language || DEFAULT_SETTINGS.language,
    tone: settings.tone || DEFAULT_SETTINGS.tone,
    customInstructions: settings.customInstructions || "",
    focusAreas: Array.isArray(settings.focusAreas) ? settings.focusAreas.map(String) : [],
    groundedMode: Boolean(settings.groundedMode),
    answerMode:
      settings.answerMode === "Quick" ||
      settings.answerMode === "Evidence-heavy" ||
      settings.answerMode === "Exact count" ||
      settings.answerMode === "Compare books"
        ? settings.answerMode
        : DEFAULT_SETTINGS.answerMode,
    useConversationMemory:
      typeof settings.useConversationMemory === "boolean"
        ? settings.useConversationMemory
        : DEFAULT_SETTINGS.useConversationMemory,
    countMode:
      settings.countMode === "whole_word" || settings.countMode === "phrase" || settings.countMode === "loose"
        ? settings.countMode
        : DEFAULT_SETTINGS.countMode,
    companionMode:
      typeof settings.companionMode === "boolean"
        ? settings.companionMode
        : DEFAULT_SETTINGS.companionMode,
    modelRouting: {
      specialistModelId: settings.modelRouting?.specialistModelId || undefined,
      orchestratorModelId: settings.modelRouting?.orchestratorModelId || undefined,
      extractionModelId: settings.modelRouting?.extractionModelId || undefined,
    },
  };
  writeJsonAtomic(SETTINGS_FILE, normalized);
}
