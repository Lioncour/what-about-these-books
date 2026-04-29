import { createHash, randomBytes } from "crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDataDir, ensureDir } from "@/lib/runtime-config";

const OPS_DIR = join(DATA_DIR, "ops");
const SAVED_SEARCH_FILE = join(OPS_DIR, "saved-searches.json");
const SHARE_FILE = join(OPS_DIR, "shares.json");
const MIGRATION_FILE = join(OPS_DIR, "migrations.json");
const BACKUP_DIR = join(DATA_DIR, "backups");

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  scope: "all" | "book" | "series";
  scopeId?: string;
  exactPhrase?: string;
  mustInclude?: string[];
  exclude?: string[];
  pageFrom?: number;
  pageTo?: number;
  createdAt: string;
}

export interface ShareLink {
  id: string;
  token: string;
  bookIds: string[];
  redactTerms: string[];
  createdAt: string;
  expiresAt?: string;
}

function ensureOps(): void {
  ensureDataDir();
  ensureDir(OPS_DIR);
  ensureDir(BACKUP_DIR);
}

function loadJson<T>(path: string, fallback: T): T {
  ensureOps();
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson(path: string, value: unknown): void {
  ensureOps();
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export function listSavedSearches(): SavedSearch[] {
  return loadJson<SavedSearch[]>(SAVED_SEARCH_FILE, []);
}

export function saveSavedSearch(search: Omit<SavedSearch, "id" | "createdAt"> & { id?: string }): SavedSearch {
  const rows = listSavedSearches().filter((r) => r.id !== search.id);
  const next: SavedSearch = {
    id: search.id || `search-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...search,
  };
  rows.push(next);
  saveJson(SAVED_SEARCH_FILE, rows);
  return next;
}

export function deleteSavedSearch(id: string): void {
  saveJson(SAVED_SEARCH_FILE, listSavedSearches().filter((r) => r.id !== id));
}

export function createShareLink(params: { bookIds: string[]; redactTerms?: string[]; expiresAt?: string }): ShareLink {
  const rows = loadJson<ShareLink[]>(SHARE_FILE, []);
  const token = randomBytes(24).toString("hex");
  const row: ShareLink = {
    id: `share-${Date.now()}`,
    token,
    bookIds: params.bookIds,
    redactTerms: params.redactTerms || [],
    createdAt: new Date().toISOString(),
    expiresAt: params.expiresAt,
  };
  rows.push(row);
  saveJson(SHARE_FILE, rows);
  return row;
}

export function listShareLinks(): ShareLink[] {
  return loadJson<ShareLink[]>(SHARE_FILE, []);
}

export function findShareByToken(token: string): ShareLink | null {
  const row = listShareLinks().find((s) => s.token === token);
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row;
}

export function redactText(input: string, terms: string[]): string {
  let out = input;
  for (const term of terms) {
    if (!term.trim()) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function createBackupSnapshot(): { backupId: string; path: string } {
  ensureOps();
  const backupId = `backup-${Date.now()}`;
  const dst = join(BACKUP_DIR, backupId);
  ensureDir(dst);
  const includeDirs = ["index", "covers", "texts", "specialists", "chats", "knowledge", "ops"];
  const includeFiles = ["books.json", "settings.json"];
  for (const d of includeDirs) {
    const src = join(DATA_DIR, d);
    if (existsSync(src)) cpSync(src, join(dst, d), { recursive: true });
  }
  for (const f of includeFiles) {
    const src = join(DATA_DIR, f);
    if (existsSync(src)) copyFileSync(src, join(dst, f));
  }
  return { backupId, path: dst };
}

export function listBackups(): { backupId: string; createdAt: string; sizeBytes: number }[] {
  ensureOps();
  const dirs = readdirSync(BACKUP_DIR).filter((n) => n.startsWith("backup-"));
  return dirs.map((dir) => {
    const p = join(BACKUP_DIR, dir);
    const stats = statSync(p);
    return {
      backupId: dir,
      createdAt: stats.birthtime.toISOString(),
      sizeBytes: stats.size,
    };
  });
}

export function restoreBackup(backupId: string): void {
  const src = join(BACKUP_DIR, backupId);
  if (!existsSync(src)) throw new Error(`Backup not found: ${backupId}`);
  const entries = readdirSync(src);
  for (const entry of entries) {
    const from = join(src, entry);
    const to = join(DATA_DIR, entry);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
}

export function runIntegrityCheck(): { ok: boolean; issues: string[] } {
  ensureOps();
  const issues: string[] = [];
  const required = ["books.json"];
  for (const f of required) {
    if (!existsSync(join(DATA_DIR, f))) issues.push(`Missing required file: ${f}`);
  }
  const chatDir = join(DATA_DIR, "chats");
  if (existsSync(chatDir)) {
    for (const file of readdirSync(chatDir)) {
      try {
        JSON.parse(readFileSync(join(chatDir, file), "utf-8"));
      } catch {
        issues.push(`Corrupt chat file: ${file}`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function recordMigration(version: string, notes: string): void {
  const rows = loadJson<Array<{ version: string; notes: string; at: string; hash: string }>>(MIGRATION_FILE, []);
  rows.push({
    version,
    notes,
    at: new Date().toISOString(),
    hash: createHash("sha256").update(`${version}:${notes}`).digest("hex"),
  });
  saveJson(MIGRATION_FILE, rows.slice(-100));
}
