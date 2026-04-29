import { LocalDocumentIndex } from "vectra";
import { BedrockEmbeddings } from "./bedrock-embeddings";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { homedir } from "os";

const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".whataboutthisbook");
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
  modelRouting?: {
    specialistModelId?: string;
    orchestratorModelId?: string;
    extractionModelId?: string;
  };
}

const DEFAULT_SETTINGS: AISettings = {
  language: "Auto",
  tone: "Scientific",
  customInstructions: "",
  focusAreas: [],
  groundedMode: false,
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

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
  if (!existsSync(COVERS_DIR)) mkdirSync(COVERS_DIR, { recursive: true });
  if (!existsSync(TEXTS_DIR)) mkdirSync(TEXTS_DIR, { recursive: true });
  if (!existsSync(SPECIALISTS_DIR)) mkdirSync(SPECIALISTS_DIR, { recursive: true });
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

  if (entry.id) {
    const existing = catalog.series.find((s) => s.id === entry.id);
    if (existing) {
      existing.name = entry.name;
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
    name: entry.name,
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
  messages: { role: string; content: string }[];
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
