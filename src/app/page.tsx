"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import UploadArea from "@/components/UploadArea";
import BookLibrary, { BookLibraryHandle } from "@/components/BookLibrary";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [focusBookId, setFocusBookId] = useState<string | null>(null);
  const [focusBookTitle, setFocusBookTitle] = useState<string | null>(null);
  const libraryRef = useRef<BookLibraryHandle>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
            if (!line) continue;
            const colonIdx = line.indexOf(":");
            if (colonIdx === -1) continue;

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
  }, [input, isLoading, messages, focusBookId, focusBookTitle]);

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
      textareaRef.current?.focus();
    },
    [focusBookId]
  );

  const clearFocus = useCallback(() => {
    setFocusBookId(null);
    setFocusBookTitle(null);
    setMessages([]);
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
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <UploadArea
            onBookLoaded={handleBookLoaded}
            onBooksChanged={handleBooksChanged}
            compact
          />

          <div className="mt-5">
            <BookLibrary
              ref={libraryRef}
              onSelectBook={handleSelectBook}
              activeBookId={focusBookId}
            />
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
                <div
                  key={i}
                  className={`animate-fade-in flex ${isUser ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`
                      max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed
                      ${isUser
                        ? "bg-user-bubble text-white"
                        : "bg-surface border border-border text-foreground"
                      }
                    `}
                  >
                    <div className="whitespace-pre-wrap">{message.content}</div>
                  </div>
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
    </div>
  );
}
