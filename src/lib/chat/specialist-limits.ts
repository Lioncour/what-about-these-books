import {
  MAX_LIBRARY_SPECIALIST_BOOKS,
  MAX_SERIES_SPECIALIST_BOOKS,
  MAX_SPECIALIST_SEED_PASSAGES,
} from "@/lib/chat/constants";
import { listBooks, listSeries, queryAllBooks, querySeriesBooks } from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import { extractSeriesBookNumber } from "@/lib/series-order";

/** Seed passages fetched once for a series' specialists. */
const SERIES_SEED_PASSAGES = 48;

export interface BookRef {
  id: string;
  title: string;
}

export interface SeedPassage {
  bookTitle: string;
  text: string;
  location: string;
}

export interface LibrarySpecialistSelection {
  books: BookRef[];
  /** Books the question names outright (title or "book N" of a named series), in question order. */
  namedBooks: BookRef[];
  /** The one semantic seed query of the request — reused by the specialists. */
  seedPassages: SeedPassage[];
}

const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "book", "books", "novel", "series", "volume",
  "part", "epub", "pdf", "txt", "edition", "complete", "collection", "story", "stories",
]);

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholePhrase(question: string, phrase: string, flags = "i"): boolean {
  if (!phrase) return false;
  const re = new RegExp(`(?:^|[^\\w])${escapeRegex(phrase).replace(/\s+/g, "\\s+")}(?=$|[^\\w])`, flags);
  return re.test(question);
}

