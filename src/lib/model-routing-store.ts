/** What was found out about the cheaper librarian models (ops/model-routing.json). */
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR, writeJsonAtomic } from "@/lib/runtime-config";
import { emptyRoutingState, parseRoutingState, type ModelRoutingState } from "@/lib/model-routing";

const STATE_FILE = join(DATA_DIR, "ops", "model-routing.json");

let memory: ModelRoutingState | null = null;

/** Loaded once per process; every later read is the in-memory copy. */
export function loadModelRoutingState(): ModelRoutingState {
  if (memory) return memory;
  try {
    memory = existsSync(STATE_FILE)
      ? parseRoutingState(JSON.parse(readFileSync(STATE_FILE, "utf-8")))
      : emptyRoutingState();
  } catch {
    memory = emptyRoutingState();
  }
  return memory;
}

export function saveModelRoutingState(state: ModelRoutingState): void {
  memory = state;
  try {
    writeJsonAtomic(STATE_FILE, { ...state, updatedAt: new Date().toISOString() });
  } catch (error) {
    // Remembering is a convenience; the process keeps its in-memory copy.
    console.error("Could not save model-routing.json:", error);
  }
}

/** Forget everything (Settings → Re-check): the next librarian call probes again. */
export function clearModelRoutingState(): void {
  memory = emptyRoutingState();
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  } catch (error) {
    console.error("Could not remove model-routing.json:", error);
  }
}
