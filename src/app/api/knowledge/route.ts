import { NextRequest, NextResponse } from "next/server";
import { detectChronologyConflicts, getEntityGraph, getTimelineForBooks, queryEntityGraph } from "@/lib/knowledge-store";

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "graph";
  const query = request.nextUrl.searchParams.get("q") || "";
  const bookIds = request.nextUrl.searchParams.get("bookIds")?.split(",").filter(Boolean);

  if (mode === "timeline") {
    return NextResponse.json({ events: getTimelineForBooks(bookIds) });
  }
  if (mode === "conflicts") {
    return NextResponse.json({ conflicts: detectChronologyConflicts(bookIds) });
  }
  if (query) {
    return NextResponse.json(queryEntityGraph(query));
  }
  return NextResponse.json(getEntityGraph());
}
