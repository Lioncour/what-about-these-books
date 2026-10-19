import { NextRequest, NextResponse } from "next/server";
import {
  listSeries,
  saveSeries,
  deleteSeries,
  reconcileLibrarySeries,
} from "@/lib/book-store";

export async function GET() {
  return NextResponse.json({ series: listSeries() });
}

export async function POST(request: NextRequest) {
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

    const saved = saveSeries({
      id: body?.id ? String(body.id) : undefined,
      name,
      bookIds,
    });

    return NextResponse.json({ series: saved });
  } catch (error) {
    console.error("Series POST error:", error);
    return NextResponse.json({ error: "Failed to save series" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const seriesId = String(body?.seriesId || "");

    if (!seriesId) {
      return NextResponse.json({ error: "seriesId is required" }, { status: 400 });
    }

    deleteSeries(seriesId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Series DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete series" }, { status: 500 });
  }
}
