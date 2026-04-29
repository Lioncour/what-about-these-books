import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings } from "@/lib/book-store";

export async function GET() {
  return NextResponse.json(loadSettings());
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    saveSettings({
      language: String(body?.language || "Auto"),
      tone: String(body?.tone || "Scientific"),
      customInstructions: String(body?.customInstructions || ""),
      focusAreas: Array.isArray(body?.focusAreas)
        ? body.focusAreas.map((v: unknown) => String(v))
        : [],
      groundedMode: Boolean(body?.groundedMode),
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Settings POST error:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
