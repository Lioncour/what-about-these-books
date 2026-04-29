"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import UploadArea from "@/components/UploadArea";
import BookLibrary, { BookLibraryHandle } from "@/components/BookLibrary";

interface Source {
  book: string;
  excerpt: string;
  position?: string;
}

interface SpecialistReport {
  bookTitle: string;
  confidence: "high" | "medium" | "low";
  numericEstimate: number | null;
  directAnswer: string;
  findingsCount: number;
  topFindings: { finding: string; location: string }[];
  caveats: string[];
  reasked?: boolean;
  scorecard?: { precisionEstimate: number; recallEstimate: number; total: number };
}

interface WhyInfo {
  groundedMode: boolean;
  sourceCount: number;
  specialistModelId: string;
  orchestratorModelId: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  specialists?: SpecialistReport[];
  why?: WhyInfo;
}

function SourcesList({ sources, onCitationClick }: { sources: Source[]; onCitationClick?: (source: Source) => void }) {
  const [expanded, setExpanded] = useState(false);
  const uniqueBooks = [...new Set(sources.map((s) => s.book))];

  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-xs text-muted transition-colors hover:text-foreground"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        </svg>
        <span className="font-medium">
          {sources.length} source{sources.length !== 1 ? "s" : ""} from{" "}
          {uniqueBooks.length === 1
            ? `"${uniqueBooks[0]}"`
            : `${uniqueBooks.length} books`}
        </span>
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
          className={`ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {sources.map((source, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">
                  {i + 1}
                </span>
                <span className="flex-1 truncate">{source.book}</span>
                {source.position && (
                  <span className="shrink-0 rounded bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted">
                    {source.position}
                  </span>
                )}
              </div>
              <button
                onClick={() => onCitationClick?.(source)}
                className="mt-0.5 pl-[22px] text-left text-muted leading-relaxed hover:text-foreground"
              >
                &ldquo;{source.excerpt}...&rdquo;
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpecialistReportsList({ reports }: { reports: SpecialistReport[] }) {
  const [expanded, setExpanded] = useState(false);
  const high = reports.filter((r) => r.confidence === "high").length;
  const med = reports.filter((r) => r.confidence === "medium").length;
  const low = reports.filter((r) => r.confidence === "low").length;

  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-xs text-muted transition-colors hover:text-foreground"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v20" />
          <path d="M2 12h20" />
        </svg>
        <span className="font-medium">
          Specialist reports: {reports.length} (high {high}, medium {med}, low {low})
        </span>
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
          className={`ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {reports.map((r) => (
            <div key={r.bookTitle} className="rounded-lg border border-border bg-surface px-2 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{r.bookTitle}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                  r.confidence === "high"
                    ? "bg-green-500/15 text-green-600 dark:text-green-400"
                    : r.confidence === "medium"
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : "bg-red-500/15 text-red-600 dark:text-red-400"
                }`}>
                  {r.confidence}
                </span>
                {r.numericEstimate !== null && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    estimate: {r.numericEstimate}
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted">{r.directAnswer}</p>
              {r.reasked && <p className="mt-1 text-[11px] text-amber-500">Auto re-asked specialist due to low confidence.</p>}
              {r.scorecard && (
                <p className="mt-1 text-[11px] text-muted">
                  QA scorecard: precision {r.scorecard.precisionEstimate}, recall {r.scorecard.recallEstimate}, n={r.scorecard.total}
                </p>
              )}
              {r.topFindings.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-muted">
                  {r.topFindings.map((f, i) => (
                    <li key={i}>
                      - {f.finding} <span className="text-[10px]">({f.location})</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.caveats.length > 0 && (
                <p className="mt-1 text-[11px] text-muted">Caveats: {r.caveats.join("; ")}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WhyPanel({ why }: { why: WhyInfo }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted">
      <p className="font-medium text-foreground">Why this answer</p>
      <p>Grounded mode: {why.groundedMode ? "strict" : "off"}</p>
      <p>Sources used: {why.sourceCount}</p>
      <p>Specialist model: {why.specialistModelId}</p>
      <p>Orchestrator model: {why.orchestratorModelId}</p>
    </div>
  );
}

interface ChatSummary {
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  updatedAt: string;
}

interface AISettings {
  language: string;
  tone: string;
  customInstructions: string;
  focusAreas: string[];
  groundedMode?: boolean;
  modelRouting?: {
    specialistModelId?: string;
    orchestratorModelId?: string;
    extractionModelId?: string;
  };
}

interface BuildInfo {
  version: string;
  displayVersion: string;
  buildId: string;
  latestLabel?: string;
  startedAt: string;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [focusAreaInput, setFocusAreaInput] = useState("");
  const [settings, setSettings] = useState<AISettings>({
    language: "Auto",
    tone: "Scientific",
    customInstructions: "",
    focusAreas: [],
    groundedMode: false,
    modelRouting: {},
  });
  const libraryRef = useRef<BookLibraryHandle>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setPublicMode(data.publicMode))
      .catch(() => {});

    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) =>
        setSettings({
          language: data.language || "Auto",
          tone: data.tone || "Scientific",
          customInstructions: data.customInstructions || "",
          focusAreas: Array.isArray(data.focusAreas) ? data.focusAreas : [],
          groundedMode: Boolean(data.groundedMode),
          modelRouting: data.modelRouting || {},
        })
      )
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

  }, []);

  const saveSettings = useCallback(async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSettingsOpen(false);
  }, [settings]);

  const addFocusArea = useCallback(() => {
    const value = focusAreaInput.trim();
    if (!value) return;
    if (settings.focusAreas.includes(value)) return;
    setSettings((prev) => ({ ...prev, focusAreas: [...prev.focusAreas, value] }));
    setFocusAreaInput("");
  }, [focusAreaInput, settings.focusAreas]);

  const refreshChatHistory = useCallback(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then((data) => setChatHistory(data.chats || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshChatHistory();
  }, [refreshChatHistory]);

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

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, bookTitle, messages: newMessages }),
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

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          streamBuffer += decoder.decode(value, { stream: true });
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() || "";

          for (const line of lines) {
            const colonIdx = line.indexOf(":");
            if (colonIdx === -1) {
              // Multiline TEXT payloads can arrive as continuation lines without a prefix.
              // Treat those lines as assistant text instead of dropping them.
              if (addedAssistantMessage) {
                assistantContent += `\n${line}`;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantContent,
                  };
                  return updated;
                });
              }
              continue;
            }

            const type = line.slice(0, colonIdx);
            const data = line.slice(colonIdx + 1);

            if (type === "STATUS") {
              setThinkingSteps((prev) => [...prev, data]);
            } else if (type === "TEXT") {
              if (!addedAssistantMessage) {
                addedAssistantMessage = true;
                setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
              }
              assistantContent += data;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                };
                return updated;
              });
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
              } catch { /* ignore parse errors */ }
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
              } catch { /* ignore parse errors */ }
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
              } catch { /* ignore parse errors */ }
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
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, something went wrong: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
      setThinkingSteps([]);
    }
  }, [input, isLoading, messages, focusBookId, focusBookTitle, chatId]);

  useEffect(() => {
    if (messages.length < 2) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "assistant" || !lastMsg.content) return;

    const id = chatId || `chat-${Date.now()}`;
    if (!chatId) setChatId(id);

    const title = messages[0].content.slice(0, 60);
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
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        updatedAt: new Date().toISOString(),
      }),
    }).then(() => refreshChatHistory()).catch(() => {});
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

  const handleBookLoaded = useCallback(
    (_id: string, _title: string, _wordCount: number) => {
      libraryRef.current?.refresh();
    },
    []
  );

  const handleSelectBook = useCallback(
    (book: { id: string; title: string }) => {
      if (focusBookId === book.id) {
        setFocusBookId(null);
        setFocusBookTitle(null);
      } else {
        setFocusBookId(book.id);
        setFocusBookTitle(book.title);
      }
      setMessages([]);
      setChatId(null);
      textareaRef.current?.focus();
    },
    [focusBookId]
  );

  const clearFocus = useCallback(() => {
    setFocusBookId(null);
    setFocusBookTitle(null);
    setMessages([]);
    setChatId(null);
  }, []);

  const loadChatById = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chats?id=${id}`);
      const data = await res.json();
      if (data.messages) {
        setChatId(data.id);
        setMessages(data.messages);
        if (data.bookId && data.bookId !== "all") {
          setFocusBookId(data.bookId);
          setFocusBookTitle(data.bookTitle);
        } else {
          setFocusBookId(null);
          setFocusBookTitle(null);
        }
      }
    } catch { /* ignore */ }
  }, []);

  const startNewChat = useCallback(() => {
    setMessages([]);
    setChatId(null);
    textareaRef.current?.focus();
  }, []);

  const handleBooksChanged = useCallback(() => {
    libraryRef.current?.refresh();
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left side — library */}
      <aside className="flex w-1/2 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
              <path d="M8 7h6" />
              <path d="M8 11h4" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold leading-tight tracking-tight">What About This Book?</h1>
            <p className="text-[11px] text-muted">AI-powered book companion</p>
          </div>
          {buildInfo && (
            <div
              className="rounded-full border border-primary/50 bg-primary/20 px-3 py-1 text-[11px] font-extrabold tracking-wide text-primary"
              title={
                buildInfo.startedAt
                  ? `${buildInfo.latestLabel || `LATEST BUILD • v${buildInfo.version} • ${buildInfo.buildId}`}\nStarted: ${new Date(buildInfo.startedAt).toLocaleString()}`
                  : buildInfo.latestLabel || `LATEST BUILD • v${buildInfo.version} • ${buildInfo.buildId}`
              }
            >
              {buildInfo.latestLabel || `LATEST BUILD • v${buildInfo.version}`}
            </div>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="ml-auto rounded-lg border border-border p-2 text-muted transition-colors hover:text-foreground"
            title="AI settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-1.94 1.5l-.17.7a2 2 0 0 1-1.45 1.45l-.7.17a2 2 0 0 0-1.5 1.94v.44a2 2 0 0 0 1.5 1.94l.7.17a2 2 0 0 1 1.45 1.45l.17.7a2 2 0 0 0 1.94 1.5h.44a2 2 0 0 0 1.94-1.5l.17-.7a2 2 0 0 1 1.45-1.45l.7-.17a2 2 0 0 0 1.5-1.94v-.44a2 2 0 0 0-1.5-1.94l-.7-.17a2 2 0 0 1-1.45-1.45l-.17-.7A2 2 0 0 0 12.22 2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex flex-1 flex-col gap-4 p-5">
          {!publicMode && (
            <UploadArea
              onBookLoaded={handleBookLoaded}
              onBooksChanged={handleBooksChanged}
              compact
            />
          )}

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
            <section className="min-h-0 overflow-y-auto rounded-xl border border-border bg-background p-3">
              <BookLibrary
                ref={libraryRef}
                onSelectBook={handleSelectBook}
                activeBookId={focusBookId}
                readOnly={publicMode}
              />
            </section>

            <section className="min-h-0 overflow-y-auto space-y-4 rounded-xl border border-border bg-background p-3">
              {chatHistory.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
                      Recent Chats
                    </h2>
                    <button
                      onClick={startNewChat}
                      className="text-xs font-medium text-primary hover:text-primary-hover transition-colors"
                    >
                      + New
                    </button>
                  </div>
                  <div className="space-y-1">
                    {chatHistory.slice(0, 20).map((chat) => (
                      <button
                        key={chat.id}
                        onClick={() => loadChatById(chat.id)}
                        className={`w-full text-left rounded-lg px-2 py-1.5 text-xs transition-colors ${
                          chatId === chat.id
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-surface-hover"
                        }`}
                      >
                        <p className="truncate font-medium">{chat.title}</p>
                        <p className="truncate text-[10px] text-muted">
                          {chat.bookTitle} · {new Date(chat.updatedAt).toLocaleDateString()}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </aside>

      {/* Right side — chat */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Context bar */}
        <div className="flex items-center gap-2 border-b border-border px-6 py-3">
          {focusBookId ? (
            <>
              <span className="text-sm text-muted">Asking about:</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                {focusBookTitle}
                <button
                  onClick={clearFocus}
                  className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-primary/20"
                  title="Switch to all books"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </span>
            </>
          ) : (
            <span className="text-sm text-muted">Searching across all books</span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-white shadow-lg shadow-primary/20">
                  <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                    <path d="M8 7h6" />
                    <path d="M8 11h4" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold">Ask me anything</h2>
                <p className="mt-1 max-w-sm text-sm text-muted">
                  {focusBookId
                    ? `Ask questions about "${focusBookTitle}"`
                    : "Ask questions across all your books"}
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {(focusBookId
                    ? [
                        "What is this book about?",
                        "Who are the main characters?",
                        "What are the key themes?",
                      ]
                    : [
                        "What common themes appear across my books?",
                        "Compare the main characters",
                        "Which book discusses this topic?",
                      ]
                  ).map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        setInput(suggestion);
                        textareaRef.current?.focus();
                      }}
                      className="rounded-full border border-border px-3.5 py-1.5 text-sm transition-colors hover:bg-surface-hover"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, i) => {
              const isUser = message.role === "user";
              return (
                <div key={i} className="animate-fade-in">
                  <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`
                        max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed
                        ${isUser
                          ? "bg-user-bubble text-white"
                          : "bg-surface border border-border text-foreground"
                        }
                      `}
                    >
                      {isUser ? (
                        <div className="whitespace-pre-wrap">{message.content}</div>
                      ) : (
                        <div className="prose-ai">
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>

                  {message.sources && message.sources.length > 0 && (
                    <div className="mt-2 ml-0">
                      <SourcesList
                        sources={message.sources}
                        onCitationClick={(source) =>
                          setInput(`Open excerpt: ${source.book} ${source.position || ""} "${source.excerpt}"`)
                        }
                      />
                    </div>
                  )}
                  {message.specialists && message.specialists.length > 0 && (
                    <div className="mt-2 ml-0">
                      <SpecialistReportsList reports={message.specialists} />
                    </div>
                  )}
                  {message.why && (
                    <div className="mt-2 ml-0">
                      <WhyPanel why={message.why} />
                    </div>
                  )}
                  {!isUser && (
                    <div className="mt-2 flex gap-2">
                      <button
                        className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground"
                        onClick={() => setInput(`Retry specialist step for: ${messages[i - 1]?.content || ""}`)}
                      >
                        Retry from specialist step
                      </button>
                      <button
                        className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground"
                        onClick={() => setInput(`Retry final synthesis for: ${messages[i - 1]?.content || ""}`)}
                      >
                        Retry from final step
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {isLoading && thinkingSteps.length > 0 && (
              <div className="animate-fade-in flex justify-start">
                <div className="max-w-[85%] rounded-2xl border border-border bg-surface px-4 py-3">
                  <div className="space-y-1.5">
                    {thinkingSteps.map((step, i) => {
                      const isLatest = i === thinkingSteps.length - 1;
                      return (
                        <div
                          key={i}
                          className={`flex items-center gap-2 text-xs transition-opacity ${
                            isLatest ? "text-foreground" : "text-muted opacity-60"
                          }`}
                        >
                          <span className="shrink-0">
                            {isLatest ? (
                              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                            ) : (
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </span>
                          <span>{step}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {isLoading && thinkingSteps.length === 0 && messages[messages.length - 1]?.role === "user" && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-border bg-surface px-4 py-1">
                  <div className="flex items-center gap-1.5 px-1 py-2">
                    <div className="typing-dot h-2 w-2 rounded-full bg-muted" />
                    <div className="typing-dot h-2 w-2 rounded-full bg-muted" />
                    <div className="typing-dot h-2 w-2 rounded-full bg-muted" />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input bar */}
        <div className="border-t border-border px-6 py-3">
          <div className="mx-auto flex max-w-2xl items-end gap-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                focusBookId
                  ? `Ask about "${focusBookTitle}"...`
                  : "Ask about your books..."
              }
              rows={1}
              className="flex-1 resize-none rounded-xl border border-border bg-surface px-4 py-3 text-[15px] outline-none transition-colors placeholder:text-muted focus:border-primary"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isLoading}
              className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl bg-primary text-white transition-colors hover:bg-primary-hover disabled:opacity-40 disabled:hover:bg-primary"
            >
              {isLoading ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12 7-7 7 7" />
                  <path d="M12 19V5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </main>

      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold">AI Personality Settings</h3>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded p-1 text-muted hover:text-foreground"
                title="Close"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Response language</label>
                <select
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  value={settings.language}
                  onChange={(e) => setSettings((prev) => ({ ...prev, language: e.target.value }))}
                >
                  {["Auto", "English", "Norwegian", "Spanish", "French", "German"].map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Tone</label>
                <select
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  value={settings.tone}
                  onChange={(e) => setSettings((prev) => ({ ...prev, tone: e.target.value }))}
                >
                  {["Scientific", "Casual", "Teacher-like", "Concise", "Custom"].map((tone) => (
                    <option key={tone} value={tone}>{tone}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Custom instructions</label>
                <textarea
                  value={settings.customInstructions}
                  onChange={(e) => setSettings((prev) => ({ ...prev, customInstructions: e.target.value }))}
                  rows={4}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  placeholder="Example: Focus on military strategy and compare contradictions between books."
                />
              </div>

              <div className="rounded-lg border border-border bg-surface p-3">
                <label className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(settings.groundedMode)}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, groundedMode: e.target.checked }))
                    }
                  />
                  Strict grounded mode (return "insufficient evidence" when uncited)
                </label>
                <div className="grid grid-cols-1 gap-2">
                  <input
                    value={settings.modelRouting?.specialistModelId || ""}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        modelRouting: { ...(prev.modelRouting || {}), specialistModelId: e.target.value },
                      }))
                    }
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
                    placeholder="Specialist model ID"
                  />
                  <input
                    value={settings.modelRouting?.orchestratorModelId || ""}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        modelRouting: { ...(prev.modelRouting || {}), orchestratorModelId: e.target.value },
                      }))
                    }
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
                    placeholder="Orchestrator model ID"
                  />
                  <input
                    value={settings.modelRouting?.extractionModelId || ""}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        modelRouting: { ...(prev.modelRouting || {}), extractionModelId: e.target.value },
                      }))
                    }
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
                    placeholder="Extraction/profile model ID"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Focus areas</label>
                <div className="mb-2 flex flex-wrap gap-2">
                  {settings.focusAreas.map((area) => (
                    <span key={area} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                      {area}
                      <button
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            focusAreas: prev.focusAreas.filter((a) => a !== area),
                          }))
                        }
                        className="rounded p-0.5 hover:bg-primary/20"
                        title="Remove"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={focusAreaInput}
                    onChange={(e) => setFocusAreaInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addFocusArea();
                      }
                    }}
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                    placeholder="Add focus area..."
                  />
                  <button
                    onClick={addFocusArea}
                    className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-foreground"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface p-3">
              <button
                onClick={() => fetch("/api/reindex", { method: "POST" })}
                className="rounded-lg border border-border px-3 py-2 text-xs text-left"
              >
                Re-index manager
              </button>
              <button
                onClick={() => fetch("/api/eval").then((r) => r.json()).then((d) => alert(`Eval score: ${d.score}`))}
                className="rounded-lg border border-border px-3 py-2 text-xs text-left"
              >
                Run evaluation harness
              </button>
              <button
                onClick={() => fetch("/api/safety", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "backup" }) })}
                className="rounded-lg border border-border px-3 py-2 text-xs text-left"
              >
                Backup now
              </button>
              <button
                onClick={async () => {
                  const res = await fetch("/api/share", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ bookIds: focusBookId ? [focusBookId] : [] }),
                  });
                  const data = await res.json();
                  if (data?.url) alert(`Share link created: ${data.url}`);
                }}
                className="rounded-lg border border-border px-3 py-2 text-xs text-left"
              >
                Create read-only snapshot link
              </button>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover"
              >
                Save settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
