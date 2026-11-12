import { listBooks, loadBookPages } from "@/lib/book-store";
import { isKnowledgeCurrent, rebuildKnowledgeForBooks } from "@/lib/knowledge-store";

/** Rebuild the entity graph and timeline for every book from its stored text. */
export function rebuildKnowledgeForLibrary(): number {
  const books = listBooks()
    .map((book) => ({ bookId: book.id, bookTitle: book.title, pages: loadBookPages(book.id) || [] }))
    .filter((book) => book.pages.length > 0);
  rebuildKnowledgeForBooks(books, { replaceAll: true });
  return books.length;
}

/**
 * Called before the graph is read: a graph built by an older extraction is rebuilt
 * once, from the text already on disk (no AI call; a second or two per dozen books).
 * Returns how many books were rebuilt (0 when it was current).
 */
export function ensureKnowledgeCurrent(): number {
  if (isKnowledgeCurrent()) return 0;
  return rebuildKnowledgeForLibrary();
}
