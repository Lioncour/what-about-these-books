"use client";

import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";

interface Book {
  id: string;
  title: string;
  wordCount: number;
  filename: string;
  addedAt: string;
  hasCover?: boolean;
}

interface BookLibraryProps {
  onSelectBook: (book: { id: string; title: string; wordCount: number }) => void;
  activeBookId?: string | null;
}

export interface BookLibraryHandle {
  refresh: () => void;
}

const COVER_COLORS = [
  "bg-indigo-500/15 text-indigo-400",
  "bg-emerald-500/15 text-emerald-400",
  "bg-amber-500/15 text-amber-400",
  "bg-rose-500/15 text-rose-400",
  "bg-cyan-500/15 text-cyan-400",
  "bg-purple-500/15 text-purple-400",
  "bg-orange-500/15 text-orange-400",
  "bg-teal-500/15 text-teal-400",
];

function hashTitle(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function BookIcon({ title }: { title: string }) {
  const colorClass = COVER_COLORS[hashTitle(title) % COVER_COLORS.length];
  return (
    <div className={`flex h-full w-full items-center justify-center rounded-lg ${colorClass}`}>
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        <path d="M8 7h6" />
        <path d="M8 11h4" />
      </svg>
    </div>
  );
}

function CoverImage({ bookId, title }: { bookId: string; title: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <BookIcon title={title} />;

  return (
    <img
      src={`/api/covers/${bookId}`}
      alt={`Cover of ${title}`}
      className="h-full w-full rounded-lg object-cover"
      onError={() => setFailed(true)}
    />
  );
}

const BookLibrary = forwardRef<BookLibraryHandle, BookLibraryProps>(
  function BookLibrary({ onSelectBook, activeBookId }, ref) {
    const [books, setBooks] = useState<Book[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchBooks = useCallback(async () => {
      try {
        const res = await fetch("/api/books");
        const data = await res.json();
        setBooks(data.books || []);
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }, []);

    useImperativeHandle(ref, () => ({ refresh: fetchBooks }), [fetchBooks]);

    useEffect(() => {
      fetchBooks();
    }, [fetchBooks]);

    const handleDelete = useCallback(
      async (e: React.MouseEvent, bookId: string) => {
        e.stopPropagation();
        if (!confirm("Remove this book from your library?")) return;

        await fetch("/api/books", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookId }),
        });
        setBooks((prev) => prev.filter((b) => b.id !== bookId));
      },
      []
    );

    if (loading) {
      return (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          Loading your library...
        </div>
      );
    }

    if (!books.length) {
      return (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          No books yet — drop some files above
        </div>
      );
    }

    const formatWordCount = (count: number) => {
      if (count >= 1000) return `${(count / 1000).toFixed(1)}k words`;
      return `${count} words`;
    };

    return (
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Your Library
          </h2>
          <p className="text-[11px] text-muted">Click to focus questions</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {books.map((book) => {
            const isActive = activeBookId === book.id;
            return (
              <div
                key={book.id}
                onClick={() => onSelectBook(book)}
                className={`group relative cursor-pointer overflow-hidden rounded-xl border-2 transition-all hover:shadow-md ${
                  isActive
                    ? "border-primary bg-primary/5 shadow-md"
                    : "border-border bg-background hover:bg-surface-hover"
                }`}
              >
                <div className="aspect-[2/3] w-full">
                  {book.hasCover ? (
                    <CoverImage bookId={book.id} title={book.title} />
                  ) : (
                    <BookIcon title={book.title} />
                  )}
                </div>
                {isActive && (
                  <div className="absolute left-1.5 top-1.5 z-10 rounded-full bg-primary p-1 text-white shadow">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
                <div className="p-2">
                  <p className="truncate text-sm font-medium">{book.title}</p>
                  <p className="truncate text-[11px] text-muted">
                    {formatWordCount(book.wordCount)}
                  </p>
                </div>
                <button
                  onClick={(e) => handleDelete(e, book.id)}
                  className="absolute right-1.5 top-1.5 z-10 rounded-lg bg-black/50 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  title="Remove book"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

export default BookLibrary;
