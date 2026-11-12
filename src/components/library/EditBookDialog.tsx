"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import BookCover from "@/components/library/BookCover";
import { bookEditPatch, coverFileProblem } from "@/components/library/shelf";
import type { Book } from "@/components/library/types";

const FIELD =
  "mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted/70 focus:border-primary";

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (res.status === 403) return "Editing is turned off while the library is shared read-only.";
  return `${fallback} (${res.status}).`;
}

/**
 * Manage → Edit on a book: title, author and a replacement cover. Mount it per
 * book (keyed by id) so the fields start from that book. Escape closes, Enter saves.
 */
export default function EditBookDialog({
  book,
  coverVersion,
  onSaved,
  onClose,
}: {
  book: Book;
  coverVersion?: number;
  /** Something was stored; `coverChanged` when a new cover went up. */
  onSaved: (change: { title?: string; coverChanged: boolean }) => void | Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  // The chosen image's preview URL is released when it is replaced or the dialog goes.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const chooseFile = (chosen: File | undefined) => {
    if (!chosen) return;
    const problem = coverFileProblem(chosen);
    setError(problem);
    if (problem) return;
    setFile(chosen);
    setPreview(URL.createObjectURL(chosen));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const patch = bookEditPatch(book, { title, author });
    if (patch && "error" in patch) {
      setError(patch.error);
      return;
    }
    if (!patch && !file) {
      onClose();
      return;
    }
    setSaving(true);
    setError("");
    let stored = false;
    try {
      if (patch) {
        const res = await fetch("/api/books", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(await errorFrom(res, "The book could not be saved"));
        stored = true;
      }
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/covers/${encodeURIComponent(book.id)}`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const reason = await errorFrom(res, "The cover could not be replaced");
          throw new Error(stored ? `Title and author are saved, but not the cover: ${reason}` : reason);
        }
      }
      await onSaved({ title: patch?.title, coverChanged: !!file });
      onClose();
    } catch (err) {
      // What did get stored should still show on the shelves.
      if (stored) await onSaved({ title: patch?.title, coverChanged: false });
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Edit book"
        onSubmit={save}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/40"
      >
        <h3 className="font-display text-lg font-semibold tracking-tight">Edit book</h3>

        <label className="mt-4 block text-xs font-medium text-muted">
          Title
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
            className={`${FIELD} text-foreground`}
          />
        </label>
        <label className="mt-3 block text-xs font-medium text-muted">
          Author
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            disabled={saving}
            placeholder="Unknown"
            className={`${FIELD} text-foreground`}
          />
        </label>

        <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-muted/90">Cover</p>
        <div className="mt-2 flex items-center gap-4">
          <div className="aspect-[2/3] w-20 shrink-0 overflow-hidden rounded-lg border border-border/60">
            {preview ? (
              // A local object URL for the image just picked.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="New cover" className="h-full w-full object-cover" />
            ) : (
              <BookCover bookId={book.id} title={book.title} hasCover={book.hasCover} version={coverVersion} />
            )}
          </div>
          <div className="min-w-0">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                chooseFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={saving}
              className="rounded-xl border border-border px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
            >
              Replace cover
            </button>
            <p className="mt-1.5 truncate text-[11px] text-muted">
              {file ? file.name : "PNG, JPEG or WebP, up to 5 MB"}
            </p>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-border px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-[#e8ddd0] hover:bg-primary-hover disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
