"use client";

import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import BookCard from "@/components/library/BookCard";
import LibraryDialogs from "@/components/library/LibraryDialogs";
import ManageBar from "@/components/library/ManageBar";
import SeriesHeader from "@/components/library/SeriesHeader";
import { groupShelf } from "@/components/library/shelf";
import type { Book, LibraryDialog } from "@/components/library/types";
import { useBookShelf } from "@/hooks/useBookShelf";

interface BookLibraryProps {
  /** A book, or a series as `{ id: "series:<id>", title: <series name> }`. */
  onSelectBook: (book: { id: string; title: string; wordCount: number }) => void;
  /** The focus: a book id, or "series:<id>" to highlight a series row. */
  activeBookId?: string | null;
  readOnly?: boolean;
  /** Books, titles or series changed in here, so the page can refresh what it shows about them. */
  onLibraryChanged?: () => void;
  /** A book's title was edited (the page may be showing the old one). */
  onBookEdited?: (book: { id: string; title: string }) => void;
}

export interface BookLibraryHandle {
  refresh: () => void;
}

const BOOK_GRID = "grid grid-cols-2 gap-5 sm:grid-cols-3";

const BookLibrary = forwardRef<BookLibraryHandle, BookLibraryProps>(function BookLibrary(
  { onSelectBook, activeBookId, readOnly, onLibraryChanged, onBookEdited },
  ref
) {
  const shelf = useBookShelf(onLibraryChanged);
  const { books, series, refresh } = shelf;
  const [filter, setFilter] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [collapsedSeries, setCollapsedSeries] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  if (shelf.loading) {
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

  const managing = manageMode && !readOnly;
  const { series: visibleSeries, ungrouped } = groupShelf(books, series, filter);

  const fixSeries = async () => {
    const notice = await shelf.fixSeries();
    setDialog({ kind: "notice", ...notice });
  };

  const findDuplicates = async () => {
    const found = await shelf.scanDuplicates();
    if (!found) {
      setDialog({
        kind: "notice",
        title: "No duplicates",
        lines: ["No duplicate groups detected."],
      });
    }
  };

  const renderBookCard = (book: Book) => (
    <BookCard
      key={book.id}
      book={book}
      active={activeBookId === book.id}
      managing={managing}
      readOnly={readOnly}
      series={series}
      coverVersion={shelf.coverVersions[book.id]}
      onSelect={onSelectBook}
      onRemove={(b) => setDialog({ kind: "remove-book", book: b })}
      onEdit={(b) => setDialog({ kind: "edit-book", book: b })}
      onAssign={shelf.assignBookToSeries}
    />
  );

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-2 px-0.5">
        <div>
          <h2 className="text-[11px] font-medium tracking-wide text-muted">
            Your Library ({books.length})
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <p className="hidden text-[11px] text-muted sm:block">Click to focus</p>
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
      {managing && (
        <ManageBar
          duplicateGroups={shelf.duplicateGroups}
          onNewSeries={() => setDialog({ kind: "new-series" })}
          onFixSeries={fixSeries}
          onTidied={shelf.reload}
          onFindDuplicates={findDuplicates}
          onMerge={(group) => {
            if (group.books.length >= 2) setDialog({ kind: "merge", group });
          }}
        />
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
        const collapsed = !!collapsedSeries[s.id];
        return (
          <div key={s.id} className="mb-4">
            <SeriesHeader
              name={s.name}
              count={s.books.length}
              active={activeBookId === `series:${s.id}`}
              collapsed={collapsed}
              managing={managing}
              onSelect={() => onSelectBook({ id: `series:${s.id}`, title: s.name, wordCount: 0 })}
              onToggleCollapsed={() =>
                setCollapsedSeries((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
              }
              onRename={() => setDialog({ kind: "rename-series", series: s })}
              onDelete={() => setDialog({ kind: "delete-series", series: s })}
            />
            {!collapsed && <div className={BOOK_GRID}>{s.books.map(renderBookCard)}</div>}
          </div>
        );
      })}

      {ungrouped.length > 0 && (
        <div>
          {visibleSeries.length > 0 && (
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Ungrouped
            </p>
          )}
          <div className={BOOK_GRID}>{ungrouped.map(renderBookCard)}</div>
        </div>
      )}

      <LibraryDialogs
        dialog={dialog}
        shelf={shelf}
        onClose={closeDialog}
        onBookEdited={onBookEdited}
      />
    </div>
  );
});

export default BookLibrary;
