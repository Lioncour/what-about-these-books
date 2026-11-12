/**
 * Edits to a book that is already in the library: its display title and author.
 *
 * Books are identified by id everywhere, so a title is only what gets shown; the copies
 * kept in other stores (specialist profile, timeline, scorecards, saved chats) follow a
 * rename here. This is the one rename path, used by Tidy and by PATCH /api/books.
 */
import { renameBookInKnowledge } from "@/lib/knowledge-store";
import { renameBookInQuality } from "@/lib/quality-store";
import { isValidBookId } from "@/lib/runtime-config";
import { loadCatalog, renameBooks, saveCatalog, type BookEntry } from "./catalog";
import { renameBookInChats } from "./chats";
import { renameBookSpecialistProfile } from "./specialist-profiles";

const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 120;

/** Two titles that would be the same book to a lookup by title. */
export const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Change display titles by id and refresh every cached copy. Returns the ids that
 * changed. A store that can't be updated is logged and skipped: the catalog is the truth.
 */
export function renameBooksEverywhere(titlesById: ReadonlyMap<string, string>): Set<string> {
  const applied = renameBooks(titlesById);
  for (const id of applied) {
    const to = titlesById.get(id)!.trim();
    for (const [what, fn] of [
      ["specialist profile", () => renameBookSpecialistProfile(id, to)],
      ["knowledge", () => renameBookInKnowledge(id, to)],
      ["quality", () => renameBookInQuality(id, to)],
      ["chats", () => renameBookInChats(id, to)],
    ] as Array<[string, () => void]>) {
      try {
        fn();
      } catch (error) {
        console.error(`rename: could not update the title in ${what} for ${id}:`, error);
      }
    }
  }
  return applied;
}

/** A book edit that was refused; `status` is the HTTP status the API answers with. */
export class BookEditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409
  ) {
    super(message);
    this.name = "BookEditError";
  }
}

/**
 * Set a book's title and/or author. Values are trimmed; the title must be 1–200
 * characters and must not equal another book's title (some lookups still go by title);
 * the author at most 120, and an empty author clears it. Returns the catalog entry.
 */
export function updateBookMetadata(bookId: unknown, patch: { title?: unknown; author?: unknown }): BookEntry {
  if (!isValidBookId(bookId)) throw new BookEditError("Invalid book id", 400);
  const catalog = loadCatalog();
  const book = catalog.books.find((b) => b.id === bookId);
  if (!book) throw new BookEditError("No such book", 400);

  let title: string | undefined;
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string") throw new BookEditError("The title must be text", 400);
    title = patch.title.replace(/\s+/g, " ").trim();
    if (!title) throw new BookEditError("The title can't be empty", 400);
    if (title.length > MAX_TITLE_LENGTH) {
      throw new BookEditError(`The title can be at most ${MAX_TITLE_LENGTH} characters`, 400);
    }
    const clash = catalog.books.find((b) => b.id !== bookId && titleKey(b.title) === titleKey(title!));
    if (clash) throw new BookEditError(`Another book is already called "${clash.title}"`, 409);
  }

  let author: string | undefined;
  if (patch.author !== undefined) {
    if (typeof patch.author !== "string") throw new BookEditError("The author must be text", 400);
    author = patch.author.replace(/\s+/g, " ").trim();
    if (author.length > MAX_AUTHOR_LENGTH) {
      throw new BookEditError(`The author can be at most ${MAX_AUTHOR_LENGTH} characters`, 400);
    }
  }

  if (author !== undefined && author !== (book.author || "")) {
    if (author) book.author = author;
    else delete book.author;
    saveCatalog(catalog);
  }
  if (title !== undefined && title !== book.title) renameBooksEverywhere(new Map([[bookId, title]]));

  return loadCatalog().books.find((b) => b.id === bookId)!;
}
