import {
  MAX_LIBRARY_SPECIALIST_BOOKS,
  MAX_SERIES_SPECIALIST_BOOKS,
  MAX_SPECIALIST_SEED_PASSAGES,
} from "@/lib/chat/constants";
import { listBooks, queryAllBooks } from "@/lib/book-store";

interface BookRef {
  id: string;
  title: string;
}

export async function selectBooksForLibrarySpecialists(
  question: string,
  maxBooks = MAX_LIBRARY_SPECIALIST_BOOKS
): Promise<BookRef[]> {
  const catalogBooks = listBooks();
  if (!catalogBooks.length) return [];

  const seedPassages = await queryAllBooks(question, MAX_SPECIALIST_SEED_PASSAGES);
  const rankedTitles = [...new Set(seedPassages.map((p) => p.bookTitle))];
  const chosen =
    rankedTitles.length > 0
      ? catalogBooks.filter((b) => rankedTitles.includes(b.title))
      : catalogBooks;

  return chosen.slice(0, maxBooks).map((b) => ({ id: b.id, title: b.title }));
}

export function selectBooksForSeriesSpecialists(
  seriesBookIds: string[],
  maxBooks = MAX_SERIES_SPECIALIST_BOOKS
): BookRef[] {
  return listBooks()
    .filter((b) => seriesBookIds.includes(b.id))
    .slice(0, maxBooks)
    .map((b) => ({ id: b.id, title: b.title }));
}
