/**
 * The library store, as one import. The implementation lives in `src/lib/store/*`:
 *
 *   paths                 where things live under DATA_DIR
 *   catalog               books.json (books + series), cached, with .bak
 *   pages                 texts/<bookId>.json page maps
 *   search                keyword / count / exact-quote search over the page maps
 *   labels                chapter labels from EPUB headings
 *   settings              settings.json
 *   covers                covers/
 *   book-edit             title/author edits and the one rename path
 *   specialist-profiles   specialists/
 *   chats                 chats/
 *   series                series edits, reconcile, duplicates
 *   vector-index          Vectra index: add/delete/rebuild/query
 *   tidy                  tidyLibrary (retitle + relabel existing books)
 */
export { DATA_DIR, isPublicMode, isValidBookId, isValidChatId, isValidSeriesId } from "@/lib/runtime-config";

export type { BookEntry, SeriesEntry } from "./store/catalog";
export {
  findBookByFilename,
  findBooksByTitleQuery,
  getBookById,
  getSeriesForBook,
  listBooks,
  listSeries,
} from "./store/catalog";

export type { BookPage } from "./store/pages";
export { loadBookPages, saveBookPages } from "./store/pages";

export type { BookPageMatch, CountMode, ExactQuoteMatch, PageMatch } from "./store/search";
export {
  countAllBooksKeywordMentions,
  countBookKeywordMentions,
  countSeriesKeywordMentions,
  searchAllBooksKeyword,
  searchBookKeyword,
  searchExactQuoteAllBooks,
  searchExactQuoteInBook,
  searchExactQuoteInSeries,
  searchSeriesKeyword,
} from "./store/search";

export type { AISettings } from "./store/settings";
export { loadSettings, saveSettings } from "./store/settings";

export { MAX_COVER_BYTES, getCoverPath, replaceCover, saveCover } from "./store/covers";

export { BookEditError, updateBookMetadata } from "./store/book-edit";

export type { BookSpecialistProfile } from "./store/specialist-profiles";
export { loadBookSpecialistProfile, saveBookSpecialistProfile } from "./store/specialist-profiles";

export type { ChatEntry } from "./store/chats";
export { deleteChat, deleteChatsForBook, listChats, loadChat, saveChat } from "./store/chats";

export type { DuplicateGroup } from "./store/series";
export {
  autoFixSeriesByAuthor,
  deleteSeries,
  findSeriesByName,
  inferSeriesIdFromAuthor,
  listDuplicateBookGroups,
  mergeDuplicateBooks,
  reconcileLibrarySeries,
  saveSeries,
} from "./store/series";

export type { BookPassageResult, PassageResult } from "./store/vector-index";
export {
  addBook,
  deleteAllBooks,
  deleteBook,
  queryAllBooks,
  queryBook,
  querySeriesBooks,
  rebuildBookIndex,
  resetIndexCache,
} from "./store/vector-index";

export { chapterLabelFromText, relabelEpubPages } from "./store/labels";

export type { TidyResult } from "./store/tidy";
export { tidyLibrary } from "./store/tidy";
