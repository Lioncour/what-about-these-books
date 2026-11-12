"use client";

import { useCallback, useRef, useState } from "react";
import type { Source } from "@/components/chat/MessageExtras";
import { parseScope, parseUsage, type ScopeInfo } from "@/components/chat/format";
import type { FocusBook, Message } from "@/components/chat/messages";
import { scopeToRequest } from "@/components/chat/scope";
import { decodeStreamLine } from "@/lib/chat/stream-protocol";

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

/**
 * The conversation and its streaming request: send, stop, decode the stream
 * lines, collect thinking steps and tokens into the assistant message.
 */
export function useChatStream({
  focus,
  pickedIds,
  onLibraryChanged,
}: {
  focus: FocusBook | null;
  /** Books picked by hand in the composer; two or more narrow the question to them. */
  pickedIds: string[];
  /** The answer changed the library (a chat command); `clearFocus` when the focus book may be gone. */
  onLibraryChanged: (clearFocus: boolean) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [hasAssistantTokens, setHasAssistantTokens] = useState(false);
  // SCOPE usually arrives before the first token: shown on its own until the
  // assistant message exists, then it lives on the message.
  const [pendingScope, setPendingScope] = useState<ScopeInfo | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Identifies the request that owns the loading state, so a stopped stream
  // that finishes late can't clear the state of the one started after it.
  const runRef = useRef(0);

  const finishRun = useCallback((run: number) => {
    if (runRef.current !== run) return;
    abortRef.current = null;
    setIsLoading(false);
    setThinkingSteps([]);
    setPendingScope(null);
  }, []);

  const stop = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setThinkingSteps([]);
    setPendingScope(null);
  }, []);

  const stream = useCallback(
    async (history: Message[]) => {
      const run = ++runRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // A series focus goes as bookId "series:<id>" with the series name.
            ...scopeToRequest(focus, pickedIds),
            messages: history.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.sources?.length ? { sources: m.sources } : {}),
            })),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to get response");
        }

        let content = "";
        let added = false;
        let receivedTokens = false;
        // Lines that describe the answer (sources, scope, usage) can arrive
        // before its first token; they wait here until the message exists.
        let extras: Partial<Message> = {};

        const patchAssistant = (patch: Partial<Message>) => {
          if (!added) {
            extras = { ...extras, ...patch };
            return;
          }
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== "assistant") return prev;
            return [...prev.slice(0, -1), { ...last, ...patch }];
          });
        };

        const ensureAssistant = () => {
          if (added) return;
          added = true;
          const initial: Message = { role: "assistant", content: "", ...extras };
          setMessages((prev) => [...prev, initial]);
          setPendingScope(null);
        };

        const handleLine = (line: string) => {
          if (!line.trim()) return;
          const decoded = decodeStreamLine(line);
          if (!decoded) return;
          const { type, data } = decoded;

          if (type === "STATUS") {
            setThinkingSteps((prev) => [...prev, data]);
          } else if (type === "TOKEN") {
            setThinkingSteps([]);
            ensureAssistant();
            receivedTokens = true;
            setHasAssistantTokens(true);
            content += data;
            patchAssistant({ content });
          } else if (type === "TEXT") {
            setThinkingSteps([]);
            ensureAssistant();
            // TOKEN appends; TEXT replaces (non-stream paths send the full answer once).
            // If tokens already started, ignore TEXT to avoid duplicating streamed content.
            if (!receivedTokens) {
              content = data;
              patchAssistant({ content });
              setHasAssistantTokens(true);
            }
          } else if (type === "SOURCES") {
            try {
              patchAssistant({ sources: JSON.parse(data) as Source[] });
            } catch {
              /* ignore parse errors */
            }
          } else if (type === "SCOPE") {
            const scope = parseScope(data);
            if (scope) {
              if (!added) setPendingScope(scope);
              patchAssistant({ scope });
            }
          } else if (type === "USAGE") {
            const usage = parseUsage(data);
            if (usage) patchAssistant({ usage });
          } else if (type === "LIBRARY_CHANGED") {
            let clearFocus = true;
            try {
              clearFocus = Boolean((JSON.parse(data) as { clearFocus?: boolean }).clearFocus);
            } catch {
              /* unreadable payload: assume the focus book may be gone */
            }
            onLibraryChanged(clearFocus);
          } else if (type === "ERROR") {
            throw new Error(data);
          }
          // Other line types (older servers, future ones) are ignored.
        };

        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) handleLine(line);
          }
          // A stream that ends without a trailing newline still has a last line.
          buffer += decoder.decode();
          if (buffer) handleLine(buffer);
        }

        if (!added) {
          const fallback: Message = {
            role: "assistant",
            content: "I wasn't able to generate a response.",
            ...extras,
          };
          setMessages((prev) => [...prev, fallback]);
        }
      } catch (err) {
        if (isAbortError(err)) return;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Sorry, something went wrong: ${errorText(err)}` },
        ]);
      } finally {
        // Whatever ended the stream (done, error, abort, a missing final line),
        // the composer goes back to Send.
        finishRun(run);
      }
    },
    [focus, pickedIds, onLibraryChanged, finishRun]
  );

  /** Ask a question. Returns false when there is nothing to send or an answer is in flight. */
  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return false;
      const history: Message[] = [...messages, { role: "user", content: trimmed }];
      setMessages(history);
      setIsLoading(true);
      setThinkingSteps([]);
      setHasAssistantTokens(false);
      setPendingScope(null);
      void stream(history);
      return true;
    },
    [messages, isLoading, stream]
  );

  /** A question answered without the chat endpoint (character page, contradictions). */
  const runLocal = useCallback(
    async (question: string, answer: () => Promise<string>, failure: string) => {
      const run = ++runRef.current;
      setMessages((prev) => [...prev, { role: "user", content: question }]);
      setIsLoading(true);
      try {
        const content = await answer();
        setMessages((prev) => [...prev, { role: "assistant", content }]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `${failure}: ${errorText(err)}` },
        ]);
      } finally {
        finishRun(run);
      }
    },
    [finishRun]
  );

  return {
    messages,
    setMessages,
    isLoading,
    thinkingSteps,
    hasAssistantTokens,
    pendingScope,
    send,
    stop,
    runLocal,
  };
}
