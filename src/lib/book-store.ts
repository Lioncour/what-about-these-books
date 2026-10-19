import { LocalDocumentIndex } from "vectra";
import { BedrockEmbeddings } from "./bedrock-embeddings";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { DATA_DIR, ensureDir } from "@/lib/runtime-config";
import {
  cleanSeriesDisplayName,
  normalizeSeriesKey,
  preferSeriesDisplayName,
} from "@/lib/series-detection";
import { resolveSeriesName } from "@/lib/series-lookup";
import {
  compareSeriesBooks,
  lookupEditionMetaFromOpenLibrary,
  resolveLocalSeriesOrder,
} from "@/lib/series-order";

function seriesKeysLooselyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a));
}

export { DATA_DIR };
const INDEX_DIR = join(DATA_DIR, "index");
const COVERS_DIR = join(DATA_DIR, "covers");
const TEXTS_DIR = join(DATA_DIR, "texts");
const SPECIALISTS_DIR = join(DATA_DIR, "specialists");
const CATALOG_FILE = join(DATA_DIR, "books.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export const isPublicMode = process.env.PUBLIC_MODE === "true";

export interface AISettings {
  language: string;
  tone: string;
  customInstructions: string;
  focusAreas: string[];
  groundedMode?: boolean;
  answerMode?: "Quick" | "Evidence-heavy" | "Exact count" | "Compare books";
  useConversationMemory?: boolean;
  countMode?: "whole_word" | "phrase" | "loose";
  /** When true (default): friend voice, welcome, presence copy. When false: raw answers only. */
  companionMode?: boolean;
  modelRouting?: {
    specialistModelId?: string;
    orchestratorModelId?: string;
    extractionModelId?: string;
  };
}

const DEFAULT_SETTINGS: AISettings = {
  language: "Auto",
  tone: "Casual",
  customInstructions: "",
  focusAreas: [],
  groundedMode: false,
  answerMode: "Evidence-heavy",
  useConversationMemory: true,
  countMode: "whole_word",
  companionMode: true,
  modelRouting: {},
};

interface BookEntry {
  id: string;
  title: string;
  filename: string;
  wordCount: number;
  addedAt: string;
  hasCover?: boolean;
  author?: string;
  fileType?: string;
  seriesId?: string;
  /** Reading / publication order within the series (supports .5 novellas). */
  seriesOrder?: number;
  isbn?: string;
  publishedYear?: number;
}

export interface SeriesEntry {
  id: string;
  name: string;
  bookIds: string[];
  createdAt: string;
}

interface BookCatalog {
  books: BookEntry[];
  series: SeriesEntry[];
}

function normalizeIdentity(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Author key that treats "Alanson, Craig" and "Craig Alanson" as the same person. */
function normalizeAuthorKey(input: string): string {
  const parts = normalizeIdentity(input).split(/\s+/).filter(Boolean).sort();
  return parts.join(" ");
}

function ensureDataDir() {
  ensureDir(DATA_DIR);
  ensureDir(INDEX_DIR);
  ensureDir(COVERS_DIR);
  ensureDir(TEXTS_DIR);
  ensureDir(SPECIALISTS_DIR);
}

// --- Page-level text storage ---

export interface BookPage {
  label: string;
  text: string;
}

export interface BookSpecialistProfile {
  bookId: string;
  bookTitle: string;
  summary: string;
  keyTopics: string[];
  notableEntities: string[];
  styleNotes: string[];
  keyCharacters?: string[];
  keyLocations?: string[];
  glossary?: string[];
  timelineHighlights?: string[];
  updatedAt: string;
}

export function saveBookPages(bookId: string, pages: BookPage[]): void {
  ensureDataDir();
  writeFileSync(join(TEXTS_DIR, `${bookId}.json`), JSON.stringify(pages));
}

export function loadBookPages(bookId: string): BookPage[] | null {
  ensureDataDir();
  const p = join(TEXTS_DIR, `${bookId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function saveBookSpecialistProfile(profile: BookSpecialistProfile): void {
  ensureDataDir();
  writeFileSync(
    join(SPECIALISTS_DIR, `${profile.bookId}.json`),
    JSON.stringify(profile, null, 2)
  );
}

export function loadBookSpecialistProfile(bookId: string): BookSpecialistProfile | null {
  ensureDataDir();
  const p = join(SPECIALISTS_DIR, `${bookId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as BookSpecialistProfile;
  } catch {
    return null;
  }
}

export interface PageMatch {
  label: string;
  snippet: string;
}

function createSnippet(text: string, idx: number, len: number): string {
  const snippetStart = Math.max(0, idx - 60);
  const snippetEnd = Math.min(text.length, idx + len + 140);
  return (snippetStart > 0 ? "..." : "") +
    text.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim() +
    (snippetEnd < text.length ? "..." : "");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type CountMode = "whole_word" | "phrase" | "loose";

function countMatchesInText(text: string, keyword: string, mode: CountMode): number {
  const normalized = keyword.trim();
  if (!normalized) return 0;
  if (mode === "loose") {
    let count = 0;
    const lowerText = text.toLowerCase();
    const lowerKeyword = normalized.toLowerCase();
    let startIdx = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerKeyword, startIdx);
      if (idx === -1) break;
      count++;
      startIdx = idx + lowerKeyword.length;
    }
    return count;
  }
  if (mode === "phrase") {
    const re = new RegExp(escapeRegex(normalized), "gi");
    return (text.match(re) || []).length;
  }
  const re = new RegExp(`\\b${escapeRegex(normalized).replace(/\\\s+/g, "\\\\s+")}\\b`, "gi");
  return (text.match(re) || []).length;
}

export interface ExactQuoteMatch {
  label: string;
  snippet: string;
  bookTitle: string;
}

export function searchBookKeyword(
  bookId: string,
  keywords: string[],
  maxMatches = 300
): PageMatch[] {
  const pages = loadBookPages(bookId);
  if (!pages) return [];

  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  const matches: PageMatch[] = [];

  for (const page of pages) {
    const lowerText = page.text.toLowerCase();
    for (const kw of lowerKeywords) {
      let startIdx = 0;
      while (true) {
        const idx = lowerText.indexOf(kw, startIdx);
        if (idx === -1) break;
        matches.push({ label: page.label, snippet: createSnippet(page.text, idx, kw.length) });
        if (matches.length >= maxMatches) return matches;
        startIdx = idx + kw.length;
      }
    }
  }

  return matches;
}

export function countBookKeywordMentions(
  bookId: string,
  keyword: string,
  mode: CountMode = "whole_word"
): number {
  const pages = loadBookPages(bookId);
  if (!pages) return 0;
  return pages.reduce((sum, page) => sum + countMatchesInText(page.text, keyword, mode), 0);
}

export function countAllBooksKeywordMentions(
  keyword: string,
  mode: CountMode = "whole_word"
): Array<{ bookId: string; bookTitle: string; count: number }> {
  const catalog = loadCatalog();
  const rows = catalog.books.map((book) => ({
    bookId: book.id,
    bookTitle: book.title,
    count: countBookKeywordMentions(book.id, keyword, mode),
  }));
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
}

export function countSeriesKeywordMentions(
  seriesId: string,
  keyword: string,
  mode: CountMode = "whole_word"
): Array<{ bookId: string; bookTitle: string; count: number }> {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];
  const rows = catalog.books
    .filter((book) => series.bookIds.includes(book.id))
    .map((book) => ({
      bookId: book.id,
      bookTitle: book.title,
      count: countBookKeywordMentions(book.id, keyword, mode),
    }));
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
}

export function searchAllBooksKeyword(
  keywords: string[],
  maxMatches = 500
): (PageMatch & { bookTitle: string })[] {
  const catalog = loadCatalog();
  const allMatches: (PageMatch & { bookTitle: string })[] = [];

  for (const book of catalog.books) {
    const remaining = Math.max(0, maxMatches - allMatches.length);
    if (remaining <= 0) break;
    const bookMatches = searchBookKeyword(book.id, keywords, remaining);
    for (const m of bookMatches) {
      allMatches.push({ ...m, bookTitle: book.title });
    }
  }

  return allMatches;
}

export function searchSeriesKeyword(
  seriesId: string,
  keywords: string[],
  maxMatches = 400
): (PageMatch & { bookTitle: string })[] {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];

  const booksInSeries = catalog.books.filter((b) => series.bookIds.includes(b.id));
  const matches: (PageMatch & { bookTitle: string })[] = [];

  for (const book of booksInSeries) {
    const remaining = Math.max(0, maxMatches - matches.length);
    if (remaining <= 0) break;
    const bookMatches = searchBookKeyword(book.id, keywords, remaining);
    for (const m of bookMatches) {
      matches.push({ ...m, bookTitle: book.title });
    }
  }

  return matches;
}

