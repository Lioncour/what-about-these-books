"use client";

import BookCover from "@/components/library/BookCover";
import { formatWordCount } from "@/components/library/shelf";
import type { Book, Series } from "@/components/library/types";

/** One book on the shelves: cover, series number, title; manage controls when managing. */
export default function BookCard({
  book,
  active,
  managing,
  readOnly,
  series,
  coverVersion,
  onSelect,
  onRemove,
  onEdit,
  onAssign,
}: {
  book: Book;
  active: boolean;
  /** Manage mode is on (never in read-only mode). */
  managing: boolean;
  readOnly?: boolean;
  series: Series[];
  coverVersion?: number;
  onSelect: (book: Book) => void;
  onRemove: (book: Book) => void;
  onEdit: (book: Book) => void;
  onAssign: (bookId: string, seriesId: string) => void;
}) {
  return (
    <div
      onClick={() => onSelect(book)}
      className={`group relative cursor-pointer overflow-hidden rounded-2xl border transition-all hover:-translate-y-0.5 hover:shadow-md ${
        active
          ? "border-primary/70 bg-primary/5 shadow-md"
          : "border-border/40 bg-surface hover:border-border hover:bg-surface-hover"
      }`}
    >
      <div className="aspect-[2/3] w-full">
        <BookCover bookId={book.id} title={book.title} hasCover={book.hasCover} version={coverVersion} />
      </div>
      {active && (
        <div className="absolute left-1.5 top-1.5 z-10 rounded-full bg-primary p-1 text-[#e8ddd0] shadow">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
      <div className="p-2.5">
        {book.seriesOrder != null && (
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
            Book {book.seriesOrder}
          </p>
        )}
        <p className="line-clamp-2 break-words text-sm font-medium leading-snug" title={book.title}>
          {book.title}
        </p>
        {book.author && <p className="truncate text-[11px] text-muted">{book.author}</p>}
        <p className="flex items-center gap-1.5 truncate text-[11px] text-muted">
          {formatWordCount(book.wordCount)}
          {book.fileType && (
            <span className="rounded bg-muted/20 px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wider">
              {book.fileType}
            </span>
          )}
        </p>
        {managing && (
          <>
            <select
              className="mt-1 w-full rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
              value={book.seriesId || "none"}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onAssign(book.id, e.target.value)}
            >
              <option value="none">Ungrouped</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(book);
              }}
              className="mt-1 w-full rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted hover:text-foreground"
              title="Change the title, author or cover"
            >
              Edit
            </button>
          </>
        )}
      </div>
      {!readOnly && !managing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(book);
          }}
          className="absolute right-1.5 top-1.5 z-10 rounded-lg bg-black/50 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
          title="Remove book"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
