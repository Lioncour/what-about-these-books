import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BookPage } from "@/lib/book-store";
import { DATA_DIR, ensureDir, ensureDataDir, writeJsonAtomic } from "@/lib/runtime-config";

const KNOWLEDGE_DIR = join(DATA_DIR, "knowledge");
const GRAPH_FILE = join(KNOWLEDGE_DIR, "entity-graph.json");
const TIMELINE_FILE = join(KNOWLEDGE_DIR, "timeline.json");

export interface EntityNode {
  id: string;
  name: string;
  type: "character" | "place" | "faction" | "event" | "unknown";
  mentions: number;
  books: string[];
}

export interface EntityEdge {
  from: string;
  to: string;
  relation: string;
  bookId: string;
  location: string;
  evidence: string;
}

export interface TimelineEvent {
  id: string;
  bookId: string;
  bookTitle: string;
  location: string;
  sequence: number;
  text: string;
  entities: string[];
}

interface EntityGraphStore {
  nodes: EntityNode[];
  edges: EntityEdge[];
  updatedAt: string;
}

interface TimelineStore {
  events: TimelineEvent[];
  updatedAt: string;
}

function normalizeEntity(raw: string): string {
  return raw.replace(/[^A-Za-z0-9\s'-]/g, "").trim();
}

function ensureKnowledgeDir(): void {
  ensureDataDir();
  ensureDir(KNOWLEDGE_DIR);
}

function loadGraph(): EntityGraphStore {
  ensureKnowledgeDir();
  if (!existsSync(GRAPH_FILE)) return { nodes: [], edges: [], updatedAt: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(GRAPH_FILE, "utf-8")) as EntityGraphStore;
  } catch {
    return { nodes: [], edges: [], updatedAt: new Date().toISOString() };
  }
}

function saveGraph(graph: EntityGraphStore): void {
  ensureKnowledgeDir();
  writeJsonAtomic(GRAPH_FILE, graph);
}

function loadTimeline(): TimelineStore {
  ensureKnowledgeDir();
  if (!existsSync(TIMELINE_FILE)) return { events: [], updatedAt: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(TIMELINE_FILE, "utf-8")) as TimelineStore;
  } catch {
    return { events: [], updatedAt: new Date().toISOString() };
  }
}

function saveTimeline(timeline: TimelineStore): void {
  ensureKnowledgeDir();
  writeJsonAtomic(TIMELINE_FILE, timeline);
}

/** Co-mention edges kept per page and evidence length: 39 x 220 chars per page made a
 * 1000-page book add ~10 MB to one JSON file rewritten on every upload. */
const MAX_EDGES_PER_PAGE = 8;
const MAX_EVIDENCE_CHARS = 160;

function classifyEntity(name: string): EntityNode["type"] {
  const lower = name.toLowerCase();
  if (/(kingdom|fleet|empire|force|alliance|army|clan)/i.test(lower)) return "faction";
  if (/(planet|city|station|base|earth|mars|moon)/i.test(lower)) return "place";
  return "character";
}

function extractEntitiesFromText(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || [];
  const uniq = new Set<string>();
  for (const m of matches) {
    const cleaned = normalizeEntity(m);
    if (cleaned.length >= 3 && cleaned.length <= 40) uniq.add(cleaned);
  }
  return [...uniq].slice(0, 40);
}

function extractEventSentences(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const eventy = sentences.filter((s) =>
    /(died|killed|arrived|left|attacked|retreated|captured|escaped|discovered|met|won|lost|battle)/i.test(s)
  );
  return eventy.slice(0, 20);
}

