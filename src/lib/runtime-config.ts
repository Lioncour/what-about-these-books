import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".whataboutthisbook");

export const isPublicMode = process.env.PUBLIC_MODE === "true";

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function ensureDataDir(): void {
  ensureDir(DATA_DIR);
}

/**
 * Write JSON to `path` atomically: serialize to a sibling temp file, then rename over
 * the target. A crash mid-write leaves the old file intact (plus a stray `.tmp-*`).
 * `fs.renameSync` replaces an existing file on Windows as well as POSIX.
 */
export function writeJsonAtomic(path: string, data: unknown, pretty = true): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

// --- Id validation ---------------------------------------------------------
// Ids are joined into file paths (texts/<id>.json, chats/<id>.json, backups/<id>, …),
// so they must never contain path separators or dots. Each generator uses
// `<prefix>-<Date.now()>` (series may add a random suffix); `[\w-]` covers all of them.

const BOOK_ID_RE = /^book-[\w-]+$/;
const CHAT_ID_RE = /^chat-[\w-]+$/;
const SERIES_ID_RE = /^series-[\w-]+$/;
const BACKUP_ID_RE = /^backup-[\w-]+$/;

export function isValidBookId(id: unknown): id is string {
  return typeof id === "string" && BOOK_ID_RE.test(id);
}

export function isValidChatId(id: unknown): id is string {
  return typeof id === "string" && CHAT_ID_RE.test(id);
}

export function isValidSeriesId(id: unknown): id is string {
  return typeof id === "string" && SERIES_ID_RE.test(id);
}

export function isValidBackupId(id: unknown): id is string {
  return typeof id === "string" && BACKUP_ID_RE.test(id);
}

/** Thrown by store functions when an id would be joined into a path but is malformed. */
export class InvalidIdError extends Error {
  constructor(kind: string, id: unknown) {
    super(`Invalid ${kind} id: ${String(id)}`);
    this.name = "InvalidIdError";
  }
}
