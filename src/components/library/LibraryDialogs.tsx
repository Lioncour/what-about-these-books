"use client";

import { useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import AskDialog from "@/components/chat/AskDialog";
import EditBookDialog from "@/components/library/EditBookDialog";
import { deleteSeriesQuestion, mergePlan, removeBookQuestion } from "@/components/library/shelf";
import type { LibraryDialog } from "@/components/library/types";
import type { BookShelf } from "@/hooks/useBookShelf";

/** Every dialog the library rail opens (remove, edit, series names, merge, notices). */
export default function LibraryDialogs({
  dialog,
  shelf,
  onClose,
  onBookEdited,
}: {
  dialog: LibraryDialog | null;
  shelf: BookShelf;
  onClose: () => void;
  onBookEdited?: (book: { id: string; title: string }) => void;
}) {
  const [busy, setBusy] = useState(false);

  /** Run a confirmed change with the buttons disabled, then put the dialog away. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      /* the shelves simply stay as they were */
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const naming = dialog?.kind === "new-series" || dialog?.kind === "rename-series" ? dialog : null;
  const merge = dialog?.kind === "merge" ? mergePlan(dialog.group) : null;

  return (
    <>
      <ConfirmDialog
        open={dialog?.kind === "remove-book"}
        title="Remove this book?"
        confirmLabel="Remove"
        tone="danger"
        busy={busy}
        onClose={onClose}
        onConfirm={() => {
          if (dialog?.kind === "remove-book") void run(() => shelf.removeBook(dialog.book.id));
        }}
      >
        {dialog?.kind === "remove-book" && removeBookQuestion(dialog.book.title)}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === "delete-series"}
        title="Delete this series?"
        confirmLabel="Delete series"
        tone="danger"
        busy={busy}
        onClose={onClose}
        onConfirm={() => {
          if (dialog?.kind === "delete-series") void run(() => shelf.deleteSeries(dialog.series.id));
        }}
      >
        {dialog?.kind === "delete-series" && deleteSeriesQuestion(dialog.series.name)}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!merge}
        title="Merge these duplicates?"
        confirmLabel="Merge"
        tone="danger"
        busy={busy}
        onClose={onClose}
        onConfirm={() => {
          if (dialog?.kind === "merge") void run(() => shelf.mergeDuplicates(dialog.group));
        }}
      >
        {merge && (
          <div className="space-y-2">
            <p>
              Keep <span className="text-foreground">“{merge.keep.title}”</span>, the copy added first.
            </p>
            <p>Remove from your library:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {merge.remove.map((b) => (
                <li key={b.id}>“{b.title}”</li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog open={dialog?.kind === "notice"} title={dialog?.kind === "notice" ? dialog.title : ""} onClose={onClose}>
        {dialog?.kind === "notice" && (
          <div className="space-y-0.5">
            {dialog.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}
      </ConfirmDialog>

      <AskDialog
        open={!!naming}
        title={naming?.kind === "rename-series" ? "Rename series" : "New series"}
        label="Series name"
        initialValue={naming?.kind === "rename-series" ? naming.series.name : ""}
        confirmLabel={naming?.kind === "rename-series" ? "Rename" : "Create"}
        onClose={onClose}
        onSubmit={(name) => {
          if (naming?.kind === "rename-series") void shelf.renameSeries(naming.series.id, name);
          else void shelf.createSeries(name);
          onClose();
        }}
      />

      {dialog?.kind === "edit-book" && (
        <EditBookDialog
          key={dialog.book.id}
          book={dialog.book}
          coverVersion={shelf.coverVersions[dialog.book.id]}
          onClose={onClose}
          onSaved={async ({ title, coverChanged }) => {
            if (coverChanged) shelf.bumpCover(dialog.book.id);
            await shelf.reload();
            if (title) onBookEdited?.({ id: dialog.book.id, title });
          }}
        />
      )}
    </>
  );
}
