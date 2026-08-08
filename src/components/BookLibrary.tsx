"use client";

import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";

interface Book {
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

interface Series {
  id: string;
  name: string;
  bookIds: string[];
  createdAt: string;
}

interface DuplicateGroup {
  key: string;
  books: Book[];
}

interface BookLibraryProps {
  onSelectBook: (book: { id: string; title: string; wordCount: number }) => void;
  activeBookId?: string | null;
  readOnly?: boolean;
  /** "shelf" = roomy main-stage grid; "rail" = compact */
  variant?: "shelf" | "rail";
}

export interface BookLibraryHandle {
  refresh: () => void;
}

const COVER_COLORS = [
  "bg-[#5a6f58]/22 text-[#3a4a38]",
  "bg-[#b08968]/25 text-[#6b4f38]",
  "bg-[#7a8f9a]/20 text-[#3d4f58]",
  "bg-[#a89070]/22 text-[#5c4a35]",
  "bg-[#8a9578]/20 text-[#454d3c]",
  "bg-[#958a9a]/18 text-[#4e4558]",
  "bg-[#a88878]/20 text-[#5c453c]",
  "bg-[#789a90]/20 text-[#3c524c]",
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
    // Covers are local API blobs; next/image isn't useful here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/covers/${bookId}`}
      alt={`Cover of ${title}`}
      className="h-full w-full rounded-lg object-cover"
      onError={() => setFailed(true)}
    />
  );
}

