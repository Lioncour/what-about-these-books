import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  listBooks,
  loadBookPages,
  loadBookSpecialistProfile,
  rebuildBookIndex,
  saveBookPages,
  saveBookSpecialistProfile,
} from "@/lib/book-store";
import { rebuildKnowledgeForBook } from "@/lib/knowledge-store";
import { DATA_DIR, ensureDataDir, ensureDir, writeJsonAtomic } from "@/lib/runtime-config";

const REINDEX_DIR = join(DATA_DIR, "ops");
const REINDEX_FILE = join(REINDEX_DIR, "reindex-state.json");

interface ReindexState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  processed: number;
  total: number;
  lastError?: string;
  currentBookId?: string;
  /** Process that started the run; a persisted `running: true` from another pid is stale. */
  pid?: number;
}

/** A run older than this is treated as crashed, whatever the file says. */
const STALE_AFTER_MS = 30 * 60 * 1000;

const defaultState: ReindexState = {
  running: false,
  processed: 0,
  total: 0,
};

function ensureOpsDir() {
  ensureDataDir();
  ensureDir(REINDEX_DIR);
}

export function getReindexState(): ReindexState {
  ensureOpsDir();
  if (!existsSync(REINDEX_FILE)) return { ...defaultState };
  try {
    const state = JSON.parse(readFileSync(REINDEX_FILE, "utf-8")) as ReindexState;
    if (state.running && isStale(state)) {
      return {
        ...state,
        running: false,
        currentBookId: undefined,
        lastError: state.lastError || "Previous re-index did not finish (process exited or timed out).",
      };
    }
    return state;
  } catch {
    return { ...defaultState };
  }
}

function isStale(state: ReindexState): boolean {
  if (state.pid !== process.pid) return true;
  const started = state.startedAt ? Date.parse(state.startedAt) : NaN;
  return !Number.isFinite(started) || Date.now() - started > STALE_AFTER_MS;
}

function setReindexState(state: ReindexState): void {
  ensureOpsDir();
  writeJsonAtomic(REINDEX_FILE, state);
}

export async function startFullReindex(): Promise<ReindexState> {
  const current = getReindexState();
  if (current.running) return current;

  const books = listBooks();
  const state: ReindexState = {
    running: true,
    startedAt: new Date().toISOString(),
    processed: 0,
    total: books.length,
    pid: process.pid,
  };
  setReindexState(state);

  (async () => {
    try {
      for (const book of books) {
        state.currentBookId = book.id;
        setReindexState(state);
        const pages = loadBookPages(book.id) || [];
        if (pages.length) {
          // Re-save page map to normalize format after pipeline upgrades.
          saveBookPages(book.id, pages);
          await rebuildBookIndex(book.id);
          rebuildKnowledgeForBook({ bookId: book.id, bookTitle: book.title, pages });
          // Keep a Claude-built profile; only books without one get the stub.
          if (!loadBookSpecialistProfile(book.id)) saveBookSpecialistProfile({
            bookId: book.id,
            bookTitle: book.title,
            summary: `Reindexed specialist profile for "${book.title}".`,
            keyTopics: [],
            notableEntities: [],
            styleNotes: ["Rebuilt by re-index manager"],
            updatedAt: new Date().toISOString(),
          });
        }
        state.processed += 1;
        setReindexState(state);
      }
      state.running = false;
      state.currentBookId = undefined;
      state.finishedAt = new Date().toISOString();
      setReindexState(state);
    } catch (error) {
      state.running = false;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.finishedAt = new Date().toISOString();
      setReindexState(state);
    }
  })();

  return state;
}