/** "book 3" / "the third book" / "#3" in the question. */
function extractBookNumberFromQuestion(question: string): number | null {
  const m =
    question.match(/\b(?:book|volume|vol\.?)\s*#?\s*(\d{1,2})\b/i) ||
    question.match(/#\s*(\d{1,2})\b/);
  if (m?.[1]) return Number(m[1]);
  const ord = question.match(/\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+(?:book|volume|novel|one)\b/i);
  if (ord?.[1]) return ORDINALS[ord[1].toLowerCase()] ?? null;
  return null;
}

/**
 * Catalog books the question names: the cleaned title (whole phrase, case-insensitive), a
 * distinctive run of two title words, or "book N"/"the Nth book" of a series named in the
 * question. A one-word title must appear capitalised, so "find paradise" doesn't pick
 * the book "Paradise".
 */
export function findNamedBooksInQuestion(
  question: string,
  catalogBooks: ReturnType<typeof listBooks> = listBooks()
): BookRef[] {
  const q = question.replace(/\s+/g, " ").trim();
  if (!q) return [];
  const hits: Array<{ book: BookRef; at: number }> = [];
  const seen = new Set<string>();
  const add = (book: { id: string; title: string }, at: number) => {
    if (seen.has(book.id)) return;
    seen.add(book.id);
    hits.push({ book: { id: book.id, title: book.title }, at });
  };

  for (const book of catalogBooks) {
    const cleaned = cleanBookDisplayTitle(book.title).replace(/[^\w\s'’-]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const words = cleaned.split(" ").filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w.toLowerCase()));
    const lowerQ = q.toLowerCase();

    if (cleaned.length >= 4 && wholePhrase(q, cleaned)) {
      const single = !cleaned.includes(" ");
      const capitalised = cleaned[0].toUpperCase() + cleaned.slice(1);
      if (!single || wholePhrase(q, capitalised, "")) {
        add(book, lowerQ.indexOf(cleaned.toLowerCase()));
        continue;
      }
    }
    // Distinctive word pair from the title ("Columbus Day" inside "Craig Alanson Columbus Day")
    for (let i = 0; i + 1 < words.length; i++) {
      const pair = `${words[i]} ${words[i + 1]}`;
      if (wholePhrase(q, pair)) {
        add(book, lowerQ.indexOf(pair.toLowerCase()));
        break;
      }
    }
  }

  // "book 3" of a series the question names
  const number = extractBookNumberFromQuestion(q);
  if (number != null) {
    for (const series of listSeries()) {
      const name = series.name.replace(/\s+/g, " ").trim();
      if (name.length < 4 || !wholePhrase(q, name)) continue;
      const inSeries = catalogBooks.filter((b) => series.bookIds.includes(b.id));
      const match = inSeries.find((b) => {
        const order = b.seriesOrder ?? extractSeriesBookNumber(b.title, b.filename);
        return order === number;
      });
      if (match) add(match, q.toLowerCase().indexOf(name.toLowerCase()));
    }
  }

  return hits.sort((a, b) => a.at - b.at).map((h) => h.book);
}

/** The question clearly wants more than one book (compare, across, all, both …). */
function wantsMultipleBooks(question: string): boolean {
  return /\b(compare|compared|comparison|versus|vs\.?|across|all (?:the )?books|every book|both books|each book|other books|the series|whole series|entire series|throughout the series|library)\b/i.test(
    question
  );
}

export async function selectLibrarySpecialists(
  question: string,
  maxBooks = MAX_LIBRARY_SPECIALIST_BOOKS
): Promise<LibrarySpecialistSelection> {
  const catalogBooks = listBooks();
  if (!catalogBooks.length) return { books: [], namedBooks: [], seedPassages: [] };

  const namedBooks = findNamedBooksInQuestion(question, catalogBooks);

  // Clearly about one named book: read just that one, no semantic ranking needed.
  if (namedBooks.length === 1 && !wantsMultipleBooks(question)) {
    return { books: namedBooks, namedBooks, seedPassages: [] };
  }

  const seedPassages = await queryAllBooks(question, MAX_SPECIALIST_SEED_PASSAGES);
  const rankedTitles = [...new Set(seedPassages.map((p) => p.bookTitle))];
  const ranked =
    rankedTitles.length > 0
      ? rankedTitles
          .map((t) => catalogBooks.find((b) => b.title === t))
          .filter((b): b is NonNullable<typeof b> => Boolean(b))
      : catalogBooks;

  const chosen: BookRef[] = [...namedBooks.slice(0, maxBooks)];
  const taken = new Set(chosen.map((b) => b.id));
  for (const b of ranked) {
    if (chosen.length >= maxBooks) break;
    if (taken.has(b.id)) continue;
    taken.add(b.id);
    chosen.push({ id: b.id, title: b.title });
  }

  return { books: chosen, namedBooks, seedPassages };
}

/**
 * Specialists for a series in focus: its books in catalog order (capped). A book the
 * question names is read first — or alone when it is the only one named and the question
 * doesn't ask for several books, the same rule as the library scope.
 */
export async function selectSeriesSpecialists(
  series: { id: string; bookIds: string[] },
  question: string,
  maxBooks = MAX_SERIES_SPECIALIST_BOOKS
): Promise<LibrarySpecialistSelection> {
  const catalogBooks = listBooks();
  let books: BookRef[] = catalogBooks
    .filter((b) => series.bookIds.includes(b.id))
    .slice(0, maxBooks)
    .map((b) => ({ id: b.id, title: b.title }));
  const namedBooks = findNamedBooksInQuestion(question, catalogBooks).filter((b) =>
    series.bookIds.includes(b.id)
  );
  if (namedBooks.length === 1 && !wantsMultipleBooks(question)) {
    return { books: namedBooks, namedBooks, seedPassages: [] };
  }
  if (namedBooks.length) {
    const rest = books.filter((b) => !namedBooks.some((n) => n.id === b.id));
    books = [...namedBooks, ...rest].slice(0, Math.max(books.length, namedBooks.length));
  }
  if (!books.length) return { books, namedBooks, seedPassages: [] };
  // One semantic query for the series; specialists reuse their book's passages.
  const seedPassages = await querySeriesBooks(series.id, question, SERIES_SEED_PASSAGES);
  return { books, namedBooks, seedPassages };
}

/** Split one seed query's passages per book title for the specialists. */
export function seedPassagesByTitle(seedPassages: SeedPassage[]): Map<string, { text: string; location: string }[]> {
  const out = new Map<string, { text: string; location: string }[]>();
  for (const p of seedPassages) {
    const list = out.get(p.bookTitle) || [];
    list.push({ text: p.text, location: p.location });
    out.set(p.bookTitle, list);
  }
  return out;
}
