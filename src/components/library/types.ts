export interface Book {
  id: string;
  title: string;
  wordCount: number;
  filename: string;
  addedAt: string;
  hasCover?: boolean;
  author?: string;
  fileType?: string;
  seriesId?: string;
  seriesOrder?: number;
  isbn?: string;
  publishedYear?: number;
}

export interface Series {
  id: string;
  name: string;
  bookIds: string[];
  createdAt: string;
}

export interface DuplicateGroup {
  key: string;
  books: Book[];
}

/** The one dialog the library can have open. */
export type LibraryDialog =
  | { kind: "remove-book"; book: Book }
  | { kind: "edit-book"; book: Book }
  | { kind: "new-series" }
  | { kind: "rename-series"; series: Series }
  | { kind: "delete-series"; series: Series }
  | { kind: "merge"; group: DuplicateGroup }
  | { kind: "notice"; title: string; lines: string[] };
