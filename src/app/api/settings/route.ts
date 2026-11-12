import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings } from "@/lib/book-store";
import { publicModeBlocked } from "@/lib/api-guard";
import { getModelRoutingStatus, recheckSpecialistModels } from "@/lib/chat/specialist-model";

const routingStatus = (settings: ReturnType<typeof loadSettings>) =>
  getModelRoutingStatus(settings.modelRouting?.specialistModelId);

/** The settings, plus `modelRoutingStatus`: which model the librarians run on right now. */
export async function GET() {
  const settings = loadSettings();
  return NextResponse.json({ ...settings, modelRoutingStatus: routingStatus(settings) });
}

/**
 * Save the settings (the whole object; the store normalises it), or with
 * `{ "recheckModels": true }` forget what was found out about the cheaper librarian
 * models so the next question probes them again. A re-check saves nothing else.
 */
export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Changing settings");
  if (blocked) return blocked;
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    let settings: ReturnType<typeof loadSettings>;
    if (body?.recheckModels === true) {
      recheckSpecialistModels();
      settings = loadSettings();
    } else {
      settings = saveSettings(body);
    }
    return NextResponse.json({ ok: true, settings, modelRoutingStatus: routingStatus(settings) });
  } catch (error) {
    console.error("Settings POST error:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
