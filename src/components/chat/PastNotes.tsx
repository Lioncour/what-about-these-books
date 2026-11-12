"use client";

import type { ChatSummary } from "@/components/chat/messages";

/** The "Past notes" drawer: saved chats, newest first. */
export default function PastNotes({
  chats,
  activeChatId,
  onOpen,
  onDelete,
}: {
  chats: ChatSummary[];
  activeChatId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="max-h-[22vh] overflow-y-auto border-y border-border/25 px-6 py-3 sm:px-10 lg:px-14">
      {chats.length === 0 ? (
        <p className="py-1 text-xs leading-relaxed text-muted">
          Conversations you start will land here.
        </p>
      ) : (
        <div className="grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3">
          {chats.slice(0, 20).map((chat) => (
            <div
              key={chat.id}
              className={`group flex items-start gap-1 rounded-lg px-2.5 py-2 transition-colors ${
                activeChatId === chat.id
                  ? "bg-primary/10 text-primary"
                  : "text-foreground hover:bg-surface-hover/80"
              }`}
            >
              <button
                type="button"
                onClick={() => onOpen(chat.id)}
                className="min-w-0 flex-1 text-left text-[13px]"
              >
                <p className="truncate font-medium">{chat.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted">
                  {chat.bookTitle} · {new Date(chat.updatedAt).toLocaleDateString()}
                </p>
              </button>
              <button
                type="button"
                onClick={() => onDelete(chat.id)}
                className="mt-0.5 shrink-0 rounded p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                title="Delete"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
