"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import ChatMarkdown from "@/components/ChatMarkdown";
import UploadArea from "@/components/UploadArea";
import BookLibrary, { BookLibraryHandle } from "@/components/BookLibrary";
import AwsStatusBadge from "@/components/AwsStatusBadge";
import AskDialog from "@/components/chat/AskDialog";
import PassageReader, { type PassageReaderTarget } from "@/components/chat/PassageReader";
import BrandMark from "@/components/BrandMark";
import {
  SourcesList,
  type Source,
  type SpecialistReport,
  type WhyInfo,
} from "@/components/chat/MessageExtras";
import { decodeStreamLine } from "@/lib/chat/stream-protocol";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  specialists?: SpecialistReport[];
  why?: WhyInfo;
}

interface CharacterApiResponse {
  character: string;
  found: boolean;
  type?: string;
  mentions?: number;
  books?: string[];
  relations?: Array<{ from: string; to: string; relation: string; bookId: string; location: string; evidence: string }>;
  snippets?: Array<{ bookTitle: string; location: string; snippet: string }>;
}

interface ChatSummary {
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  updatedAt: string;
}

interface BuildInfo {
  version: string;
  displayVersion: string;
  buildId: string;
  latestLabel?: string;
  startedAt: string;
}

type AskMode = "character" | "contradictions" | "quick" | null;

