import { loadBookPages, listBooks, listSeries, getBookById } from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/passage-find";
import { normalizeUserQuestion } from "@/lib/chat/intent";
import type { ChatSource } from "@/lib/chat/types";

export type ThemeHit = {
  label: string; // e.g. Star Trek
  bookId: string;
  bookTitle: string;
  position: string;
  snippet: string;
};

// Prefer multi-word franchise names — bare words like "enterprise" / "007" / "marvel" false-positive hard.
const POP_CULTURE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "Star Trek", re: /\bstar\s*trek\b|\bklingon\b|\bspock\b/i },
  { label: "Star Wars", re: /\bstar\s*wars\b|\bdarth\s+vader\b|\bluke\s+skywalker\b|\bdeath\s+star\b|\bempire\s+strikes\s+back\b/i },
  { label: "Stargate", re: /\bstargate\b/i },
  { label: "James Bond", re: /\bjames\s+bond\b/i },
  { label: "Shakespeare", re: /\bshakespeare\b/i },
  { label: "Hollywood / movies", re: /\bhollywood\s+movie\b|\bmovie\s+bullshit\b/i },
  { label: "Willy Wonka", re: /\bwilly\s+wonka\b|\bchocolate\s+factory\b/i },
  { label: "Harry Potter", re: /\bharry\s+potter\b|\bhogwarts\b|\bvoldemort\b/i },
  { label: "Lord of the Rings", re: /\blord\s+of\s+the\s+rings\b|\bmiddle[- ]earth\b/i },
  { label: "Doctor Who", re: /\bdoctor\s+who\b|\bdr\.?\s*who\b|\btardis\b/i },
  { label: "Battlestar Galactica", re: /\bbattlestar\b/i },
  { label: "Firefly", re: /\bfirefly\b/i },
  { label: "Indiana Jones", re: /\bindiana\s+jones\b/i },
  { label: "Monty Python", re: /\bmonty\s+python\b/i },
  { label: "Iron Man / Marvel", re: /\biron\s+man\b|\bthe\s+avengers\b/i },
  { label: "Mickey Mouse", re: /\bmickey\s+mouse\b/i },
  { label: "The Matrix", re: /\bthe\s+matrix\b/i },
  { label: "Game of Thrones", re: /\bgame\s+of\s+thrones\b|\bwesteros\b/i },
  { label: "Asimov", re: /\basimov\b/i },
  { label: "Heinlein", re: /\bheinlein\b/i },
];

function resolveBooks(bookId: string) {
  if (bookId.startsWith("series:")) {
    const series = listSeries().find((s) => s.id === bookId.slice("series:".length));
    if (!series) return listBooks();
    return listBooks().filter((b) => series.bookIds.includes(b.id));
  }
  if (bookId !== "all") {
    const one = getBookById(bookId);
    return one ? [one] : [];
  }
  return listBooks();
}

function windowAround(text: string, index: number, radius = 220): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export function looksLikePopCultureSurvey(question: string): boolean {
  const text = normalizeUserQuestion(question).toLowerCase();
  return /\bpop culture\b|\bmovies?\b|\bfilms?\b|\btv\b|\btelevision\b|\bcomics?\b|\breferences? to\b/.test(
    text
  );
}

/** Scan indexed text for known movie/TV/book shout-outs. */
export function findPopCultureReferences(opts: {
  bookId?: string;
  maxHits?: number;
}): ThemeHit[] {
  const books = resolveBooks(opts.bookId || "all");
  const maxHits = opts.maxHits ?? 12;
  const hits: ThemeHit[] = [];
  const seenLabelBook = new Set<string>();

  for (const book of books) {
    const pages = loadBookPages(book.id);
    if (!pages) continue;
    for (const page of pages) {
      for (const cue of POP_CULTURE_PATTERNS) {
        const m = page.text.match(cue.re);
        if (!m || m.index == null) continue;
        const key = `${cue.label}|${book.id}`;
        // One example per label per book keeps the answer readable
        if (seenLabelBook.has(key)) continue;
        seenLabelBook.add(key);
        hits.push({
          label: cue.label,
          bookId: book.id,
          bookTitle: cleanBookDisplayTitle(book.title),
          position: page.label,
          snippet: windowAround(page.text, m.index, 240),
        });
        if (hits.length >= maxHits * 3) break;
      }
      if (hits.length >= maxHits * 3) break;
    }
    if (hits.length >= maxHits * 3) break;
  }

  // Prefer diversity of labels
  const byLabel = new Map<string, ThemeHit>();
  for (const hit of hits) {
    if (!byLabel.has(hit.label)) byLabel.set(hit.label, hit);
  }
  return [...byLabel.values()].slice(0, maxHits);
}

export function formatPopCultureAnswer(hits: ThemeHit[]): string {
  if (!hits.length) {
    return "I didn’t find clear movie/TV/book shout-outs with the patterns I know — try asking about a specific franchise (e.g. Star Trek).";
  }

  const labels = [...new Set(hits.map((h) => h.label))];
  const lines = [
    `Yes — there’s plenty of pop-culture name-dropping. I spotted references to: **${labels.join("**, **")}**.`,
    "",
    "A few examples:",
  ];
  for (const hit of hits.slice(0, 6)) {
    lines.push(`- **${hit.label}** (${hit.bookTitle} · ${hit.position})`);
  }
  lines.push("");
  lines.push("Open **Sources** below to read the passages.");
  return lines.join("\n");
}

export function popCultureHitsToSources(hits: ThemeHit[]): ChatSource[] {
  const out: ChatSource[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const key = `${hit.bookTitle}|${hit.position}|${hit.snippet.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      book: hit.bookTitle,
      bookId: hit.bookId,
      position: hit.position,
      excerpt: hit.snippet,
    });
  }
  return out;
}

/** Deduplicate sources that share book + chapter + similar excerpt. */
export function dedupeSources(sources: ChatSource[]): ChatSource[] {
  const out: ChatSource[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const key = `${s.book}|${s.position || ""}|${(s.excerpt || "").slice(0, 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
