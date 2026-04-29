import { NextRequest, NextResponse } from "next/server";
import { createBackupSnapshot, listBackups, recordMigration, restoreBackup, runIntegrityCheck } from "@/lib/ops-store";

export async function GET() {
  return NextResponse.json({
    backups: listBackups(),
    integrity: runIntegrityCheck(),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const action = String(body?.action || "backup");
  if (action === "backup") {
    return NextResponse.json(createBackupSnapshot());
  }
  if (action === "restore") {
    const backupId = String(body?.backupId || "");
    if (!backupId) return NextResponse.json({ error: "Missing backupId" }, { status: 400 });
    restoreBackup(backupId);
    return NextResponse.json({ ok: true });
  }
  if (action === "migrate") {
    const version = String(body?.version || `manual-${Date.now()}`);
    const notes = String(body?.notes || "Manual migration marker");
    recordMigration(version, notes);
    return NextResponse.json({ ok: true, version });
  }
  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
