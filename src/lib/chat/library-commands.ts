import {
  deleteAllBooks,
  deleteBook,
  findBooksByTitleQuery,
  getBookById,
  isPublicMode,
  listBooks,
} from "@/lib/book-store";
import { startFullReindex, getReindexState } from "@/lib/reindex-manager";

export type LibraryCommandType =
  | "help"
  | "list_books"
  | "remove_all"
  | "remove_book"
  | "reindex_all";

export interface LibraryCommand {
  type: LibraryCommandType;
  bookQuery?: string;
}

export interface LibraryCommandResult {
  message: string;
  libraryChanged: boolean;
  clearFocus?: boolean;
}

/** Strip @command@ wrappers or leading @ */
export function normalizeLibraryCommandInput(raw: string): { text: string; explicit: boolean } {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^@([\s\S]+)@$/);
  if (wrapped) return { text: wrapped[1].trim(), explicit: true };
  if (trimmed.startsWith("@")) return { text: trimmed.slice(1).trim(), explicit: true };
  return { text: trimmed, explicit: false };
}

/** Content questions that mention "library" but are not app commands. */
function looksLikeBookContentQuestion(lower: string): boolean {
  return /\b(chapter|page\s*\d|passage|who is|how many|what happens|in the book|plot|character|theme|quote|mentioned)\b/i.test(
    lower
  );
}

function isRemoveAllLibraryCommand(lower: string, text: string, explicit: boolean): boolean {
  if (looksLikeBookContentQuestion(lower)) return false;
  if (
    /\b(?:remove|delete|clear|empty|wipe)\s+(?:all\s+)?(?:the\s+)?books?\s+(?:in|from)\s+(?:the\s+)?(?:my\s+)?library\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /\b(?:remove|delete|clear)\s+(?:all\s+)?(?:books?|everything)\s+from\s+(?:my\s+)?library\b/i.test(lower)
  ) {
    return true;
  }
  if (/\b(?:clear|empty|wipe)\s+(?:my\s+)?(?:whole\s+)?library\b/i.test(lower)) return true;
  if (/\bdelete\s+everything\s+in\s+(?:my\s+)?library\b/i.test(lower)) return true;
  if (/^(?:remove|delete|clear)\s+(?:all\s+)?(?:books?|library)\s*$/i.test(text)) return true;
  if (explicit && /\b(?:remove|delete|clear)\b/i.test(lower) && /\ball\b/i.test(lower) && /\b(?:books?|library)\b/i.test(lower)) {
    return true;
  }
  return false;
}

export function isLibraryManagementInput(raw: string): boolean {
  return resolveLibraryCommand(raw) !== null;
}

/** Try the raw message and common sub-phrases (e.g. pasted chat with a prefix). */
export function resolveLibraryCommand(...rawInputs: Array<string | undefined>): LibraryCommand | null {
  for (const raw of rawInputs) {
    if (!raw?.trim()) continue;
    const direct = parseLibraryCommand(raw);
    if (direct) return direct;

    const embedded = raw.match(
      /\b((?:remove|delete|clear|empty|wipe)\s+all\s+(?:the\s+)?books?\s+(?:in|from)\s+(?:the\s+)?(?:my\s+)?library)\b/i
    );
    if (embedded?.[1]) {
      const cmd = parseLibraryCommand(embedded[1]);
      if (cmd) return cmd;
    }
  }
  return null;
}

