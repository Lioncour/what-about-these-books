import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDataDir, ensureDir } from "@/lib/runtime-config";

const QUALITY_DIR = join(DATA_DIR, "quality");
const SCORECARD_FILE = join(QUALITY_DIR, "specialist-scorecards.json");
const CACHE_FILE = join(QUALITY_DIR, "specialist-cache.json");

export interface SpecialistScorecard {
  bookId: string;
  bookTitle: string;
  total: number;
  highConfidence: number;
  lowConfidence: number;
  withFindings: number;
  precisionEstimate: number;
  recallEstimate: number;
  updatedAt: string;
}

interface SpecialistCacheEntry {
  key: string;
  answer: string;
  confidence: "high" | "medium" | "low";
  findingsCount: number;
  createdAt: string;
}

function ensureQualityDir(): void {
  ensureDataDir();
  ensureDir(QUALITY_DIR);
}

function loadScorecards(): SpecialistScorecard[] {
  ensureQualityDir();
  if (!existsSync(SCORECARD_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SCORECARD_FILE, "utf-8")) as SpecialistScorecard[];
  } catch {
    return [];
  }
}

function saveScorecards(rows: SpecialistScorecard[]): void {
  ensureQualityDir();
  writeFileSync(SCORECARD_FILE, JSON.stringify(rows, null, 2));
}

function loadCache(): SpecialistCacheEntry[] {
  ensureQualityDir();
  if (!existsSync(CACHE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as SpecialistCacheEntry[];
  } catch {
    return [];
  }
}

function saveCache(rows: SpecialistCacheEntry[]): void {
  ensureQualityDir();
  writeFileSync(CACHE_FILE, JSON.stringify(rows.slice(-500), null, 2));
}

export function fingerprintQuestion(bookId: string, question: string): string {
  return createHash("sha256").update(`${bookId}::${question.trim().toLowerCase()}`).digest("hex");
}

export function getCachedSpecialistAnswer(cacheKey: string): SpecialistCacheEntry | null {
  const row = loadCache().find((r) => r.key === cacheKey);
  return row || null;
}

export function setCachedSpecialistAnswer(row: SpecialistCacheEntry): void {
  const rows = loadCache().filter((r) => r.key !== row.key);
  rows.push(row);
  saveCache(rows);
}

export function updateSpecialistScorecard(params: {
  bookId: string;
  bookTitle: string;
  confidence: "high" | "medium" | "low";
  findingsCount: number;
}): SpecialistScorecard {
  const rows = loadScorecards();
  const existing = rows.find((r) => r.bookId === params.bookId) || {
    bookId: params.bookId,
    bookTitle: params.bookTitle,
    total: 0,
    highConfidence: 0,
    lowConfidence: 0,
    withFindings: 0,
    precisionEstimate: 0,
    recallEstimate: 0,
    updatedAt: new Date().toISOString(),
  };
  existing.total += 1;
  if (params.confidence === "high") existing.highConfidence += 1;
  if (params.confidence === "low") existing.lowConfidence += 1;
  if (params.findingsCount > 0) existing.withFindings += 1;
  existing.precisionEstimate = Number((existing.withFindings / Math.max(existing.total, 1)).toFixed(3));
  existing.recallEstimate = Number(
    ((existing.highConfidence + (existing.total - existing.lowConfidence) * 0.5) / Math.max(existing.total, 1)).toFixed(3)
  );
  existing.updatedAt = new Date().toISOString();
  const next = rows.filter((r) => r.bookId !== existing.bookId);
  next.push(existing);
  saveScorecards(next);
  return existing;
}

export function listSpecialistScorecards(): SpecialistScorecard[] {
  return loadScorecards().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
