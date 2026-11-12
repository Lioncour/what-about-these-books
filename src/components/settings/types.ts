export interface AISettings {
  language: string;
  tone: string;
  customInstructions: string;
  focusAreas: string[];
  groundedMode?: boolean;
  answerMode?: "Quick" | "Evidence-heavy" | "Exact count" | "Compare books";
  useConversationMemory?: boolean;
  countMode?: "whole_word" | "phrase" | "loose";
  companionMode?: boolean;
  modelRouting?: {
    specialistModelId?: string;
    orchestratorModelId?: string;
    extractionModelId?: string;
  };
}

export const DEFAULT_SETTINGS: AISettings = {
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

export type UpdateSettings = (update: (prev: AISettings) => AISettings) => void;

export interface SectionProps {
  settings: AISettings;
  update: UpdateSettings;
}

/** `modelRoutingStatus` of GET /api/settings: which model the librarians run on right now. */
export interface ModelRoutingStatus {
  specialist: {
    mode: "auto" | "fixed";
    modelId: string;
    tried: Array<{ modelId: string; usable: boolean; checkedAt?: string; reason?: string }>;
  };
  mainModelId: string;
}
