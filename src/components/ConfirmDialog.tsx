"use client";

import { useEffect, type ReactNode } from "react";

/**
 * In-app confirmation (same look as AskDialog; no window.confirm). Without
 * `onConfirm` it is a plain notice with one Close button.
 */
export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "OK",
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  /** The confirmed action is running: buttons are disabled. */
  busy?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/40"
      >
        <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto text-sm text-muted">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-border px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            {onConfirm ? "Cancel" : "Close"}
          </button>
          {onConfirm && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              autoFocus
              className="rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-[#e8ddd0] hover:bg-primary-hover disabled:opacity-60"
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