export function parseLibraryCommand(raw: string): LibraryCommand | null {
  const { text, explicit } = normalizeLibraryCommandInput(raw);
  const lower = text.toLowerCase();

  if (
    /^library\s+commands?/i.test(lower) ||
    /what\s+(?:library|book)\s+commands/i.test(lower) ||
    /^help\s+library/i.test(lower) ||
    (explicit && /^help$/i.test(text))
  ) {
    return { type: "help" };
  }

  if (
    /^(?:list|show)\s+(?:all\s+)?(?:my\s+)?(?:books?|library)/i.test(text) ||
    /^what\s+books?\s+(?:do\s+)?i\s+have/i.test(lower)
  ) {
    return { type: "list_books" };
  }

  if (
    /\b(reindex|re-index|reread|re-read|rebuild|refresh)\s+(?:all\s+)?(?:books?|library|indexes?|everything)\b/i.test(
      lower
    ) ||
    /\b(reindex|re-index)\s+everything\b/i.test(lower) ||
    (explicit && /\b(reindex|reread|rebuild)\b/i.test(lower))
  ) {
    return { type: "reindex_all" };
  }

  const quotedRemove = text.match(/^(?:remove|delete)\s+(?:book\s+)?["“”'](.+?)["“”']\s*$/i);
  if (quotedRemove?.[1]) {
    return { type: "remove_book", bookQuery: quotedRemove[1].trim() };
  }

  const namedRemove = text.match(/^(?:remove|delete)\s+book\s+(.+)$/i);
  if (namedRemove?.[1] && (explicit || namedRemove[1].length >= 3)) {
    return { type: "remove_book", bookQuery: namedRemove[1].trim() };
  }

  if (isRemoveAllLibraryCommand(lower, text, explicit)) {
    return { type: "remove_all" };
  }

  return null;
}

function helpMessage(): string {
  return [
    "## Library commands",
    "",
    "Use **@...@** for destructive actions, or plain phrases for safe ones.",
    "",
    "| Command | Example |",
    "|---------|---------|",
    "| List books | `list my books` |",
    "| Re-read / reindex all | `@reread all books@` or `reindex library` |",
    "| Remove one book | `@delete book \"Columbus Day\"@` |",
    "| Remove everything | `remove all books in the library` or `@remove all books@` |",
    "",
    "Reindex rebuilds search indexes and knowledge graphs from stored text (no re-upload).",
  ].join("\n");
}

export async function executeLibraryCommand(
  command: LibraryCommand,
  scope?: { focusBookId?: string }
): Promise<LibraryCommandResult> {
  if (isPublicMode && command.type !== "help" && command.type !== "list_books") {
    return {
      message: "Library editing is disabled in public mode.",
      libraryChanged: false,
    };
  }

  switch (command.type) {
    case "help":
      return { message: helpMessage(), libraryChanged: false };

    case "list_books": {
      const books = listBooks();
      if (!books.length) {
        return { message: "Your library is empty. Upload a PDF, EPUB, or TXT to get started.", libraryChanged: false };
      }
      const lines = books.map((b, i) => `${i + 1}. **${b.title}**${b.author ? ` — ${b.author}` : ""}`);
      return {
        message: `You have **${books.length}** book${books.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`,
        libraryChanged: false,
      };
    }

    case "reindex_all": {
      const state = getReindexState();
      if (state.running) {
        return {
          message: `Re-index already running (${state.processed}/${state.total} books processed).`,
          libraryChanged: false,
        };
      }
      const books = listBooks();
      if (!books.length) {
        return { message: "No books to reindex. Upload something first.", libraryChanged: false };
      }
      await startFullReindex();
      return {
        message: `Started re-indexing **${books.length}** book${books.length === 1 ? "" : "s"} in the background. Search and specialist profiles will refresh as each book completes.`,
        libraryChanged: true,
      };
    }

    case "remove_all": {
      const count = await deleteAllBooks();
      return {
        message:
          count === 0
            ? "Your library was already empty."
            : `Removed **${count}** book${count === 1 ? "" : "s"} from your library.`,
        libraryChanged: count > 0,
        clearFocus: count > 0,
      };
    }

    case "remove_book": {
      const query = command.bookQuery?.trim();
      if (!query) {
        return { message: 'Tell me which book, e.g. `@delete book "Title"@`.', libraryChanged: false };
      }

      let matches = findBooksByTitleQuery(query);
      if (!matches.length && scope?.focusBookId) {
        const focused = getBookById(scope.focusBookId);
        if (focused && focused.title.toLowerCase().includes(query.toLowerCase())) {
          matches = [focused];
        }
      }

      if (!matches.length) {
        return {
          message: `No book matched **${query}**. Try \`list my books\` for exact titles.`,
          libraryChanged: false,
        };
      }
      if (matches.length > 1) {
        const lines = matches.map((b) => `- **${b.title}**`).join("\n");
        return {
          message: `Several books matched **${query}**. Be more specific:\n\n${lines}`,
          libraryChanged: false,
        };
      }

      const book = matches[0];
      await deleteBook(book.id);
      const clearedFocus = scope?.focusBookId === book.id;
      return {
        message: `Removed **${book.title}** from your library.`,
        libraryChanged: true,
        clearFocus: clearedFocus,
      };
    }

    default:
      return { message: "Unknown library command.", libraryChanged: false };
  }
}
