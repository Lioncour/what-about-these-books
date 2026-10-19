import { listBooks, loadBookPages, getBookById, type BookPage } from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/passage-find";

export type PassageLookup = {
  bookId: string;
  bookTitle: string;
  position: string;
  text: string;
  /** Nearby pages for context in the reader */
  neighbors: Array<{ position: string; preview: string }>;
};

function normalizeTitle(s: string): string {
  return cleanBookDisplayTitle(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveBookId(opts: { bookId?: string | null; book?: string | null }): string | null {
  if (opts.bookId) {
    const byId = getBookById(opts.bookId);
    if (byId) return byId.id;
  }
  const title = (opts.book || "").trim();
  if (!title) return null;
  const want = normalizeTitle(title);
  const books = listBooks();
  const exact = books.find((b) => normalizeTitle(b.title) === want);
  if (exact) return exact.id;
  const partial = books.find(
    (b) => normalizeTitle(b.title).includes(want) || want.includes(normalizeTitle(b.title))
  );
  return partial?.id || null;
}

function findPageIndex(pages: BookPage[], position: string): number {
  const want = position.trim().toLowerCase();
  if (!want) return 0;
  const exact = pages.findIndex((p) => p.label.toLowerCase() === want);
  if (exact >= 0) return exact;
  const fuzzy = pages.findIndex(
    (p) => p.label.toLowerCase().includes(want) || want.includes(p.label.toLowerCase())
  );
  return fuzzy >= 0 ? fuzzy : 0;
}

/** Load full chapter/page text for the inline passage reader. */
export function lookupPassage(opts: {
  bookId?: string | null;
  book?: string | null;
  position?: string | null;
}): PassageLookup | null {
  const bookId = resolveBookId(opts);
  if (!bookId) return null;
  const book = getBookById(bookId);
  if (!book) return null;
  const pages = loadBookPages(bookId);
  if (!pages?.length) return null;

  const idx = findPageIndex(pages, opts.position || "");
  const page = pages[idx];
  const neighbors: PassageLookup["neighbors"] = [];
  for (const i of [idx - 1, idx + 1]) {
    if (i < 0 || i >= pages.length) continue;
    neighbors.push({
      position: pages[i].label,
      preview: pages[i].text.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }

  return {
    bookId: book.id,
    bookTitle: cleanBookDisplayTitle(book.title),
    position: page.label,
    text: page.text.replace(/\s+/g, " ").trim(),
    neighbors,
  };
}
