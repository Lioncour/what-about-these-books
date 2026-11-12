import { NextRequest, NextResponse } from "next/server";
import { createBackupSnapshot, listBackups, recordMigration, restoreBackup, runIntegrityCheck } from "@/lib/ops-store";
import { resetIndexCache } from "@/lib/book-store";
import { errorResponse, publicModeBlocked } from "@/lib/api-guard";

export async function GET() {
  return NextResponse.json({
    backups: listBackups(),
    integrity: runIntegrityCheck(),
  });
}

export async function POST(request: NextRequest) {
  const blocked = publicModeBlocked("Backup and restore");
  if (blocked) return blocked;
  const body = await request.json();
  const action = String(body?.action || "backup");
  if (action === "backup") {
    return NextResponse.json(createBackupSnapshot());
  }
  if (action === "restore") {
    const backupId = String(body?.backupId || "");
    if (!backupId) return NextResponse.json({ error: "Missing backupId" }, { status: 400 });
    try {
      restoreBackup(backupId);
    } catch (error) {
      return errorResponse(error, "Failed to restore backup");
    }
    // The in-memory Vectra index still holds the pre-restore data; drop it so the next
    // update reads the restored index/ instead of overwriting it.
    resetIndexCache();
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