export function searchExactQuoteInBook(
  bookId: string,
  quote: string,
  maxMatches = 40
): PageMatch[] {
  const pages = loadBookPages(bookId);
  if (!pages) return [];

  const cleanedQuote = quote.trim();
  if (!cleanedQuote) return [];

  const lowerQuote = cleanedQuote.toLowerCase();
  const quoteTokens = cleanedQuote.match(/[A-Za-z0-9]+/g) || [];
  const fuzzyRegex =
    quoteTokens.length >= 4
      ? new RegExp(quoteTokens.map((w) => escapeRegex(w)).join("[\\W_]+"), "i")
      : null;

  const matches: PageMatch[] = [];
  for (const page of pages) {
    const lowerText = page.text.toLowerCase();
    const exactIdx = lowerText.indexOf(lowerQuote);
    if (exactIdx !== -1) {
      matches.push({
        label: page.label,
        snippet: createSnippet(page.text, exactIdx, cleanedQuote.length),
      });
      if (matches.length >= maxMatches) break;
      continue;
    }
    if (fuzzyRegex) {
      const fuzzy = fuzzyRegex.exec(page.text);
      if (fuzzy?.index !== undefined) {
        matches.push({
          label: page.label,
          snippet: createSnippet(page.text, fuzzy.index, fuzzy[0].length),
        });
        if (matches.length >= maxMatches) break;
      }
    }
  }
  return matches;
}

