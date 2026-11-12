import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BookPage } from "@/lib/book-store";
import { entityFinder, extractBookEntities } from "@/lib/knowledge-extract";
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
  /** Other forms of the name counted into this node ("Joe", "Bishop" for "Joe Bishop"). */
  aliases?: string[];
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
  /** Extraction version that built this graph (absent: 1). */
  version?: number;
}

interface TimelineStore {
  events: TimelineEvent[];
  updatedAt: string;
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

/**
 * Bump when the extraction changes: graphs built by an older version are rebuilt from
 * the stored text the next time they are read (see knowledge-rebuild.ts).
 * 2: names by mid-sentence capitals and context instead of every capitalised word.
 */
export const KNOWLEDGE_VERSION = 2;

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

/** Replace one book's nodes, edges and events in the given stores (not saved here). */
function rebuildInto(
  graph: EntityGraphStore,
  timeline: TimelineStore,
  params: { bookId: string; bookTitle: string; pages: BookPage[] }
): void {
  const { bookId, bookTitle, pages } = params;
  graph.nodes = graph.nodes.filter((n) => !n.books.includes(bookId));
  graph.edges = graph.edges.filter((e) => e.bookId !== bookId);
  timeline.events = timeline.events.filter((e) => e.bookId !== bookId);

  const entities = extractBookEntities(pages);
  const find = entityFinder(entities);
  for (const entity of entities) {
    graph.nodes.push({
      id: entity.name.toLowerCase(),
      name: entity.name,
      type: entity.type,
      mentions: entity.mentions,
      books: [bookId],
      ...(entity.aliases.length ? { aliases: entity.aliases } : {}),
    });
  }

  let sequence = 0;
  for (const page of pages) {
    const onPage = find(page.text);
    const evidence = page.text.slice(0, MAX_EVIDENCE_CHARS).replace(/\s+/g, " ").trim();
    for (let i = 0; i < onPage.length - 1 && i < MAX_EDGES_PER_PAGE; i++) {
      graph.edges.push({
        from: onPage[i].toLowerCase(),
        to: onPage[i + 1].toLowerCase(),
        relation: "co-mentioned",
        bookId,
        location: page.label,
        evidence,
      });
    }

    for (const event of extractEventSentences(page.text)) {
      sequence++;
      timeline.events.push({
        id: `${bookId}-${sequence}`,
        bookId,
        bookTitle,
        location: page.label,
        sequence,
        text: event,
        entities: find(event).map((e) => e.toLowerCase()),
      });
    }
  }
}

export function rebuildKnowledgeForBook(
  params: { bookId: string; bookTitle: string; pages: BookPage[] }
): void {
  rebuildKnowledgeForBooks([params], { keepVersion: true });
}

/**
 * Rebuild several books with one read and one write of the stores. A full-library
 * rebuild stamps the current version; a single upload keeps whatever version the
 * stores have, so an outdated graph is still rebuilt as a whole later.
 */
export function rebuildKnowledgeForBooks(
  books: Array<{ bookId: string; bookTitle: string; pages: BookPage[] }>,
  opts: { keepVersion?: boolean; replaceAll?: boolean } = {}
): void {
  const graph = loadGraph();
  const timeline = loadTimeline();
  if (opts.replaceAll) {
    // A library rebuild starts from nothing, so entries of books that no longer exist
    // (removed before deletes cleaned up after themselves) don't linger.
    graph.nodes = [];
    graph.edges = [];
    timeline.events = [];
  }
  const fresh = graph.nodes.length === 0 && graph.edges.length === 0;
  for (const book of books) rebuildInto(graph, timeline, book);
  if (!opts.keepVersion || fresh) graph.version = KNOWLEDGE_VERSION;
  graph.updatedAt = new Date().toISOString();
  timeline.updatedAt = new Date().toISOString();
  saveGraph(graph);
  saveTimeline(timeline);
}

/** True when the stored graph was built by the current extraction (or holds nothing). */
export function isKnowledgeCurrent(): boolean {
  const graph = loadGraph();
  return (graph.version ?? 1) >= KNOWLEDGE_VERSION || (graph.nodes.length === 0 && graph.edges.length === 0);
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
  const nodes = graph.nodes
    .filter((n) => n.name.toLowerCase().includes(q) || n.aliases?.some((a) => a.toLowerCase().includes(q)))
    .slice(0, 30);
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
