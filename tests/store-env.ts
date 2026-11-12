import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/**
 * Point DATA_DIR at a new temp folder and forget loaded modules, so the next
 * `await import("@/lib/…")` builds its paths (and caches) for that folder.
 * The store must never see the real ~/.whataboutthisbook from a test.
 */
export function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wabt-test-"));
  process.env.DATA_DIR = dir;
  vi.resetModules();
  return dir;
}

export function removeDataDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface FakeBook {
  id: string;
  title: string;
  filename: string;
  author?: string;
  fileType?: string;
  seriesId?: string;
  pages?: { label: string; text: string }[];
}

/** Write books.json and texts/<id>.json straight to disk, the way an older version left them. */
export function writeLibrary(
  dir: string,
  books: FakeBook[],
  series: { id: string; name: string; bookIds: string[] }[] = []
): void {
  mkdirSync(join(dir, "texts"), { recursive: true });
  const catalog = {
    books: books.map((b) => ({
      id: b.id,
      title: b.title,
      filename: b.filename,
      author: b.author,
      fileType: b.fileType,
      seriesId: b.seriesId,
      wordCount: 100,
      addedAt: "2026-01-01T00:00:00.000Z",
    })),
    series: series.map((s) => ({ createdAt: "2026-01-01T00:00:00.000Z", ...s })),
  };
  writeFileSync(join(dir, "books.json"), JSON.stringify(catalog, null, 2));
  for (const b of books) {
    if (b.pages) writeFileSync(join(dir, "texts", `${b.id}.json`), JSON.stringify(b.pages));
  }
}