const COMPANION_WIDTH_KEY = "wab-companion-width";
const COMPANION_COLLAPSED_KEY = "wab-companion-collapsed";
const LEGACY_SIDEBAR_WIDTH_KEY = "wab-sidebar-width";
const LEGACY_SIDEBAR_COLLAPSED_KEY = "wab-sidebar-collapsed";
const ACTIVE_CHAT_KEY = "wab-active-chat-id";
const COMPANION_MIN = 360;
const COMPANION_MAX = 560;
const COMPANION_DEFAULT = 440;

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function clampCompanionWidth(width: number): number {
  return Math.min(COMPANION_MAX, Math.max(COMPANION_MIN, width));
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [focusBookId, setFocusBookId] = useState<string | null>(null);
  const [focusBookTitle, setFocusBookTitle] = useState<string | null>(null);
  const [publicMode, setPublicMode] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatSummary[]>([]);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [companionMode, setCompanionMode] = useState(true);
  const [askMode, setAskMode] = useState<AskMode>(null);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [passageTarget, setPassageTarget] = useState<PassageReaderTarget | null>(null);
  const [bookCount, setBookCount] = useState(0);
  const [recentTitles, setRecentTitles] = useState<string[]>([]);
  const [companionWidth, setCompanionWidth] = useState(COMPANION_DEFAULT);
  const [companionCollapsed, setCompanionCollapsed] = useState(false);
  const [hasAssistantTokens, setHasAssistantTokens] = useState(false);

  const libraryRef = useRef<BookLibraryHandle>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const resizingRef = useRef(false);

  useEffect(() => {
    try {
      const storedWidth =
        localStorage.getItem(COMPANION_WIDTH_KEY) ||
        localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY);
      if (storedWidth) {
        const parsed = Number(storedWidth);
        if (Number.isFinite(parsed)) setCompanionWidth(clampCompanionWidth(parsed));
      }
      const collapsed =
        localStorage.getItem(COMPANION_COLLAPSED_KEY) ??
        localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
      setCompanionCollapsed(collapsed === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COMPANION_WIDTH_KEY, String(companionWidth));
    } catch {
      /* ignore */
    }
  }, [companionWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(COMPANION_COLLAPSED_KEY, companionCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [companionCollapsed]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setPublicMode(data.publicMode))
      .catch(() => {});

    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setCompanionMode(data.companionMode !== false))
      .catch(() => {});

    fetch("/api/build-info")
      .then((r) => r.json())
      .then((data) =>
        setBuildInfo({
          version: data.version || "0.0.0",
          displayVersion: data.displayVersion || "v0,00",
          buildId: data.buildId || "v0.0.0-b0000000000",
          latestLabel: data.latestLabel || "",
          startedAt: data.startedAt || "",
        })
      )
      .catch(() => {});

    fetch("/api/books")
      .then((r) => r.json())
      .then((data) => {
        const books = Array.isArray(data.books) ? data.books : [];
        setBookCount(books.length);
        setRecentTitles(
          books
            .slice(0, 3)
            .map((b: { title?: string }) => String(b.title || "").trim())
            .filter(Boolean)
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setAskMode("quick");
        return;
      }

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const typing =
        tag === "textarea" ||
        tag === "input" ||
        target?.isContentEditable === true;
      if (typing) return;

      if (event.key === "]") {
        event.preventDefault();
        setCompanionCollapsed((prev) => !prev);
      } else if (event.key === "[") {
        event.preventDefault();
        setCompanionCollapsed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!resizingRef.current || companionCollapsed) return;
      setCompanionWidth(clampCompanionWidth(window.innerWidth - event.clientX));
    };
    const onMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [companionCollapsed]);

  const startCompanionResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const refreshChatHistory = useCallback(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then((data) => setChatHistory(data.chats || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshChatHistory();
  }, [refreshChatHistory]);

  const loadChatById = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chats?id=${id}`);
      const data = await res.json();
      if (data.messages) {
        setChatId(data.id);
        setMessages(
          (data.messages as Message[]).map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.sources?.length ? { sources: m.sources } : {}),
          }))
        );
        if (data.bookId && data.bookId !== "all") {
          setFocusBookId(data.bookId);
          setFocusBookTitle(data.bookTitle);
        } else {
          setFocusBookId(null);
          setFocusBookTitle(null);
        }
        try {
          localStorage.setItem(ACTIVE_CHAT_KEY, data.id);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Remember which chat is active across Settings / remounts
  useEffect(() => {
    try {
      if (chatId) localStorage.setItem(ACTIVE_CHAT_KEY, chatId);
      else localStorage.removeItem(ACTIVE_CHAT_KEY);
    } catch {
      /* ignore */
    }
  }, [chatId]);

  // Restore last (or most recent) chat when landing on home
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const preferred =
          typeof window !== "undefined" ? localStorage.getItem(ACTIVE_CHAT_KEY) : null;
        const res = await fetch("/api/chats");
        const data = await res.json();
        const chats = (data.chats || []) as ChatSummary[];
        if (cancelled || !chats.length) return;
        const targetId =
          preferred && chats.some((c) => c.id === preferred) ? preferred : chats[0].id;
        if (!cancelled) await loadChatById(targetId);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadChatById]);

  const scrollToMessages = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToMessages();
  }, [messages, scrollToMessages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, [input]);

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setThinkingSteps([]);
  }, []);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const bookId = focusBookId || "all";
    const bookTitle = focusBookTitle || "All Books";

    const userMessage: Message = { role: "user", content: trimmed };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setThinkingSteps([]);
    setHasAssistantTokens(false);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, bookTitle, messages: newMessages }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to get response");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      let streamBuffer = "";
      let addedAssistantMessage = false;
      let receivedTokens = false;

      const ensureAssistantMessage = () => {
        if (!addedAssistantMessage) {
          addedAssistantMessage = true;
          setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
        }
      };

      const updateAssistantContent = (content: string) => {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content,
          };
          return updated;
        });
      };

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          streamBuffer += decoder.decode(value, { stream: true });
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const decoded = decodeStreamLine(line);
            if (!decoded) continue;

            const { type, data } = decoded;

            if (type === "STATUS") {
              setThinkingSteps((prev) => [...prev, data]);
            } else if (type === "TOKEN") {
              setThinkingSteps([]);
              ensureAssistantMessage();
              receivedTokens = true;
              setHasAssistantTokens(true);
              assistantContent += data;
              updateAssistantContent(assistantContent);
            } else if (type === "TEXT") {
              setThinkingSteps([]);
              ensureAssistantMessage();
              // TOKEN appends; TEXT replaces (non-stream paths send the full answer once).
              // If tokens already started, ignore TEXT to avoid duplicating streamed content.
              if (!receivedTokens) {
                assistantContent = data;
                updateAssistantContent(assistantContent);
                setHasAssistantTokens(true);
              }
            } else if (type === "SOURCES") {
              try {
                const parsed = JSON.parse(data) as Source[];
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    sources: parsed,
                  };
                  return updated;
                });
              } catch {
                /* ignore parse errors */
              }
            } else if (type === "SPECIALISTS") {
              try {
                const parsed = JSON.parse(data) as SpecialistReport[];
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    specialists: parsed,
                  };
                  return updated;
                });
              } catch {
                /* ignore parse errors */
              }
            } else if (type === "WHY") {
              try {
                const parsed = JSON.parse(data) as WhyInfo;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    why: parsed,
                  };
                  return updated;
                });
              } catch {
                /* ignore parse errors */
              }
            } else if (type === "LIBRARY_CHANGED") {
              try {
                const payload = JSON.parse(data) as { clearFocus?: boolean };
                if (payload.clearFocus) {
                  setFocusBookId(null);
                  setFocusBookTitle(null);
                }
              } catch {
                setFocusBookId(null);
                setFocusBookTitle(null);
              }
              libraryRef.current?.refresh();
            } else if (type === "ERROR") {
              throw new Error(data);
            }
          }
        }
      }

      if (!addedAssistantMessage) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "I wasn't able to generate a response." },
        ]);
      }
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, something went wrong: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setIsLoading(false);
      setThinkingSteps([]);
    }
  }, [input, isLoading, messages, focusBookId, focusBookTitle]);

  const runCharacterLookup = useCallback(async (target: string) => {
    const name = target.trim();
    if (!name) return;
    const userMessage: Message = { role: "user", content: `Show character page for ${name}` };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    try {
      const res = await fetch(`/api/knowledge?mode=character&character=${encodeURIComponent(name)}`);
      const data = (await res.json()) as CharacterApiResponse;
      const text = !data.found
        ? `I couldn't find a character profile for **${name}** yet.`
        : [
            `## Character Page: ${data.character}`,
            "",
            `- Type: **${data.type || "unknown"}**`,
            `- Mentions tracked: **${data.mentions ?? 0}**`,
            `- Books in graph: **${data.books?.length ?? 0}**`,
            "",
            "### Relationship edges",
            ...(data.relations?.slice(0, 8).map((r) => `- ${r.from} -> ${r.to} (${r.relation}, ${r.location})`) || [
              "- No relationships available yet.",
            ]),
            "",
            "### Evidence snippets",
            ...(data.snippets?.slice(0, 8).map((s) => `- **${s.bookTitle}** (${s.location}): ${s.snippet}`) || [
              "- No snippets available yet.",
            ]),
          ].join("\n");
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Failed to load character page: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const runContradictionCheck = useCallback(async (target: string) => {
    const topic = target.trim();
    if (!topic) return;
    const userMessage: Message = { role: "user", content: `Check contradictions for ${topic}` };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    try {
      const res = await fetch(`/api/knowledge?mode=contradictions&q=${encodeURIComponent(topic)}`);
      const data = (await res.json()) as { contradictions?: string[] };
      const rows = data.contradictions || [];
      const text = rows.length
        ? `## Cross-book contradictions for ${topic}\n\n${rows.map((r) => `- ${r}`).join("\n")}`
        : `I didn't detect obvious contradictions for **${topic}** across the indexed books.`;
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Failed to run contradiction check: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleQuickAction = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;

      if (trimmed === "new") {
        setMessages([]);
        setChatId(null);
        textareaRef.current?.focus();
        return;
      }
      if (trimmed === "all") {
        setFocusBookId(null);
        setFocusBookTitle(null);
        setMessages([]);
        setChatId(null);
        textareaRef.current?.focus();
        return;
      }
      if (trimmed.toLowerCase().startsWith("character:")) {
        const name = trimmed.split(":").slice(1).join(":").trim();
        if (name) void runCharacterLookup(name);
        return;
      }
      if (trimmed.toLowerCase().startsWith("contradictions:")) {
        const topic = trimmed.split(":").slice(1).join(":").trim();
        if (topic) void runContradictionCheck(topic);
      }
    },
    [runCharacterLookup, runContradictionCheck]
  );

  const handleAskSubmit = useCallback(
    (value: string) => {
      const mode = askMode;
      setAskMode(null);
      if (mode === "character") {
        void runCharacterLookup(value);
      } else if (mode === "contradictions") {
        void runContradictionCheck(value);
      } else if (mode === "quick") {
        handleQuickAction(value);
      }
    },
    [askMode, runCharacterLookup, runContradictionCheck, handleQuickAction]
  );

  useEffect(() => {
    if (messages.length < 2) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "assistant" || !lastMsg.content) return;

    const id = chatId || `chat-${Date.now()}`;
    if (!chatId) setChatId(id);

    const firstUser = messages.find((m) => m.role === "user")?.content || "";
    const title =
      firstUser.length > 40
        ? `${firstUser.slice(0, 32)}…`
        : firstUser.slice(0, 40) || "Chat";
    const bookId = focusBookId || "all";
    const bookTitle = focusBookTitle || "All Books";

    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        bookId,
        bookTitle,
        title,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.sources?.length ? { sources: m.sources } : {}),
        })),
        updatedAt: new Date().toISOString(),
      }),
    })
      .then(() => refreshChatHistory())
      .catch(() => {});
  }, [messages, chatId, focusBookId, focusBookTitle, refreshChatHistory]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const handleBookLoaded = useCallback((id: string, title: string) => {
    libraryRef.current?.refresh();
    setFocusBookId(id);
    setFocusBookTitle(title);
    textareaRef.current?.focus();
  }, []);

  const handleSelectBook = useCallback(
    (book: { id: string; title: string }) => {
      if (focusBookId === book.id) {
        setFocusBookId(null);
        setFocusBookTitle(null);
      } else {
        setFocusBookId(book.id);
        setFocusBookTitle(book.title);
      }
      textareaRef.current?.focus();
    },
    [focusBookId]
  );

  const clearFocus = useCallback(() => {
    setFocusBookId(null);
    setFocusBookTitle(null);
  }, []);

  const deleteChatById = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!window.confirm("Delete this chat?")) return;
      try {
        await fetch("/api/chats", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: id }),
        });
        if (chatId === id) {
          setMessages([]);
          setChatId(null);
          try {
            localStorage.removeItem(ACTIVE_CHAT_KEY);
          } catch {
            /* ignore */
          }
        }
        refreshChatHistory();
      } catch {
        /* ignore */
      }
    },
    [chatId, refreshChatHistory]
  );

  const startNewChat = useCallback(() => {
    setMessages([]);
    setChatId(null);
    try {
      localStorage.removeItem(ACTIVE_CHAT_KEY);
    } catch {
      /* ignore */
    }
    textareaRef.current?.focus();
  }, []);

  const handleBooksChanged = useCallback(() => {
    libraryRef.current?.refresh();
    fetch("/api/books")
      .then((r) => r.json())
      .then((data) => {
        const books = Array.isArray(data.books) ? data.books : [];
        setBookCount(books.length);
        setRecentTitles(
          books
            .slice(0, 3)
            .map((b: { title?: string }) => String(b.title || "").trim())
            .filter(Boolean)
        );
      })
      .catch(() => {});
  }, []);

  const askDialogTitle =
    askMode === "character"
      ? "Character page"
      : askMode === "contradictions"
        ? "Cross-book contradictions"
        : "Quick action";

  const askDialogLabel =
    askMode === "character"
      ? "Character name"
      : askMode === "contradictions"
        ? "Entity or topic"
        : "Command";

  const askDialogPlaceholder =
    askMode === "character"
      ? "Example: Joe Bishop"
      : askMode === "contradictions"
        ? "Entity or topic to check"
        : "new · all · character:Name · contradictions:Topic";

  const buildTitle = buildInfo
    ? buildInfo.startedAt
      ? `${buildInfo.latestLabel || `v${buildInfo.version} · ${buildInfo.buildId}`}\nStarted: ${new Date(buildInfo.startedAt).toLocaleString()}`
      : buildInfo.latestLabel || `v${buildInfo.version} · ${buildInfo.buildId}`
    : undefined;

  const showPresence =
    isLoading && thinkingSteps.length > 0 && !hasAssistantTokens;

  const companionSuggestions = focusBookId
    ? [
        "What's this one about?",
        "Who matters most here?",
        "Any pop-culture references?",
        "Find a memorable quote",
      ]
    : bookCount > 0
      ? [
          "Any pop culture references in the books?",
          "Who shows up across the series?",
          "Help me pick what to reread",
          "How many times is Skippy mentioned in the first 7 books?",
        ]
      : ["What can you do?", "How do I add a book?"];

  const titlesPhrase =
    recentTitles.length > 0
      ? recentTitles.length === 1
        ? recentTitles[0]
        : recentTitles.length === 2
          ? `${recentTitles[0]} and ${recentTitles[1]}`
          : `${recentTitles[0]}, ${recentTitles[1]}…`
      : "";
  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <header className="flex shrink-0 items-center gap-4 border-b border-border/40 px-6 py-4 sm:px-8">
        <BrandMark className="h-12 w-12 shrink-0 shadow-sm shadow-black/5" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            What About This Book?
          </h1>
          <p className="mt-0.5 text-sm text-muted">A reading room for the books you keep</p>
        </div>
        <AwsStatusBadge />
        {companionCollapsed && (
          <button
            type="button"
            onClick={() => setCompanionCollapsed(false)}
            className="rounded-xl border border-border/50 bg-surface px-3.5 py-2 text-sm text-muted transition-colors hover:border-border hover:text-foreground"
            title="Open companion (])"
          >
            Notes
          </button>
        )}
        <Link
          href="/settings"
          className="settings-orb inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-border/50 bg-surface text-muted transition-all hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
          title={buildTitle ? `Settings · ${buildTitle}` : "Settings"}
          aria-label="Settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3.25" />
            <path d="M12 2.75v2.1" />
            <path d="M12 19.15v2.1" />
            <path d="m19.45 7.2-1.82 1.05" />
            <path d="m6.37 15.75-1.82 1.05" />
            <path d="m19.45 16.8-1.82-1.05" />
            <path d="m6.37 8.25-1.82-1.05" />
            <circle cx="12" cy="12" r="8.5" opacity="0.35" />
          </svg>
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Library stage — the room */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6 sm:px-8 sm:py-7">
            {!publicMode && (
              <div className="max-w-xl">
                <UploadArea
                  onBookLoaded={handleBookLoaded}
                  onBooksChanged={handleBooksChanged}
                  compact
                />
              </div>
            )}

            <section className="min-h-0 flex-1">
              <BookLibrary
                ref={libraryRef}
                onSelectBook={handleSelectBook}
                activeBookId={focusBookId}
                readOnly={publicMode}
                variant="shelf"
              />
            </section>
          </div>
        </main>

        {!companionCollapsed && (
          <>
            <div
              className="sidebar-resizer"
              onMouseDown={startCompanionResize}
              title="Drag to resize"
              role="separator"
              aria-orientation="vertical"
            />

            {/* Companion journal — not a chat clone */}
            <aside
              className="flex shrink-0 flex-col border-l border-border/40 bg-surface/70 backdrop-blur-[2px]"
              style={{ width: companionWidth }}
            >
              <div className="flex items-start gap-3 border-b border-border/35 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
                    Companion notes
                  </p>
                  {focusBookId ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <p className="truncate font-display text-base font-semibold leading-snug">
                        {focusBookTitle}
                      </p>
                      <button
                        type="button"
                        onClick={clearFocus}
                        className="shrink-0 rounded-full p-1 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                        title="Ask across all books"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <p className="mt-1.5 font-display text-base font-semibold leading-snug">
                      {bookCount > 0 ? "Across your shelves" : "Waiting for a book"}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setCompanionCollapsed(true)}
                  className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                  title="Hide notes (])"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
              </div>

              <div className="shrink-0 border-b border-border/30 px-5 py-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setChatsOpen((prev) => !prev)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="text-[12px] font-medium text-muted">Past notes</span>
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
                      className={`text-muted transition-transform ${chatsOpen ? "rotate-180" : ""}`}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      startNewChat();
                    }}
                    className="text-[13px] font-medium text-primary transition-colors hover:text-primary-hover"
                  >
                    + Fresh page
                  </button>
                </div>

                {chatsOpen && (
                  <div className="mt-2.5 max-h-[22vh] overflow-y-auto">
                    {chatHistory.length === 0 ? (
                      <p className="py-2 text-xs leading-relaxed text-muted">
                        Conversations you start will land here.
                      </p>
                    ) : (
                      <div className="space-y-0.5">
                        {chatHistory.slice(0, 20).map((chat) => (
                          <div
                            key={chat.id}
                            className={`group flex items-start gap-1 rounded-xl px-2.5 py-2 transition-colors ${
                              chatId === chat.id
                                ? "bg-primary/10 text-primary"
                                : "text-foreground hover:bg-surface-hover"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => loadChatById(chat.id)}
                              className="min-w-0 flex-1 text-left text-[13px]"
                            >
                              <p className="truncate font-medium">{chat.title}</p>
                              <p className="mt-0.5 truncate text-[11px] text-muted">
                                {chat.bookTitle} · {new Date(chat.updatedAt).toLocaleDateString()}
                              </p>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => void deleteChatById(chat.id, e)}
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
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-5">
                <div className="space-y-8">
                  {messages.length === 0 && (
                    <div className="animate-fade-in py-6">
                      {companionMode ? (
                        <>
                          <p className="font-display text-xl font-semibold leading-snug tracking-tight">
                            {bookCount > 0
                              ? `Ready whenever you are — ${bookCount} book${bookCount === 1 ? "" : "s"} on the shelves.`
                              : "Drop a book on the left, then ask anything."}
                          </p>
                          {titlesPhrase && (
                            <p className="mt-3 text-sm leading-relaxed text-muted">
                              Lately that includes {titlesPhrase}
                            </p>
                          )}
                          <div className="mt-6 flex flex-col gap-2">
                            {companionSuggestions.map((suggestion) => (
                              <button
                                key={suggestion}
                                type="button"
                                onClick={() => {
                                  setInput(suggestion);
                                  textareaRef.current?.focus();
                                }}
                                className="rounded-xl border border-transparent px-3 py-2.5 text-left text-[14px] text-muted transition-colors hover:border-border/50 hover:bg-surface-hover hover:text-foreground"
                              >
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p className="font-display text-lg text-muted">Ask about a book</p>
                      )}
                    </div>
                  )}

                  {messages.map((message, i) => {
                    const isUser = message.role === "user";
                    return (
                      <article key={i} className="animate-fade-in">
                        {isUser ? (
                          <div className="border-b border-border/30 pb-6">
                            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
                              You asked
                            </p>
                            <p className="font-display text-[1.05rem] leading-snug whitespace-pre-wrap">
                              {message.content}
                            </p>
                          </div>
                        ) : (
                          <div>
                            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-primary/85">
                              From the pages
                            </p>
                            <div className="prose-ai text-[15px]">
                              <ChatMarkdown content={message.content} />
                            </div>
                          </div>
                        )}

                        {message.sources && message.sources.length > 0 && (
                          <div className="mt-4">
                            <SourcesList
                              sources={message.sources}
                              onOpenPassage={(source) =>
                                setPassageTarget({
                                  bookId: source.bookId,
                                  book: source.book,
                                  position: source.position,
                                  excerpt: source.excerpt,
                                })
                              }
                            />
                          </div>
                        )}
                      </article>
                    );
                  })}

                  {showPresence && (
                    <div className="animate-fade-in space-y-2.5 border-l-2 border-primary/35 pl-4">
                      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
                        Looking through
                      </p>
                      {thinkingSteps.map((step, i) => {
                        const isLatest = i === thinkingSteps.length - 1;
                        return (
                          <p
                            key={i}
                            className={`text-sm ${isLatest ? "text-foreground" : "text-muted opacity-65"}`}
                          >
                            {step}
                          </p>
                        );
                      })}
                    </div>
                  )}

                  {isLoading &&
                    thinkingSteps.length === 0 &&
                    !hasAssistantTokens &&
                    messages[messages.length - 1]?.role === "user" && (
                      <p className="animate-fade-in text-sm italic text-muted">Turning a page…</p>
                    )}

                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className="shrink-0 border-t border-border/35 px-5 py-4">
                <div className="flex items-end gap-2.5">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      focusBookId
                        ? `Ask about ${focusBookTitle}…`
                        : "Write a note or question…"
                    }
                    rows={2}
                    className="flex-1 resize-none rounded-none border-0 border-b border-border/55 bg-transparent px-0 py-2 text-[15px] outline-none transition-colors placeholder:text-muted focus:border-primary/70"
                  />
                  {isLoading ? (
                    <button
                      type="button"
                      onClick={stopGeneration}
                      className="mb-1 shrink-0 rounded-xl border border-border/50 bg-surface px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
                      title="Stop"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={sendMessage}
                      disabled={!input.trim()}
                      className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-[#e8ddd0] transition-colors hover:bg-primary-hover disabled:opacity-40 disabled:hover:bg-primary"
                      title="Send"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 12 7-7 7 7" />
                        <path d="M12 19V5" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </aside>
          </>
        )}
      </div>

      <AskDialog
        open={askMode !== null}
        title={askDialogTitle}
        label={askDialogLabel}
        placeholder={askDialogPlaceholder}
        confirmLabel={askMode === "quick" ? "Run" : "Ask"}
        onClose={() => setAskMode(null)}
        onSubmit={handleAskSubmit}
      />

      <PassageReader
        target={passageTarget}
        onClose={() => setPassageTarget(null)}
        onAskAbout={(prompt) => {
          setInput(prompt);
          textareaRef.current?.focus();
        }}
      />
    </div>
  );
}
