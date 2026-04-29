import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "@/lib/runtime-config";

const LOG_DIR = join(DATA_DIR, "logs");
const CHAT_LOG_FILE = join(LOG_DIR, "chat.log");

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function logChatEvent(event: string, payload?: unknown): void {
  try {
    ensureLogDir();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      payload: payload ?? null,
    });
    appendFileSync(CHAT_LOG_FILE, `${line}\n`);
  } catch {
    // Logging must never break chat flow.
  }
}

export function readRecentChatLogs(maxLines = 200): string[] {
  try {
    ensureLogDir();
    if (!existsSync(CHAT_LOG_FILE)) return [];
    const lines = readFileSync(CHAT_LOG_FILE, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
