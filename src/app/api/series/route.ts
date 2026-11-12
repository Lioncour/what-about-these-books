import { NextRequest, NextResponse } from "next/server";
import {
  listSeries,
  saveSeries,
  deleteSeries,
  reconcileLibrarySeries,
  isValidBookId,
  isValidSeriesId,
} from "@/lib/book-store";
import { badRequest, errorResponse, publicModeBlocked } from "@/lib/api-guard";

export async function GET() {
  return NextResponse.json({ series: listSeries() });
}

export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Editing series");
  if (blocked) return blocked;
  try {
    const body = await request.json();
    if (body?.action === "auto-fix" || body?.action === "reconcile") {
      const result = await reconcileLibrarySeries({
        allowRemote: body?.allowRemote !== false,
      });
      return NextResponse.json({ ok: true, ...result });
    }
    const name = String(body?.name || "").trim();
    const bookIds = Array.isArray(body?.bookIds)
      ? body.bookIds.map((id: unknown) => String(id))
      : [];

    if (!name) {
      return NextResponse.json({ error: "Series name is required" }, { status: 400 });
    }
    if (body?.id && !isValidSeriesId(String(body.id))) return badRequest("Invalid series id");
    if (bookIds.some((id: string) => !isValidBookId(id))) return badRequest("Invalid book id");

    const saved = saveSeries({
      id: body?.id ? String(body.id) : undefined,
      name,
      bookIds,
    });

    return NextResponse.json({ series: saved });
  } catch (error) {
    return errorResponse(error, "Failed to save series");
  }
}

export async function DELETE(request: NextRequest) {
  const blocked = publicModeBlocked("Deleting series");
  if (blocked) return blocked;
  try {
    const body = await request.json();
    const seriesId = String(body?.seriesId || "");

    if (!seriesId) {
      return NextResponse.json({ error: "seriesId is required" }, { status: 400 });
    }
    if (!isValidSeriesId(seriesId)) return badRequest("Invalid series id");

    deleteSeries(seriesId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Failed to delete series");
  }
}