export function searchExactQuoteAllBooks(
  quote: string,
  maxMatches = 80
): ExactQuoteMatch[] {
  const catalog = loadCatalog();
  const allMatches: ExactQuoteMatch[] = [];
  for (const book of catalog.books) {
    const remaining = Math.max(0, maxMatches - allMatches.length);
    if (remaining <= 0) break;
    const matches = searchExactQuoteInBook(book.id, quote, remaining);
    for (const m of matches) {
      allMatches.push({
        label: m.label,
        snippet: m.snippet,
        bookTitle: book.title,
      });
    }
  }
  return allMatches;
}

export function searchExactQuoteInSeries(
  seriesId: string,
  quote: string,
  maxMatches = 60
): ExactQuoteMatch[] {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];
  const allMatches: ExactQuoteMatch[] = [];
  const booksInSeries = catalog.books.filter((b) => series.bookIds.includes(b.id));
  for (const book of booksInSeries) {
    const remaining = Math.max(0, maxMatches - allMatches.length);
    if (remaining <= 0) break;
    const matches = searchExactQuoteInBook(book.id, quote, remaining);
    for (const m of matches) {
      allMatches.push({
        label: m.label,
        snippet: m.snippet,
        bookTitle: book.title,
      });
    }
  }
  return allMatches;
}

function loadCatalog(): BookCatalog {
  ensureDataDir();
  if (!existsSync(CATALOG_FILE)) return { books: [], series: [] };
  const parsed = JSON.parse(readFileSync(CATALOG_FILE, "utf-8")) as Partial<BookCatalog>;
  return {
    books: parsed.books || [],
    series: parsed.series || [],
  };
}

