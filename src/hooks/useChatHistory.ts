"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  chatTitleFrom,
  fromSavedMessages,
  toSavedMessage,
  type ChatSummary,
  type FocusBook,
  type Message,
} from "@/components/chat/messages";

const ACTIVE_CHAT_KEY = "wab-active-chat-id";
const SESSION_KEY = "wab-home-session";

function rememberActiveChat(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_CHAT_KEY, id);
    else localStorage.removeItem(ACTIVE_CHAT_KEY);
  } catch {
    /* ignore */
  }
}

/** Saved chats ("Past notes"): list, load, autosave, delete, start afresh. */
export function useChatHistory({
  messages,
  setMessages,
  isLoading,
  focus,
  setFocus,
}: {
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  isLoading: boolean;
  focus: FocusBook | null;
  setFocus: (focus: FocusBook | null) => void;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Id of a new chat between its first save being sent and `chatId` being set.
  const newIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then((data) => setChats(data.chats || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadChat = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (!data.messages) return;
        newIdRef.current = null;
        setChatId(data.id);
        setMessages(fromSavedMessages(data.messages));
        setFocus(
          data.bookId && data.bookId !== "all"
            ? { id: data.bookId, title: data.bookTitle }
            : null
        );
        rememberActiveChat(data.id);
      } catch {
        /* ignore */
      }
    },
    [setMessages, setFocus]
  );

  // Remember which chat is active while talking (Past notes / Settings remount)
  useEffect(() => {
    rememberActiveChat(chatId);
  }, [chatId]);

  // Cold app open → blank page. Same-session remount (e.g. Settings) → resume.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (sessionStorage.getItem(SESSION_KEY) !== "1") {
          sessionStorage.setItem(SESSION_KEY, "1");
          localStorage.removeItem(ACTIVE_CHAT_KEY);
          return;
        }
        const preferred = localStorage.getItem(ACTIVE_CHAT_KEY);
        if (!preferred) return;
        const res = await fetch("/api/chats");
        const data = await res.json();
        const saved = (data.chats || []) as ChatSummary[];
        if (cancelled || !saved.some((c) => c.id === preferred)) return;
        await loadChat(preferred);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadChat]);

  // Autosave once an answer is complete (not on every streamed token).
  useEffect(() => {
    if (isLoading || messages.length < 2) return;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant" || !last.content) return;

    const id = chatId || newIdRef.current || `chat-${Date.now()}`;
    if (!chatId) newIdRef.current = id;

    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        bookId: focus?.id || "all",
        bookTitle: focus?.title || "All Books",
        title: chatTitleFrom(messages),
        messages: messages.map(toSavedMessage),
        updatedAt: new Date().toISOString(),
      }),
    })
      .then(() => {
        // Unless another chat was opened or a fresh page started meanwhile.
        if (newIdRef.current === id) {
          newIdRef.current = null;
          setChatId(id);
        }
        refresh();
      })
      .catch(() => {});
  }, [messages, isLoading, chatId, focus, refresh]);

  /** Blank page: forget the active chat (the saved copy stays in Past notes). */
  const startNew = useCallback(() => {
    newIdRef.current = null;
    setMessages([]);
    setChatId(null);
    rememberActiveChat(null);
  }, [setMessages]);

  const deleteChat = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this chat?")) return;
      try {
        await fetch("/api/chats", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: id }),
        });
        if (chatId === id) startNew();
        refresh();
      } catch {
        /* ignore */
      }
    },
    [chatId, refresh, startNew]
  );

  return { chatId, chats, loadChat, deleteChat, startNew };
}
