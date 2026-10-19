import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings, type AISettings } from "@/lib/book-store";

export async function GET() {
  return NextResponse.json(loadSettings());
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const answerMode: AISettings["answerMode"] =
      body?.answerMode === "Quick" ||
      body?.answerMode === "Evidence-heavy" ||
      body?.answerMode === "Exact count" ||
      body?.answerMode === "Compare books"
        ? body.answerMode
        : "Evidence-heavy";
    const countMode: AISettings["countMode"] =
      body?.countMode === "whole_word" || body?.countMode === "phrase" || body?.countMode === "loose"
        ? body.countMode
        : "whole_word";

    saveSettings({
      language: String(body?.language || "Auto"),
      tone: String(body?.tone || "Casual"),
      customInstructions: String(body?.customInstructions || ""),
      focusAreas: Array.isArray(body?.focusAreas)
        ? body.focusAreas.map((v: unknown) => String(v))
        : [],
      groundedMode: Boolean(body?.groundedMode),
      answerMode,
      useConversationMemory: body?.useConversationMemory !== false,
      countMode,
      companionMode: body?.companionMode !== false,
      modelRouting:
        body?.modelRouting && typeof body.modelRouting === "object"
          ? {
              specialistModelId: body.modelRouting.specialistModelId
                ? String(body.modelRouting.specialistModelId)
                : undefined,
              orchestratorModelId: body.modelRouting.orchestratorModelId
                ? String(body.modelRouting.orchestratorModelId)
                : undefined,
              extractionModelId: body.modelRouting.extractionModelId
                ? String(body.modelRouting.extractionModelId)
                : undefined,
            }
          : {},
    });
    return NextResponse.json({ ok: true, settings: loadSettings() });
  } catch (error) {
    console.error("Settings POST error:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
