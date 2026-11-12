import { listBooks, loadBookPages, getBookById, type BookPage } from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";

export type PassageLookup = {
  bookId: string;
  bookTitle: string;
  position: string;
  text: string;
  /** How the page was found: the citation's own words, its label, or neither (start of book). */
  matchedBy: "excerpt" | "label" | "start";
  /** Where the cited words sit in `text` (only when matchedBy is "excerpt"). */
  matchStart?: number;
  matchLength?: number;
  /** Nearby pages for context in the reader */
  neighbors: Array<{ position: string; preview: string }>;
};

type BookRef = { id: string; title: string };

function normalizeTitle(s: string): string {
  return cleanBookDisplayTitle(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Books a citation's title may mean, best first. A saved citation can carry a title
 * from before the library was tidied ("Craig Alanson Columbus Day"), so containment
 * counts, longest title first so "Black Ops" wins over a shorter accidental match.
 */
export function rankBooksByTitle(title: string, books: BookRef[]): BookRef[] {
  const want = normalizeTitle(title);
  if (!want) return [];
  const exact: BookRef[] = [];
  const partial: Array<{ book: BookRef; len: number }> = [];
  for (const book of books) {
    const have = normalizeTitle(book.title);
    if (!have) continue;
    if (have === want) exact.push(book);
    else if (` ${want} `.includes(` ${have} `) || ` ${have} `.includes(` ${want} `)) {
      partial.push({ book, len: have.length });
    }
  }
  partial.sort((a, b) => b.len - a.len);
  return [...exact, ...partial.map((p) => p.book)];
}

/** Whitespace collapsed; this is the text the reader shows, so offsets refer to it. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Same length as the input: lower case, typographic quotes and dashes made plain. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, "-");
}

/**
 * Search strings from a citation, most specific first. Citations are often trimmed
 * with ellipses or stitched from two places, and models wrap them in quotes, so the
 * longest unbroken run is tried first, then its opening words.
 */
export function excerptProbes(excerpt: string): string[] {
  const runs = fold(collapse(excerpt))
    .split(/\.{3,}|…|\[[^\]]*\]/)
    .map((r) => r.replace(/^["'\s]+|["'\s]+$/g, "").trim())
    .filter((r) => r.length >= 12)
    .sort((a, b) => b.length - a.length);
  const probes: string[] = [];
  for (const run of runs.slice(0, 3)) {
    probes.push(run);
    for (const n of [120, 60, 30]) {
      if (run.length > n) {
        // cut at a word boundary so a half word doesn't block the match
        const cut = run.slice(0, n).replace(/\s+\S*$/, "");
        if (cut.length >= 12) probes.push(cut);
      }
    }
  }
  return [...new Set(probes)];
}

/** The page holding the citation's words, with the match position in the collapsed text. */
function findExcerptInPages(
  pages: BookPage[],
  excerpt: string
): { index: number; start: number; length: number } | null {
  const probes = excerptProbes(excerpt);
  if (!probes.length) return null;
  const folded = pages.map((p) => fold(collapse(p.text)));
  for (const probe of probes) {
    for (let i = 0; i < folded.length; i++) {
      const at = folded[i].indexOf(probe);
      if (at >= 0) {
        // A citation cut mid-word ("full of jun…") highlights to the end of that word.
        let end = at + probe.length;
        while (end < folded[i].length && /[\p{L}\p{N}'-]/u.test(folded[i][end])) end++;
        return { index: i, start: at, length: end - at };
      }
    }
  }
  return null;
}

/**
 * The page a label means. "Chapter 1" must not match "Chapter 10", and a model's
 * free-text position ("Chapter 10 (SKIPPY) / later context") still names chapter 10.
 */
export function findPageIndexByLabel(pages: BookPage[], position: string): number {
  const want = position.trim().toLowerCase();
  if (!want) return -1;
  const labels = pages.map((p) => p.label.toLowerCase());
  const exact = labels.indexOf(want);
  if (exact >= 0) return exact;

  const num = want.match(/\b(chapter|page|section|part)\s+(\d+)\b/);
  if (num) {
    const re = new RegExp(`^${num[1]}\\s+${num[2]}\\b`);
    const byNumber = labels.findIndex((l) => re.test(l));
    if (byNumber >= 0) return byNumber;
  }
  for (const word of ["prologue", "epilogue", "foreword", "afterword", "introduction"]) {
    if (new RegExp(`\\b${word}\\b`).test(want)) {
      const named = labels.findIndex((l) => l.startsWith(word));
      if (named >= 0) return named;
    }
  }
  // whole-label containment only: "chapter 1" inside "chapter 10 · skippy" is not a match
  const bounded = (hay: string, needle: string) =>
    needle.length >= 4 && new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}($|[^a-z0-9])`).test(hay);
  return labels.findIndex((l) => bounded(l, want) || bounded(want, l));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateBooks(opts: { bookId?: string | null; book?: string | null }): BookRef[] {
  if (opts.bookId) {
    const byId = getBookById(opts.bookId);
    if (byId) return [byId];
  }
  return rankBooksByTitle(opts.book || "", listBooks());
}

/**
 * Load full chapter/page text for the inline passage reader.
 *
 * Order of trust: the book id, then the citation's own words (they survive a retitle
 * or a relabel of the library, which stored labels and titles do not), then the label.
 */
export function lookupPassage(opts: {
  bookId?: string | null;
  book?: string | null;
  position?: string | null;
  excerpt?: string | null;
}): PassageLookup | null {
  const candidates = candidateBooks(opts);
  const excerpt = (opts.excerpt || "").trim();

  let book: BookRef | null = null;
  let pages: BookPage[] | null = null;
  let idx = -1;
  let match: { start: number; length: number } | null = null;

  if (excerpt) {
    // Named candidates first; if the title resolves to nothing, the words can still
    // identify the book.
    const pool = candidates.length ? candidates : listBooks();
    for (const candidate of pool) {
      const candidatePages = loadBookPages(candidate.id);
      if (!candidatePages?.length) continue;
      const hit = findExcerptInPages(candidatePages, excerpt);
      if (hit) {
        book = candidate;
        pages = candidatePages;
        idx = hit.index;
        match = { start: hit.start, length: hit.length };
        break;
      }
    }
  }

  let matchedBy: PassageLookup["matchedBy"] = "excerpt";
  if (!book || !pages) {
    book = candidates[0] || null;
    if (!book) return null;
    pages = loadBookPages(book.id);
    if (!pages?.length) return null;
    idx = findPageIndexByLabel(pages, opts.position || "");
    matchedBy = idx >= 0 ? "label" : "start";
    if (idx < 0) idx = 0;
  }

  const page = pages[idx];
  const neighbors: PassageLookup["neighbors"] = [];
  for (const i of [idx - 1, idx + 1]) {
    if (i < 0 || i >= pages.length) continue;
    neighbors.push({
      position: pages[i].label,
      preview: collapse(pages[i].text).slice(0, 160),
    });
  }

  return {
    bookId: book.id,
    bookTitle: cleanBookDisplayTitle(book.title),
    position: page.label,
    text: collapse(page.text),
    matchedBy,
    ...(match ? { matchStart: match.start, matchLength: match.length } : {}),
    neighbors,
  };
}