function saveCatalog(catalog: BookCatalog) {
  ensureDataDir();
  writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

export function loadSettings(): AISettings {
  ensureDataDir();
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Partial<AISettings>;
    return {
      language: parsed.language || DEFAULT_SETTINGS.language,
      tone: parsed.tone || DEFAULT_SETTINGS.tone,
      customInstructions: parsed.customInstructions || DEFAULT_SETTINGS.customInstructions,
      focusAreas: Array.isArray(parsed.focusAreas) ? parsed.focusAreas.map(String) : [],
      groundedMode: Boolean(parsed.groundedMode),
      answerMode:
        parsed.answerMode === "Quick" ||
        parsed.answerMode === "Evidence-heavy" ||
        parsed.answerMode === "Exact count" ||
        parsed.answerMode === "Compare books"
          ? parsed.answerMode
          : DEFAULT_SETTINGS.answerMode,
      useConversationMemory:
        typeof parsed.useConversationMemory === "boolean"
          ? parsed.useConversationMemory
          : DEFAULT_SETTINGS.useConversationMemory,
      countMode:
        parsed.countMode === "whole_word" || parsed.countMode === "phrase" || parsed.countMode === "loose"
          ? parsed.countMode
          : DEFAULT_SETTINGS.countMode,
      companionMode:
        typeof parsed.companionMode === "boolean"
          ? parsed.companionMode
          : DEFAULT_SETTINGS.companionMode,
      modelRouting:
        parsed.modelRouting && typeof parsed.modelRouting === "object"
          ? {
              specialistModelId: parsed.modelRouting.specialistModelId
                ? String(parsed.modelRouting.specialistModelId)
                : undefined,
              orchestratorModelId: parsed.modelRouting.orchestratorModelId
                ? String(parsed.modelRouting.orchestratorModelId)
                : undefined,
              extractionModelId: parsed.modelRouting.extractionModelId
                ? String(parsed.modelRouting.extractionModelId)
                : undefined,
            }
          : {},
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AISettings): void {
  ensureDataDir();
  const normalized: AISettings = {
    language: settings.language || DEFAULT_SETTINGS.language,
    tone: settings.tone || DEFAULT_SETTINGS.tone,
    customInstructions: settings.customInstructions || "",
    focusAreas: Array.isArray(settings.focusAreas) ? settings.focusAreas.map(String) : [],
    groundedMode: Boolean(settings.groundedMode),
    answerMode:
      settings.answerMode === "Quick" ||
      settings.answerMode === "Evidence-heavy" ||
      settings.answerMode === "Exact count" ||
      settings.answerMode === "Compare books"
        ? settings.answerMode
        : DEFAULT_SETTINGS.answerMode,
    useConversationMemory:
      typeof settings.useConversationMemory === "boolean"
        ? settings.useConversationMemory
        : DEFAULT_SETTINGS.useConversationMemory,
    countMode:
      settings.countMode === "whole_word" || settings.countMode === "phrase" || settings.countMode === "loose"
        ? settings.countMode
        : DEFAULT_SETTINGS.countMode,
    companionMode:
      typeof settings.companionMode === "boolean"
        ? settings.companionMode
        : DEFAULT_SETTINGS.companionMode,
    modelRouting: {
      specialistModelId: settings.modelRouting?.specialistModelId || undefined,
      orchestratorModelId: settings.modelRouting?.orchestratorModelId || undefined,
      extractionModelId: settings.modelRouting?.extractionModelId || undefined,
    },
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(normalized, null, 2));
}

function createIndex(): LocalDocumentIndex {
  ensureDataDir();
  return new LocalDocumentIndex({
    folderPath: INDEX_DIR,
    embeddings: new BedrockEmbeddings(),
    chunkingConfig: {
      chunkSize: 512,
      chunkOverlap: 64,
    },
  });
}

let _index: LocalDocumentIndex | null = null;

async function getIndex(): Promise<LocalDocumentIndex> {
  if (!_index) {
    _index = createIndex();
    if (!(await _index.isCatalogCreated())) {
      await _index.createIndex({ version: 1 });
    }
  }
  return _index;
}

export function saveCover(bookId: string, imageBuffer: Buffer, mimeType: string): boolean {
  ensureDataDir();
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : "jpg";
  const coverPath = join(COVERS_DIR, `${bookId}.${ext}`);
  writeFileSync(coverPath, imageBuffer);
  return true;
}

export function getCoverPath(bookId: string): string | null {
  ensureDataDir();
  for (const ext of ["jpg", "png", "gif", "jpeg", "webp"]) {
    const p = join(COVERS_DIR, `${bookId}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function findBookByFilename(filename: string): BookEntry | undefined {
  const catalog = loadCatalog();
  return catalog.books.find(
    (b) => b.filename.toLowerCase() === filename.toLowerCase()
  );
}

export async function addBook(
  title: string,
  filename: string,
  text: string,
  wordCount: number,
  opts: { hasCover?: boolean; author?: string; fileType?: string; seriesId?: string } = {}
): Promise<BookEntry> {
  const id = `book-${Date.now()}`;
  const index = await getIndex();

  await index.upsertDocument(id, text, "book", { title, bookId: id });

  const catalog = loadCatalog();
  const entry: BookEntry = {
    id,
    title,
    filename,
    wordCount,
    addedAt: new Date().toISOString(),
    hasCover: opts.hasCover,
    author: opts.author,
    fileType: opts.fileType,
    seriesId: opts.seriesId,
  };
  catalog.books.push(entry);
  if (opts.seriesId) {
    const series = catalog.series.find((s) => s.id === opts.seriesId);
    if (series && !series.bookIds.includes(entry.id)) {
      series.bookIds.push(entry.id);
    }
  }
  saveCatalog(catalog);

  return entry;
}

function deleteCoverFiles(bookId: string): void {
  for (const ext of ["jpg", "png", "gif", "jpeg", "webp"]) {
    const p = join(COVERS_DIR, `${bookId}.${ext}`);
    if (existsSync(p)) unlinkSync(p);
  }
}

export async function deleteBook(bookId: string): Promise<void> {
  const index = await getIndex();
  await index.deleteDocument(bookId);

  const catalog = loadCatalog();
  catalog.books = catalog.books.filter((b) => b.id !== bookId);
  for (const series of catalog.series) {
    series.bookIds = series.bookIds.filter((id) => id !== bookId);
  }
  catalog.series = catalog.series.filter((s) => s.bookIds.length > 0);
  saveCatalog(catalog);

  const textPath = join(TEXTS_DIR, `${bookId}.json`);
  if (existsSync(textPath)) unlinkSync(textPath);
  const specialistPath = join(SPECIALISTS_DIR, `${bookId}.json`);
  if (existsSync(specialistPath)) unlinkSync(specialistPath);
  deleteCoverFiles(bookId);
}

export async function deleteAllBooks(): Promise<number> {
  const ids = listBooks().map((b) => b.id);
  for (const id of ids) {
    await deleteBook(id);
  }
  return ids.length;
}

export function findBooksByTitleQuery(query: string): BookEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return listBooks().filter((b) => {
    const title = b.title.toLowerCase();
    const fileTitle = b.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").toLowerCase();
    return title.includes(q) || fileTitle.includes(q) || q.includes(title);
  });
}

export function listBooks(): BookEntry[] {
  return loadCatalog().books;
}

export function getBookById(bookId: string): BookEntry | null {
  return loadCatalog().books.find((b) => b.id === bookId) || null;
}

export function listSeries(): SeriesEntry[] {
  return loadCatalog().series;
}

export function saveSeries(entry: { id?: string; name: string; bookIds: string[] }): SeriesEntry {
  const catalog = loadCatalog();
  const normalizedBookIds = [...new Set(entry.bookIds)];
  const requestedName = cleanSeriesDisplayName(entry.name.trim()) || entry.name.trim();
  const requestedKey = normalizeSeriesKey(requestedName);
  const sameNameExisting = catalog.series.find((s) => {
    if (s.id === entry.id) return false;
    const key = normalizeSeriesKey(cleanSeriesDisplayName(s.name) || s.name);
    return key === requestedKey || seriesKeysLooselyMatch(key, requestedKey);
  });

  if (!entry.id && sameNameExisting) {
    sameNameExisting.name = preferSeriesDisplayName(sameNameExisting.name, requestedName);
    sameNameExisting.bookIds = [...new Set([...sameNameExisting.bookIds, ...normalizedBookIds])];
    for (const book of catalog.books) {
      if (sameNameExisting.bookIds.includes(book.id)) {
        book.seriesId = sameNameExisting.id;
      }
    }
    saveCatalog(catalog);
    return sameNameExisting;
  }

  if (entry.id) {
    const existing = catalog.series.find((s) => s.id === entry.id);
    if (existing) {
      existing.name = requestedName;
      existing.bookIds = normalizedBookIds;
      for (const book of catalog.books) {
        if (normalizedBookIds.includes(book.id)) {
          book.seriesId = existing.id;
        } else if (book.seriesId === existing.id) {
          book.seriesId = undefined;
        }
      }
      saveCatalog(catalog);
      return existing;
    }
  }

  const created: SeriesEntry = {
    id: `series-${Date.now()}`,
    name: requestedName,
    bookIds: normalizedBookIds,
    createdAt: new Date().toISOString(),
  };
  catalog.series.push(created);
  for (const book of catalog.books) {
    if (normalizedBookIds.includes(book.id)) {
      book.seriesId = created.id;
    }
  }
  saveCatalog(catalog);
  return created;
}

export function deleteSeries(seriesId: string): void {
  const catalog = loadCatalog();
  catalog.series = catalog.series.filter((s) => s.id !== seriesId);
  for (const book of catalog.books) {
    if (book.seriesId === seriesId) {
      book.seriesId = undefined;
    }
  }
  saveCatalog(catalog);
}

export async function reconcileLibrarySeries(opts?: {
  allowRemote?: boolean;
}): Promise<{
  updatedBooks: number;
  createdSeries: number;
  mergedSeries: number;
  removedSeries: number;
  lookedUp: number;
  touchedSeries: number;
  orderedBooks: number;
}> {
  const allowRemote = opts?.allowRemote !== false;
  const catalog = loadCatalog();

  // 1) Resolve a series name per book (local heuristics + optional Open Library).
  const hints = new Map<string, string>(); // bookId -> series display name
  let lookedUp = 0;
  for (const book of catalog.books) {
    const hint = await resolveSeriesName({
      filename: book.filename,
      title: book.title,
      author: book.author,
      allowRemote,
    });
    if (hint) {
      hints.set(book.id, hint.name);
      if (hint.source === "openlibrary" || hint.source === "merged") lookedUp++;
    }
    if (allowRemote) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // 2) Also fold existing series names that are just "Series Book N" / "EPUB" into cleaned keys.
  const groups = new Map<string, { displayName: string; bookIds: Set<string> }>();

  const addToGroup = (name: string, bookId: string) => {
    const cleaned = cleanSeriesDisplayName(name) || name;
    const key = normalizeSeriesKey(cleaned);
    if (!key || key.length < 3) return;
    const existing = groups.get(key);
    if (existing) {
      existing.displayName = preferSeriesDisplayName(existing.displayName, cleaned);
      existing.bookIds.add(bookId);
    } else {
      groups.set(key, { displayName: cleaned, bookIds: new Set([bookId]) });
    }
  };

  for (const book of catalog.books) {
    const fromHint = hints.get(book.id);
    if (fromHint) {
      addToGroup(fromHint, book.id);
      continue;
    }
    // Fall back: if already in a series, try cleaning that series name
    if (book.seriesId) {
      const s = catalog.series.find((x) => x.id === book.seriesId);
      if (s) {
        const cleaned = cleanSeriesDisplayName(s.name);
        if (cleaned) addToGroup(cleaned, book.id);
      }
    }
  }

  // Attach stragglers whose title/filename contains an existing series key
  // (e.g. "Fallout Expeditionary Force Bo..." → Expeditionary Force).
  for (const book of catalog.books) {
    if (hints.has(book.id)) continue;
    const blob = normalizeSeriesKey(`${book.title} ${book.filename}`);
    if (!blob) continue;
    for (const [key, group] of groups) {
      if (key.length < 8) continue;
      if (blob.includes(key) || key.includes(blob.slice(0, Math.min(blob.length, key.length)))) {
        // Prefer real containment of the series key inside the book blob
        if (blob.includes(key)) {
          group.bookIds.add(book.id);
          hints.set(book.id, group.displayName);
          break;
        }
      }
    }
  }

  // Only keep groups with 2+ books as series (solo "series" folders are noise)
  // Exception: if we already had a multi-book series key, keep membership even for growth.
  // Actually user wants all EF books together — even if only 1 matched remote, merge into EF group.
  // Keep groups with >= 1 book if key looks like a real series; drop format garbage.
  for (const [key, group] of [...groups.entries()]) {
    if (/^(epub|pdf|mobi|txt|kindle)$/i.test(group.displayName)) {
      groups.delete(key);
    }
  }

  let updatedBooks = 0;
  let createdSeries = 0;
  let mergedSeries = 0;
  const touchedSeries = new Set<string>();
  const usedSeriesIds = new Set<string>();

  // 3) For each group, find or create a target series (merge by normalized key).
  for (const [, group] of groups) {
    if (group.bookIds.size < 1) continue;

    const matching = catalog.series.filter(
      (s) => normalizeSeriesKey(cleanSeriesDisplayName(s.name) || s.name) === normalizeSeriesKey(group.displayName)
    );

    let target: SeriesEntry | undefined = matching.sort((a, b) => b.bookIds.length - a.bookIds.length)[0];
    if (!target) {
      // Also match if any existing series key contains / is contained
      target = catalog.series.find((s) => {
        const sk = normalizeSeriesKey(cleanSeriesDisplayName(s.name) || s.name);
        const gk = normalizeSeriesKey(group.displayName);
        return sk && gk && (sk === gk || (sk.length >= 8 && gk.length >= 8 && (sk.includes(gk) || gk.includes(sk))));
      });
    }

    if (!target) {
      target = {
        id: `series-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: group.displayName,
        bookIds: [],
        createdAt: new Date().toISOString(),
      };
      catalog.series.push(target);
      createdSeries++;
    } else {
      const preferred = preferSeriesDisplayName(target.name, group.displayName);
      if (target.name !== preferred) target.name = preferred;
      if (matching.length > 1) mergedSeries += matching.length - 1;
    }

    touchedSeries.add(target.id);
    usedSeriesIds.add(target.id);

    for (const bookId of group.bookIds) {
      const book = catalog.books.find((b) => b.id === bookId);
      if (!book) continue;
      if (book.seriesId !== target.id) updatedBooks++;
      book.seriesId = target.id;
      if (!target.bookIds.includes(book.id)) target.bookIds.push(book.id);
    }

    // Absorb other matching series into target
    for (const extra of matching) {
      if (extra.id === target.id) continue;
      for (const bookId of extra.bookIds) {
        const book = catalog.books.find((b) => b.id === bookId);
        if (!book) continue;
        book.seriesId = target.id;
        if (!target.bookIds.includes(bookId)) target.bookIds.push(bookId);
      }
      extra.bookIds = [];
    }
  }

  // 4b) Author majority vote: if most of an author's books already sit in one series,
  // pull remaining ungrouped titles by that author into it (covers OL gaps like Gateway).
  const authorSeriesVotes = new Map<string, Map<string, number>>();
  for (const book of catalog.books) {
    const authorKey = normalizeAuthorKey(book.author || "");
    if (!authorKey || !book.seriesId) continue;
    if (!authorSeriesVotes.has(authorKey)) authorSeriesVotes.set(authorKey, new Map());
    const votes = authorSeriesVotes.get(authorKey)!;
    votes.set(book.seriesId, (votes.get(book.seriesId) || 0) + 1);
  }
  for (const book of catalog.books) {
    if (book.seriesId) continue;
    const authorKey = normalizeAuthorKey(book.author || "");
    if (!authorKey) continue;
    const votes = authorSeriesVotes.get(authorKey);
    if (!votes || votes.size === 0) continue;
    const authorBookCount = catalog.books.filter(
      (b) => normalizeAuthorKey(b.author || "") === authorKey
    ).length;
    const [bestSeriesId, bestCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (bestCount >= 3 && bestCount / authorBookCount >= 0.5) {
      book.seriesId = bestSeriesId;
      updatedBooks++;
      const target = catalog.series.find((s) => s.id === bestSeriesId);
      if (target && !target.bookIds.includes(book.id)) target.bookIds.push(book.id);
      touchedSeries.add(bestSeriesId);
    }
  }

  // 5) Rebuild membership lists; resolve series order / ISBN; drop empty / garbage series.
  let orderedBooks = 0;
  for (const book of catalog.books) {
    const series = book.seriesId
      ? catalog.series.find((s) => s.id === book.seriesId)
      : undefined;
    const localOrder = resolveLocalSeriesOrder({
      title: book.title,
      filename: book.filename,
      author: book.author,
      seriesName: series?.name,
      seriesOrder: undefined, // recompute from title/known maps
    });
    if (localOrder != null && book.seriesOrder !== localOrder) {
      book.seriesOrder = localOrder;
      orderedBooks++;
    }

    if (allowRemote && (!book.isbn || !book.publishedYear)) {
      const meta = await lookupEditionMetaFromOpenLibrary(book.title, book.author);
      if (meta) {
        if (meta.isbn && !book.isbn) book.isbn = meta.isbn;
        if (meta.publishedYear && !book.publishedYear) {
          book.publishedYear = meta.publishedYear;
        }
        // If we still have no series order, fall back to publish year as a soft order
        if (book.seriesOrder == null && meta.publishedYear) {
          book.seriesOrder = meta.publishedYear;
          orderedBooks++;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  for (const series of catalog.series) {
    const members = catalog.books.filter((b) => b.seriesId === series.id);
    members.sort((a, b) =>
      compareSeriesBooks(
        { order: a.seriesOrder ?? null, year: a.publishedYear ?? null, title: a.title },
        { order: b.seriesOrder ?? null, year: b.publishedYear ?? null, title: b.title }
      )
    );
    series.bookIds = members.map((b) => b.id);
    const cleaned = cleanSeriesDisplayName(series.name);
    if (cleaned) series.name = cleaned;
  }

  const before = catalog.series.length;
  catalog.series = catalog.series.filter((s) => {
    if (s.bookIds.length === 0) return false;
    if (/^(epub|pdf|mobi|txt|kindle)$/i.test(s.name)) return false;
    return true;
  });
  const removedSeries = before - catalog.series.length;

  // Clear seriesId on books pointing at removed series
  const liveIds = new Set(catalog.series.map((s) => s.id));
  for (const book of catalog.books) {
    if (book.seriesId && !liveIds.has(book.seriesId)) {
      book.seriesId = undefined;
      updatedBooks++;
    }
  }

  saveCatalog(catalog);
  return {
    updatedBooks,
    createdSeries,
    mergedSeries,
    removedSeries,
    lookedUp,
    touchedSeries: touchedSeries.size,
    orderedBooks,
  };
}

/** @deprecated Use reconcileLibrarySeries — kept for older callers. */
export async function autoFixSeriesByAuthor(): Promise<{
  updatedBooks: number;
  createdSeries: number;
  touchedSeries: number;
}> {
  const result = await reconcileLibrarySeries({ allowRemote: true });
  return {
    updatedBooks: result.updatedBooks,
    createdSeries: result.createdSeries,
    touchedSeries: result.touchedSeries,
  };
}

export interface DuplicateGroup {
  key: string;
  books: BookEntry[];
}

export function listDuplicateBookGroups(): DuplicateGroup[] {
  const catalog = loadCatalog();
  const groups = new Map<string, BookEntry[]>();
  for (const book of catalog.books) {
    const key = `${normalizeIdentity(book.title)}::${normalizeIdentity(book.author || "")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(book);
  }
  return [...groups.entries()]
    .map(([key, books]) => ({ key, books }))
    .filter((g) => g.books.length > 1);
}

export async function mergeDuplicateBooks(
  primaryBookId: string,
  duplicateBookId: string
): Promise<{ kept: string; removed: string }> {
  if (primaryBookId === duplicateBookId) {
    throw new Error("Cannot merge the same book.");
  }

  const primary = getBookById(primaryBookId);
  const duplicate = getBookById(duplicateBookId);
  if (!primary || !duplicate) {
    throw new Error("Both books must exist to merge.");
  }

  const duplicateSeries = getSeriesForBook(duplicateBookId);
  if (duplicateSeries) {
    saveSeries({
      id: duplicateSeries.id,
      name: duplicateSeries.name,
      bookIds: [...new Set(duplicateSeries.bookIds.map((id) => (id === duplicateBookId ? primaryBookId : id)))],
    });
  }

  await deleteBook(duplicateBookId);
  return { kept: primaryBookId, removed: duplicateBookId };
}

export function getSeriesForBook(bookId: string): SeriesEntry | null {
  const catalog = loadCatalog();
  return catalog.series.find((s) => s.bookIds.includes(bookId)) || null;
}

export interface PassageResult {
  text: string;
  location: string;
}

function findPageForText(bookId: string, chunkText: string): string {
  const pages = loadBookPages(bookId);
  if (!pages) return "Unknown location";

  const needle = chunkText.slice(0, 80).replace(/\s+/g, " ").trim().toLowerCase();
  for (const page of pages) {
    if (page.text.toLowerCase().includes(needle)) {
      return page.label;
    }
  }

  const shortNeedle = chunkText.slice(0, 40).replace(/\s+/g, " ").trim().toLowerCase();
  for (const page of pages) {
    if (page.text.toLowerCase().includes(shortNeedle)) {
      return page.label;
    }
  }

  return "Unknown location";
}

export async function queryBook(
  bookId: string,
  query: string,
  maxChunks = 20
): Promise<PassageResult[]> {
  const index = await getIndex();
  const results = await index.queryDocuments(query, {
    maxDocuments: 1,
    maxChunks,
    filter: { bookId: { $eq: bookId } },
  });

  if (!results.length) return [];

  const sections = await results[0].renderSections(
    maxChunks * 512,
    1,
    true
  );

  return sections.map((s) => ({
    text: s.text,
    location: findPageForText(bookId, s.text),
  }));
}

// --- Chat history ---

const CHATS_DIR = join(DATA_DIR, "chats");

interface ChatEntry {
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  messages: {
    role: string;
    content: string;
    sources?: { book: string; excerpt: string; position?: string; bookId?: string }[];
  }[];
  updatedAt: string;
}

function ensureChatsDir() {
  ensureDataDir();
  if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true });
}

export function saveChat(chat: ChatEntry): void {
  ensureChatsDir();
  writeFileSync(join(CHATS_DIR, `${chat.id}.json`), JSON.stringify(chat, null, 2));
}

export function loadChat(chatId: string): ChatEntry | null {
  ensureChatsDir();
  const p = join(CHATS_DIR, `${chatId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function listChats(): Omit<ChatEntry, "messages">[] {
  ensureChatsDir();
  const files = existsSync(CHATS_DIR)
    ? readdirSync(CHATS_DIR).filter((f: string) => f.endsWith(".json"))
    : [];
  const chats: Omit<ChatEntry, "messages">[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(CHATS_DIR, file), "utf-8"));
      chats.push({
        id: raw.id,
        bookId: raw.bookId,
        bookTitle: raw.bookTitle,
        title: raw.title,
        updatedAt: raw.updatedAt,
      });
    } catch { /* skip corrupt files */ }
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteChat(chatId: string): void {
  ensureChatsDir();
  const p = join(CHATS_DIR, `${chatId}.json`);
  if (existsSync(p)) unlinkSync(p);
}

export async function queryAllBooks(
  query: string,
  maxChunks = 20
): Promise<{ bookTitle: string; text: string; location: string }[]> {
  const index = await getIndex();
  const catalog = loadCatalog();
  const bookMap = new Map(catalog.books.map((b) => [b.id, b]));

  const results = await index.queryDocuments(query, {
    maxDocuments: 10,
    maxChunks: Math.ceil(maxChunks / 2),
  });

  const passages: { bookTitle: string; text: string; location: string }[] = [];
  for (const doc of results) {
    const bookId = doc.uri;
    const book = bookMap.get(bookId);
    const title = book?.title || "Unknown book";

    const sections = await doc.renderSections(512 * 4, 1, true);
    for (const s of sections) {
      passages.push({
        bookTitle: title,
        text: s.text,
        location: findPageForText(bookId, s.text),
      });
    }
  }

  return passages.slice(0, maxChunks);
}

export async function querySeriesBooks(
  seriesId: string,
  query: string,
  maxChunks = 20
): Promise<{ bookTitle: string; text: string; location: string }[]> {
  const catalog = loadCatalog();
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return [];

  const booksInSeries = new Set(series.bookIds);
  const allResults = await queryAllBooks(query, maxChunks * 3);
  const titleToBookId = new Map(catalog.books.map((b) => [b.title, b.id]));
  const filtered = allResults.filter((r) => {
    const id = titleToBookId.get(r.bookTitle);
    return !!id && booksInSeries.has(id);
  });
  return filtered.slice(0, maxChunks);
}

export async function rebuildBookIndex(bookId: string): Promise<void> {
  const pages = loadBookPages(bookId);
  if (!pages?.length) return;
  const index = await getIndex();
  const merged = pages.map((p) => `[${p.label}]\n${p.text}`).join("\n\n");
  await index.upsertDocument(bookId, merged, "book", { bookId });
}
