import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BookPage } from "@/lib/book-store";
import { entityFinder, extractBookEntities, settleEntityTypes, type EntityEvidence } from "@/lib/knowledge-extract";
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
  /** What surrounded the name in this book; lets the type be settled across books. */
  evidence?: EntityEvidence;
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
 * 3: ranks alone are no names, plurals fold into their group, nationalities and
 *    ALL-CAPS abbreviations are groups, towns stay places, one type per name library-wide.
 */
export const KNOWLEDGE_VERSION = 3;

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
      ...(entity.evidence ? { evidence: entity.evidence } : {}),
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
  // One type per name: what most books say, or what the evidence of all of them adds up to.
  settleEntityTypes(graph.nodes);
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

/** Every character name and alias in the graph, lower-cased: "is this someone the books know?" */
export function knownCharacterNames(): Set<string> {
  const names = new Set<string>();
  const lower = (s: string) => s.toLowerCase().replace(/’/g, "'");
  for (const node of loadGraph().nodes) {
    if (node.type !== "character") continue;
    names.add(lower(node.name));
    for (const alias of node.aliases || []) names.add(lower(alias));
  }
  return names;
}

export interface KnownEntity {
  name: string;
  type: EntityNode["type"];
  /** Other forms of the name ("Joe", "Bishop"; "Kristangs"). */
  aliases: string[];
  mentions: number;
  /** How many of the books in scope it appears in. */
  books: number;
}

/**
 * What the graph knows about a name, whichever form of it was asked for: "Bishop" and
 * "Joe" find "Joe Bishop", "Kristangs" finds "Kristang". Null when no book has it.
 * `bookIds` narrows the lookup to those books.
 */
export function lookupEntity(name: string, bookIds?: string[]): KnownEntity | null {
  const lower = (s: string) => s.toLowerCase().replace(/’/g, "'");
  const key = lower(name.trim()).replace(/^the\s+/, "");
  if (!key) return null;
  const forms = new Set([key, key.replace(/'s$/, "")]);
  if (key.length > 4 && key.endsWith("s")) forms.add(key.slice(0, -1));
  const inScope = bookIds?.length ? new Set(bookIds) : null;

  const byName = new Map<string, KnownEntity & { bookIds: Set<string>; viaAlias: boolean }>();
  for (const node of loadGraph().nodes) {
    if (inScope && !node.books.some((b) => inScope.has(b))) continue;
    const isName = forms.has(lower(node.name));
    const isAlias = !isName && (node.aliases || []).some((a) => forms.has(lower(a)));
    if (!isName && !isAlias) continue;
    const row = byName.get(lower(node.name)) || {
      name: node.name,
      type: node.type,
      aliases: [],
      mentions: 0,
      books: 0,
      bookIds: new Set<string>(),
      viaAlias: isAlias,
    };
    row.mentions += node.mentions;
    for (const b of node.books) if (!inScope || inScope.has(b)) row.bookIds.add(b);
    for (const a of node.aliases || []) if (!row.aliases.some((x) => lower(x) === lower(a))) row.aliases.push(a);
    byName.set(lower(node.name), row);
  }
  if (!byName.size) return null;
  const rows = [...byName.values()].sort((a, b) => b.mentions - a.mentions);
  // A full name the asked-for form is short for wins over the short form on its own,
  // when only one full name claims it ("Bishop" → "Joe Bishop").
  const full = rows.filter((r) => r.viaAlias && r.type === "character");
  const best = full.length === 1 ? full[0] : rows.find((r) => !r.viaAlias) || rows[0];
  // Books where the short form stands alone count for the full name too.
  if (best.viaAlias) {
    for (const r of rows) {
      if (r === best || r.viaAlias) continue;
      best.mentions += r.mentions;
      for (const b of r.bookIds) best.bookIds.add(b);
    }
  }
  return { name: best.name, type: best.type, aliases: best.aliases, mentions: best.mentions, books: best.bookIds.size };
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
