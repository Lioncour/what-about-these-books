import { listBooks, listSeries } from "@/lib/book-store";

export interface TitleHints {
  author?: string | null;
  seriesName?: string | null;
}

const FORMAT_TAG = /[\[(]\s*(?:epub|pdf|txt|mobi|azw3?|kindle|retail|ebook)\s*[\])]/gi;
const BOOK_NUMBER = "(?:book|bk|vol(?:ume)?|part|#)\\s*#?\\s*\\d+(?:\\.\\d+)?";
const DANGLING_TAIL = /\b(?:of|the|and|a|an|to|in|for|with|on|at|from)$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tidy(t: string): string {
  return t
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,.]+|[\s\-–—:,]+$/g, "")
    .trim();
}

/** Author and series of the catalog book carrying exactly this title, when there is one. */
function catalogHints(title: string): TitleHints {
  const book = listBooks().find((b) => b.title === title);
  if (!book) return {};
  const series = listSeries().find((s) => (book.seriesId ? s.id === book.seriesId : s.bookIds.includes(book.id)));
  return { author: book.author, seriesName: series?.name };
}

function stripSeries(t: string, seriesName: string): string {
  const words = seriesName.split(/\s+/).filter(Boolean).map(escapeRe);
  if (!words.length) return t;
  const name = words.join("\\s+");
  // "(Star Run Book 6)", "[Star Run]"
  let out = t.replace(new RegExp(`[\\[(]\\s*${name}\\b[^\\])]*[\\])]`, "gi"), " ");
  // "Star Run Book 6", "Star Run, #6", "Star Run 6"
  out = out.replace(new RegExp(`\\b${name}\\s*[,:\\-–—]?\\s*(?:${BOOK_NUMBER}|\\d+(?:\\.\\d+)?)(?!\\w)`, "gi"), " ");
  // "Title - Star Run", "Title: Star Run" (a bare trailing name needs a separator:
  // "Children of Dune" must survive in the series "Dune")
  out = out.replace(new RegExp(`\\s*[,:\\-–—]\\s*${name}\\s*$`, "i"), " ");
  return out;
}

function stripAuthor(t: string, author: string): string {
  const names = author.split(/[\s,]+/).filter((w) => w.length > 1).map(escapeRe);
  if (!names.length) return t;
  const run = `(?:\\b(?:${names.join("|")})\\b[\\s,]*)`;
  // "… by Jo Vance" at the end
  let out = t.replace(new RegExp(`\\s+by\\s+${run}+\\s*$`, "i"), " ");
  if (names.length >= 2) {
    // The author's names as a run in any order ("Jo Vance", "vance jo", "Vance, Jo"), at either end.
    out = out
      .replace(new RegExp(`[\\s\\-–—:,]*${run}{2,}\\s*$`, "i"), " ")
      .replace(new RegExp(`^\\s*${run}{2,}[\\s\\-–—:,]*`, "i"), " ");
  }
  // "The Autobiography of Benjamin Franklin" keeps its author.
  return DANGLING_TAIL.test(tidy(out)) ? t : out;
}

/**
 * Title as shown in answers, sources and the SCOPE line. Titles taken from filenames
 * carry format tags, "(Series Book N)" tails and the author's name; those are removed
 * using the catalog's author and series for that book (or the given hints). Without
 * either, only format tags and stray separators go. Never returns an empty string.
 */
export function cleanBookDisplayTitle(title: string, hints?: TitleHints): string {
  const known = hints ?? catalogHints(title);
  let t = title.replace(/\s+/g, " ").trim().replace(FORMAT_TAG, " ");
  if (known.seriesName?.trim()) t = stripSeries(t, known.seriesName.trim());
  if (known.author?.trim()) t = stripAuthor(t, known.author.trim());
  t = tidy(t);
  return t || title;
}
