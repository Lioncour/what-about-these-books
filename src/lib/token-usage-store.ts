import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDataDir, ensureDir, writeJsonAtomic } from "@/lib/runtime-config";

const OPS_DIR = join(DATA_DIR, "ops");
const USAGE_FILE = join(OPS_DIR, "token-usage.json");
const MAX_EVENTS = 400;

export type UsageKind = "claude" | "embedding";

export type UsageEvent = {
  id: string;
  at: string;
  kind: UsageKind;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  streamed?: boolean;
};

export type DayUsage = {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  claudeCalls: number;
  embeddingCalls: number;
};

export type UsageTotals = DayUsage & {
  /** Sum of Claude input + output (embeddings counted separately). */
  claudeTokens: number;
};

type UsageFile = {
  events: UsageEvent[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    embeddingTokens: number;
    claudeCalls: number;
    embeddingCalls: number;
  };
  byDay: Record<string, DayUsage>;
  byModel: Record<
    string,
    { inputTokens: number; outputTokens: number; embeddingTokens: number; calls: number }
  >;
  updatedAt: string;
};

function emptyDay(): DayUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    embeddingTokens: 0,
    claudeCalls: 0,
    embeddingCalls: 0,
  };
}

function emptyFile(): UsageFile {
  return {
    events: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      embeddingTokens: 0,
      claudeCalls: 0,
      embeddingCalls: 0,
    },
    byDay: {},
    byModel: {},
    updatedAt: new Date().toISOString(),
  };
}

function ensureOps(): void {
  ensureDataDir();
  ensureDir(OPS_DIR);
}

function loadFile(): UsageFile {
  ensureOps();
  if (!existsSync(USAGE_FILE)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as Partial<UsageFile>;
    return {
      ...emptyFile(),
      ...parsed,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      totals: { ...emptyFile().totals, ...(parsed.totals || {}) },
      byDay: parsed.byDay && typeof parsed.byDay === "object" ? parsed.byDay : {},
      byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {},
    };
  } catch {
    return emptyFile();
  }
}

function saveFile(data: UsageFile): void {
  ensureOps();
  data.updatedAt = new Date().toISOString();
  writeJsonAtomic(USAGE_FILE, data);
}

// --- Batched persistence --------------------------------------------------
// Every embedding call used to parse and rewrite this file synchronously, on the hot
// path of a Vectra upsert (hundreds of chunks per upload). The file is now loaded once
// into memory, mutated there, and flushed at most every FLUSH_INTERVAL_MS or at exit.

const FLUSH_INTERVAL_MS = 2000;
let memory: UsageFile | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getData(): UsageFile {
  if (!memory) memory = loadFile();
  return memory;
}

function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirty || !memory) return;
  try {
    saveFile(memory);
    dirty = false;
  } catch (error) {
    console.error("token-usage flush failed:", error);
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, FLUSH_INTERVAL_MS);
  // Don't keep the process alive just for this timer.
  if (typeof flushTimer === "object" && "unref" in flushTimer) flushTimer.unref();
}

if (!(globalThis as { __tokenUsageExitHook?: boolean }).__tokenUsageExitHook) {
  (globalThis as { __tokenUsageExitHook?: boolean }).__tokenUsageExitHook = true;
  process.once("exit", flushNow);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      flushNow();
      process.exit();
    });
  }
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function recordTokenUsage(input: {
  kind: UsageKind;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  streamed?: boolean;
}): UsageEvent | null {
  const inputTokens = Math.max(0, Math.floor(input.inputTokens || 0));
  const outputTokens = Math.max(0, Math.floor(input.outputTokens || 0));
  if (inputTokens === 0 && outputTokens === 0) return null;

  const at = new Date().toISOString();
  const event: UsageEvent = {
    id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    kind: input.kind,
    modelId: input.modelId || "unknown",
    inputTokens,
    outputTokens,
    streamed: input.streamed,
  };

  const data = getData();
  data.events.push(event);
  if (data.events.length > MAX_EVENTS) {
    data.events = data.events.slice(-MAX_EVENTS);
  }

  if (input.kind === "embedding") {
    data.totals.embeddingTokens += inputTokens;
    data.totals.embeddingCalls += 1;
  } else {
    data.totals.inputTokens += inputTokens;
    data.totals.outputTokens += outputTokens;
    data.totals.claudeCalls += 1;
  }

  const day = dayKey(at);
  if (!data.byDay[day]) data.byDay[day] = emptyDay();
  if (input.kind === "embedding") {
    data.byDay[day].embeddingTokens += inputTokens;
    data.byDay[day].embeddingCalls += 1;
  } else {
    data.byDay[day].inputTokens += inputTokens;
    data.byDay[day].outputTokens += outputTokens;
    data.byDay[day].claudeCalls += 1;
  }

  const modelKey = `${input.kind}:${event.modelId}`;
  if (!data.byModel[modelKey]) {
    data.byModel[modelKey] = {
      inputTokens: 0,
      outputTokens: 0,
      embeddingTokens: 0,
      calls: 0,
    };
  }
  data.byModel[modelKey].calls += 1;
  if (input.kind === "embedding") {
    data.byModel[modelKey].embeddingTokens += inputTokens;
  } else {
    data.byModel[modelKey].inputTokens += inputTokens;
    data.byModel[modelKey].outputTokens += outputTokens;
  }

  scheduleFlush();
  return event;
}

export function resetTokenUsage(): void {
  memory = emptyFile();
  dirty = true;
  flushNow();
}

export function getTokenUsageSummary() {
  const data = getData();
  const today = dayKey(new Date().toISOString());
  const todayUsage = data.byDay[today] || emptyDay();

  // Last 7 calendar days including today
  const last7 = emptyDay();
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dayKey(d.toISOString());
    const row = data.byDay[key];
    if (!row) continue;
    last7.inputTokens += row.inputTokens;
    last7.outputTokens += row.outputTokens;
    last7.embeddingTokens += row.embeddingTokens;
    last7.claudeCalls += row.claudeCalls;
    last7.embeddingCalls += row.embeddingCalls;
  }

  const totals: UsageTotals = {
    ...data.totals,
    claudeTokens: data.totals.inputTokens + data.totals.outputTokens,
  };

  const byModel = Object.entries(data.byModel)
    .map(([key, stats]) => {
      const [kind, ...rest] = key.split(":");
      return {
        kind: (kind === "embedding" ? "embedding" : "claude") as UsageKind,
        modelId: rest.join(":") || key,
        ...stats,
        tokens:
          kind === "embedding"
            ? stats.embeddingTokens
            : stats.inputTokens + stats.outputTokens,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totals,
    today: {
      ...todayUsage,
      claudeTokens: todayUsage.inputTokens + todayUsage.outputTokens,
    },
    last7Days: {
      ...last7,
      claudeTokens: last7.inputTokens + last7.outputTokens,
    },
    byModel,
    recent: [...data.events].reverse().slice(0, 25),
    updatedAt: data.updatedAt,
  };
}
