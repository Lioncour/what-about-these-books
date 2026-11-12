"use client";

import type { FocusBook } from "@/components/chat/messages";

/** Above the conversation: what is being talked about, Past notes toggle, Fresh page. */
export default function ChatHeader({
  focus,
  pickedCount,
  bookCount,
  pastNotesOpen,
  onClearFocus,
  onTogglePastNotes,
  onNewChat,
}: {
  focus: FocusBook | null;
  /** Books picked by hand for the next question (two or more). */
  pickedCount?: number;
  bookCount: number;
  pastNotesOpen: boolean;
  onClearFocus: () => void;
  onTogglePastNotes: () => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-6 py-3.5 sm:px-10 lg:px-14">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted/90">
          Companion notes
        </p>
        {focus ? (
          <div className="mt-1 flex items-center gap-2">
            <p className="truncate font-display text-lg font-semibold leading-snug sm:text-xl">
              {focus.title}
            </p>
            <button
              type="button"
              onClick={onClearFocus}
              className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              title="Ask across all books"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <p className="mt-1 font-display text-lg font-semibold leading-snug sm:text-xl">
            {pickedCount && pickedCount >= 2
              ? `Across ${pickedCount} picked books`
              : bookCount > 0
                ? "Across your shelves"
                : "Waiting for a book"}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onTogglePastNotes}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          Past notes
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${pastNotesOpen ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onNewChat}
          className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10 hover:text-primary-hover"
        >
          Fresh page
        </button>
      </div>
    </div>
  );
}
