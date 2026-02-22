import { LocalDocumentIndex } from "vectra";
import { OllamaEmbeddings } from "./ollama-embeddings";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".whataboutthisbook");
const INDEX_DIR = join(DATA_DIR, "index");
const COVERS_DIR = join(DATA_DIR, "covers");
const CATALOG_FILE = join(DATA_DIR, "books.json");

interface BookEntry {
  id: string;
  title: string;
  filename: string;
  wordCount: number;
  addedAt: string;
  hasCover?: boolean;
}

interface BookCatalog {
  books: BookEntry[];
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
  if (!existsSync(COVERS_DIR)) mkdirSync(COVERS_DIR, { recursive: true });
}

function loadCatalog(): BookCatalog {
  ensureDataDir();
  if (!existsSync(CATALOG_FILE)) return { books: [] };
  return JSON.parse(readFileSync(CATALOG_FILE, "utf-8"));
}

function saveCatalog(catalog: BookCatalog) {
  ensureDataDir();
  writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

function createIndex(): LocalDocumentIndex {
  ensureDataDir();
  return new LocalDocumentIndex({
    folderPath: INDEX_DIR,
    embeddings: new OllamaEmbeddings(),
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
  hasCover = false
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
    hasCover,
  };
  catalog.books.push(entry);
  saveCatalog(catalog);

  return entry;
}

export async function deleteBook(bookId: string): Promise<void> {
  const index = await getIndex();
  await index.deleteDocument(bookId);

  const catalog = loadCatalog();
  catalog.books = catalog.books.filter((b) => b.id !== bookId);
  saveCatalog(catalog);
}

export function listBooks(): BookEntry[] {
  return loadCatalog().books;
}

export async function queryBook(
  bookId: string,
  query: string,
  maxChunks = 8
): Promise<string[]> {
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
  return sections.map((s) => s.text);
}

export async function queryAllBooks(
  query: string,
  maxChunks = 10
): Promise<{ bookTitle: string; text: string }[]> {
  const index = await getIndex();
  const catalog = loadCatalog();
  const bookMap = new Map(catalog.books.map((b) => [b.id, b.title]));

  const results = await index.queryDocuments(query, {
    maxDocuments: 5,
    maxChunks: Math.ceil(maxChunks / 2),
  });

  const passages: { bookTitle: string; text: string }[] = [];
  for (const doc of results) {
    const docId = await index.getDocumentUri(
      (await index.getDocumentId(doc.uri)) || ""
    );
    const bookId = doc.uri;
    const title = bookMap.get(bookId) || "Unknown book";

    const sections = await doc.renderSections(512 * 3, 1, true);
    for (const s of sections) {
      passages.push({ bookTitle: title, text: s.text });
    }
  }

  return passages.slice(0, maxChunks);
}