export function rebuildKnowledgeForBook(
  params: { bookId: string; bookTitle: string; pages: BookPage[] }
): void {
  const { bookId, bookTitle, pages } = params;
  const graph = loadGraph();
  const timeline = loadTimeline();

  graph.nodes = graph.nodes.filter((n) => !n.books.includes(bookId));
  graph.edges = graph.edges.filter((e) => e.bookId !== bookId);
  timeline.events = timeline.events.filter((e) => e.bookId !== bookId);

  const nodeMap = new Map<string, EntityNode>();
  let sequence = 0;

  for (const page of pages) {
    const entities = extractEntitiesFromText(page.text);
    for (const entity of entities) {
      const key = entity.toLowerCase();
      const existing = nodeMap.get(key) || {
        id: key,
        name: entity,
        type: classifyEntity(entity),
        mentions: 0,
        books: [],
      };
      existing.mentions += 1;
      if (!existing.books.includes(bookId)) existing.books.push(bookId);
      nodeMap.set(key, existing);
    }

    const evidence = page.text.slice(0, MAX_EVIDENCE_CHARS).replace(/\s+/g, " ").trim();
    let pageEdges = 0;
    for (let i = 0; i < entities.length - 1 && pageEdges < MAX_EDGES_PER_PAGE; i++) {
      const a = entities[i]?.toLowerCase();
      const b = entities[i + 1]?.toLowerCase();
      if (!a || !b || a === b) continue;
      graph.edges.push({
        from: a,
        to: b,
        relation: "co-mentioned",
        bookId,
        location: page.label,
        evidence,
      });
      pageEdges++;
    }

    const events = extractEventSentences(page.text);
    for (const event of events) {
      sequence++;
      timeline.events.push({
        id: `${bookId}-${sequence}`,
        bookId,
        bookTitle,
        location: page.label,
        sequence,
        text: event,
        entities: extractEntitiesFromText(event).map((e) => e.toLowerCase()),
      });
    }
  }

  graph.nodes.push(...nodeMap.values());
  graph.updatedAt = new Date().toISOString();
  timeline.updatedAt = new Date().toISOString();
  saveGraph(graph);
  saveTimeline(timeline);
}

/** Remove a deleted book's nodes (or its membership in shared nodes), edges and timeline events. */
export function removeBookFromKnowledge(bookId: string): void {
  const graph = loadGraph();
  const timeline = loadTimeline();
  const touchedGraph =
    graph.edges.some((e) => e.bookId === bookId) || graph.nodes.some((n) => n.books.includes(bookId));
  if (touchedGraph) {
    graph.nodes = graph.nodes
      .map((n) => ({ ...n, books: n.books.filter((id) => id !== bookId) }))
      .filter((n) => n.books.length > 0);
    graph.edges = graph.edges.filter((e) => e.bookId !== bookId);
    graph.updatedAt = new Date().toISOString();
    saveGraph(graph);
  }
  if (timeline.events.some((e) => e.bookId === bookId)) {
    timeline.events = timeline.events.filter((e) => e.bookId !== bookId);
    timeline.updatedAt = new Date().toISOString();
    saveTimeline(timeline);
  }
}

export function getEntityGraph(): EntityGraphStore {
  return loadGraph();
}

export function queryEntityGraph(query: string): { nodes: EntityNode[]; edges: EntityEdge[] } {
  const q = query.toLowerCase();
  const graph = loadGraph();
  const nodes = graph.nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 30);
  const nodeSet = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => nodeSet.has(e.from) || nodeSet.has(e.to)).slice(0, 60);
  return { nodes, edges };
}

export function getTimelineForBooks(bookIds?: string[]): TimelineEvent[] {
  const timeline = loadTimeline();
  const filtered = bookIds?.length
    ? timeline.events.filter((e) => bookIds.includes(e.bookId))
    : timeline.events;
  return filtered.sort((a, b) => a.sequence - b.sequence);
}

export function detectChronologyConflicts(bookIds?: string[]): string[] {
  const events = getTimelineForBooks(bookIds);
  const byEntity = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    for (const entity of event.entities) {
      const arr = byEntity.get(entity) || [];
      arr.push(event);
      byEntity.set(entity, arr);
    }
  }
  const conflicts: string[] = [];
  for (const [entity, items] of byEntity) {
    const hasDeath = items.some((i) => /died|killed/i.test(i.text));
    const afterDeathActivity = items.some(
      (i, idx) => idx > 0 && /arrived|met|attacked|won|lost|escaped/i.test(i.text) && hasDeath
    );
    if (afterDeathActivity) {
      conflicts.push(`Potential chronology conflict for ${entity}: post-death activity appears in timeline.`);
    }
  }
  return conflicts.slice(0, 20);
}

/** Timeline events carry a copy of the book's title for display; follow a rename. */
export function renameBookInKnowledge(bookId: string, bookTitle: string): void {
  const timeline = loadTimeline();
  let changed = false;
  for (const event of timeline.events) {
    if (event.bookId === bookId && event.bookTitle !== bookTitle) {
      event.bookTitle = bookTitle;
      changed = true;
    }
  }
  if (!changed) return;
  timeline.updatedAt = new Date().toISOString();
  saveTimeline(timeline);
}