const BookLibrary = forwardRef<BookLibraryHandle, BookLibraryProps>(
  function BookLibrary({ onSelectBook, activeBookId, readOnly, variant = "rail" }, ref) {
    const shelf = variant === "shelf";
    const [books, setBooks] = useState<Book[]>([]);
    const [series, setSeries] = useState<Series[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState("");
    const [manageMode, setManageMode] = useState(false);
    const [collapsedSeries, setCollapsedSeries] = useState<Record<string, boolean>>({});
    const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);

    const fetchBooks = useCallback(async () => {
      try {
        const [booksRes, seriesRes] = await Promise.all([
          fetch("/api/books"),
          fetch("/api/series"),
        ]);
        const booksData = await booksRes.json();
        const seriesData = await seriesRes.json();
        setBooks(booksData.books || []);
        setSeries(seriesData.series || []);
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

    const handleCreateSeries = useCallback(async () => {
      const name = prompt("New series name:");
      if (!name?.trim()) return;
      await fetch("/api/series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), bookIds: [] }),
      });
      await fetchBooks();
    }, [fetchBooks]);

    const handleRenameSeries = useCallback(
      async (seriesId: string, currentName: string) => {
        const s = series.find((x) => x.id === seriesId);
        if (!s) return;
        const nextName = prompt("Rename series:", currentName);
        if (!nextName?.trim()) return;
        await fetch("/api/series", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: s.id,
            name: nextName.trim(),
            bookIds: s.bookIds,
          }),
        });
        await fetchBooks();
      },
      [series, fetchBooks]
    );

    const handleDeleteSeries = useCallback(
      async (seriesId: string) => {
        if (!confirm("Delete this series? Books remain in your library.")) return;
        await fetch("/api/series", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seriesId }),
        });
        await fetchBooks();
      },
      [fetchBooks]
    );

    const assignBookToSeries = useCallback(
      async (bookId: string, targetSeriesId: string) => {
        const currentSeries = series.find((s) => s.bookIds.includes(bookId));
        if (currentSeries && currentSeries.id !== targetSeriesId) {
          await fetch("/api/series", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: currentSeries.id,
              name: currentSeries.name,
              bookIds: currentSeries.bookIds.filter((id) => id !== bookId),
            }),
          });
        }

        if (targetSeriesId !== "none") {
          const targetSeries = series.find((s) => s.id === targetSeriesId);
          if (targetSeries && !targetSeries.bookIds.includes(bookId)) {
            await fetch("/api/series", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: targetSeries.id,
                name: targetSeries.name,
                bookIds: [...targetSeries.bookIds, bookId],
              }),
            });
          }
        }

        await fetchBooks();
      },
      [series, fetchBooks]
    );

    const toggleSeriesCollapsed = useCallback((seriesId: string) => {
      setCollapsedSeries((prev) => ({ ...prev, [seriesId]: !prev[seriesId] }));
    }, []);

    const handleAutoFixSeries = useCallback(async () => {
      const res = await fetch("/api/series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reconcile", allowRemote: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Series fix failed.");
        return;
      }
      await fetchBooks();
      alert(
        `Series grouping fixed.\n` +
          `Updated books: ${data.updatedBooks ?? 0}\n` +
          `Ordered books: ${data.orderedBooks ?? 0}\n` +
          `Created: ${data.createdSeries ?? 0}\n` +
          `Merged folders: ${data.mergedSeries ?? 0}\n` +
          `Removed junk: ${data.removedSeries ?? 0}\n` +
          `Open Library matches: ${data.lookedUp ?? 0}`
      );
    }, [fetchBooks]);

    const handleScanDuplicates = useCallback(async () => {
      const res = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "duplicates" }),
      });
      const data = await res.json();
      setDuplicateGroups(data.groups || []);
      if (!data.groups?.length) {
        alert("No duplicate groups detected.");
      }
    }, []);

    const handleMergeDuplicateGroup = useCallback(
      async (group: DuplicateGroup) => {
        if (!group.books.length || group.books.length < 2) return;
        const sorted = [...group.books].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
        const primary = sorted[0];
        if (
          !confirm(
            `Merge duplicates for "${primary.title}"?\nKeep: ${primary.title}\nRemove: ${sorted
              .slice(1)
              .map((b) => b.title)
              .join(", ")}`
          )
        ) {
          return;
        }
        for (const dupe of sorted.slice(1)) {
          await fetch("/api/books", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "merge-duplicate",
              primaryBookId: primary.id,
              duplicateBookId: dupe.id,
            }),
          });
        }
        await fetchBooks();
        await handleScanDuplicates();
      },
      [fetchBooks, handleScanDuplicates]
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

    const filteredBooks = filter
      ? books.filter(
          (b) =>
            b.title.toLowerCase().includes(filter.toLowerCase()) ||
            (b.author && b.author.toLowerCase().includes(filter.toLowerCase()))
        )
      : books;

    const booksById = new Map(filteredBooks.map((b) => [b.id, b]));
    const visibleSeries = series
      .map((s) => ({
        ...s,
        books: s.bookIds
          .map((id) => booksById.get(id))
          .filter(Boolean)
          .sort((a, b) => {
            const ao = a!.seriesOrder ?? 9999;
            const bo = b!.seriesOrder ?? 9999;
            if (ao !== bo) return ao - bo;
            const ay = a!.publishedYear ?? 9999;
            const by = b!.publishedYear ?? 9999;
            if (ay !== by) return ay - by;
            return a!.title.localeCompare(b!.title);
          }) as Book[],
      }))
      .filter((s) => s.books.length > 0);
    const groupedBookIds = new Set(visibleSeries.flatMap((s) => s.books.map((b) => b.id)));
    const ungroupedBooks = filteredBooks.filter((b) => !groupedBookIds.has(b.id));

    const bookGridClass = shelf
      ? "grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
      : "grid grid-cols-2 gap-5 sm:grid-cols-3";

    const renderBookCard = (book: Book) => {
      const isActive = activeBookId === book.id;
      return (
        <div
          key={book.id}
          onClick={() => onSelectBook(book)}
          className={`group relative cursor-pointer overflow-hidden rounded-2xl border transition-all hover:-translate-y-0.5 hover:shadow-md ${
            isActive
              ? "border-primary/70 bg-primary/5 shadow-md"
              : "border-border/40 bg-surface hover:border-border hover:bg-surface-hover"
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
            <div className="absolute left-1.5 top-1.5 z-10 rounded-full bg-primary p-1 text-[#e8ddd0] shadow">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
          <div className={shelf ? "p-3.5" : "p-2.5"}>
            {book.seriesOrder != null && (
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
                Book {Number.isInteger(book.seriesOrder) ? book.seriesOrder : book.seriesOrder}
              </p>
            )}
            <p className={`truncate font-medium ${shelf ? "text-[15px]" : "text-sm"}`}>{book.title}</p>
            {book.author && (
              <p className="truncate text-[11px] text-muted">{book.author}</p>
            )}
            {!shelf && (
              <p className="flex items-center gap-1.5 truncate text-[11px] text-muted">
                {formatWordCount(book.wordCount)}
                {book.fileType && (
                  <span className="rounded bg-muted/20 px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wider">
                    {book.fileType}
                  </span>
                )}
              </p>
            )}
            {manageMode && !readOnly && (
              <select
                className="mt-1 w-full rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
                value={book.seriesId || "none"}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => assignBookToSeries(book.id, e.target.value)}
              >
                <option value="none">Ungrouped</option>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {!readOnly && !manageMode && (
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
          )}
        </div>
      );
    };

    return (
      <div>
        <div className={`mb-5 flex items-center justify-between gap-2 px-0.5 ${shelf ? "mb-7" : ""}`}>
          <div>
            <h2
              className={
                shelf
                  ? "font-display text-2xl font-semibold tracking-tight text-foreground"
                  : "text-[11px] font-medium tracking-wide text-muted"
              }
            >
              {shelf ? "Your shelves" : `Your Library (${books.length})`}
            </h2>
            {shelf && (
              <p className="mt-1 text-sm text-muted">
                {books.length} book{books.length === 1 ? "" : "s"} · pick one to talk about
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!shelf && <p className="hidden text-[11px] text-muted sm:block">Click to focus</p>}
            {!readOnly && (
              <button
                onClick={() => setManageMode((v) => !v)}
                className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] font-medium text-muted hover:text-foreground"
              >
                {manageMode ? "Done" : "Manage"}
              </button>
            )}
          </div>
        </div>
        {manageMode && !readOnly && (
          <div className="mb-3">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCreateSeries}
                className="rounded border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
              >
                + New series
              </button>
              <button
                onClick={handleAutoFixSeries}
                className="rounded border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
                title="Merge Book N folders and look up series on Open Library"
              >
                Fix series grouping
              </button>
              <button
                onClick={handleScanDuplicates}
                className="rounded border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
              >
                Find duplicates
              </button>
            </div>
            {duplicateGroups.length > 0 && (
              <div className="mt-2 space-y-1 rounded border border-border bg-background p-2">
                {duplicateGroups.map((group) => (
                  <div key={group.key} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-muted">
                      {group.books[0]?.title} ({group.books.length})
                    </span>
                    <button
                      onClick={() => handleMergeDuplicateGroup(group)}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground"
                    >
                      Merge
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {books.length > 4 && (
          <div className="mb-3">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search books..."
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs outline-none transition-colors placeholder:text-muted focus:border-primary"
            />
          </div>
        )}
        {visibleSeries.map((s) => {
          const seriesActive = activeBookId === `series:${s.id}`;
          const collapsed = !!collapsedSeries[s.id];
          return (
            <div key={s.id} className="mb-4">
              <div
                className={`mb-2 flex cursor-pointer items-center justify-between rounded-lg border px-2 py-1.5 ${
                  seriesActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-foreground"
                }`}
                onClick={() => onSelectBook({ id: `series:${s.id}`, title: s.name, wordCount: 0 })}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSeriesCollapsed(s.id);
                    }}
                    className="rounded p-0.5 hover:bg-black/5"
                    title={collapsed ? "Expand" : "Collapse"}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`${collapsed ? "" : "rotate-90"} transition-transform`}>
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  <span className="text-xs font-semibold">{s.name}</span>
                  <span className="text-[10px] text-muted">({s.books.length})</span>
                </div>
                {manageMode && !readOnly && (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleRenameSeries(s.id, s.name)}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleDeleteSeries(s.id)}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-400"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {!collapsed && (
                <div className={bookGridClass}>
                  {s.books.map((book) => renderBookCard(book))}
                </div>
              )}
            </div>
          );
        })}

        {ungroupedBooks.length > 0 && (
          <div>
            {visibleSeries.length > 0 && (
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Ungrouped
              </p>
            )}
            <div className={bookGridClass}>
              {ungroupedBooks.map((book) => renderBookCard(book))}
            </div>
          </div>
        )}
      </div>
    );
  }
);

export default BookLibrary;
