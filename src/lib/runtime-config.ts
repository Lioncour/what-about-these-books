import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".whataboutthisbook");

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function ensureDataDir(): void {
  ensureDir(DATA_DIR);
}
