import { NextRequest, NextResponse } from "next/server";
import {
  deleteWorkspaceNote,
  exportWorkspaceMarkdown,
  listWorkspaceNotes,
  saveWorkspaceNote,
} from "@/lib/ops-store";

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "notes";
  if (mode === "export") {
    return NextResponse.json({
      markdown: exportWorkspaceMarkdown(),
      filename: `workspace-export-${new Date().toISOString().slice(0, 10)}.md`,
    });
  }
  return NextResponse.json({ notes: listWorkspaceNotes() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const note = saveWorkspaceNote({
    id: body?.id ? String(body.id) : undefined,
    text: String(body?.text || ""),
    source: body?.source ? String(body.source) : undefined,
  });
  return NextResponse.json({ note });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteWorkspaceNote(id);
  return NextResponse.json({ ok: true });
}

