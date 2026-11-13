"use client";

import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import ChatMarkdown from "@/components/ChatMarkdown";
import {
  ScopeAction,
  ScopeLine,
  SourcesList,
  UsageLine,
  type Source,
} from "@/components/chat/MessageExtras";
import {
  followUpAction,
  questionIndexFor,
  type AskedScope,
  type FollowUpAction,
} from "@/components/chat/followUp";
import type { ScopeInfo } from "@/components/chat/format";
import type { Message } from "@/components/chat/messages";
import type { ScopeBook, ScopeSeries } from "@/components/chat/scope";

const LABEL = "text-[11px] font-medium uppercase tracking-[0.16em]";

/** What the "check the other books" action needs to know about the shelves. */
export interface FollowUpLibrary {
  books: ScopeBook[];
  series: ScopeSeries[];
}

const MessageItem = memo(function MessageItem({
  message,
  index,
  question,
  asked,
  library,
  busy,
  onOpenPassage,
  onFollowUp,
}: {
  message: Message;
  index: number;
  /** The question this answer belongs to (empty for a question, or when there is none). */
  question: string;
  /** What that question was asked against. */
  asked: AskedScope | undefined;
  library: FollowUpLibrary;
  /** An answer is streaming: follow-up actions wait. */
  busy: boolean;
  onOpenPassage: (source: Source) => void;
  onFollowUp: (answerIndex: number, question: string, action: FollowUpAction) => void;
}) {
  const hasSources = !!message.sources?.length;
  const action = useMemo(
    () =>
      message.role === "assistant" && question
        ? followUpAction(message.scope, library, asked)
        : null,
    [message.role, message.scope, question, library, asked]
  );
  // A used action stays as "Checked" even when the shelves have changed since.
  const showAction = message.role === "assistant" && (message.checked || action !== null);
  return (
    <article className="animate-fade-in">
      {message.role === "user" ? (
        <div className="border-b border-border/25 pb-7">
          <p className={`mb-2 ${LABEL} text-muted/90`}>
            {message.label ? `You asked · ${message.label}` : "You asked"}
          </p>
          <p className="font-display text-xl leading-snug whitespace-pre-wrap sm:text-[1.35rem]">
            {message.content}
          </p>
        </div>
      ) : (
        <div>
          <p className={`mb-3 ${LABEL} text-primary/80`}>From the pages</p>
          <div className="prose-ai text-[16px] sm:text-[17px]">
            <ChatMarkdown content={message.content} />
          </div>
        </div>
      )}

      {(hasSources || message.scope || message.usage) && (
        <div className="mt-5 space-y-4">
          {hasSources && (
            <SourcesList sources={message.sources ?? []} onOpenPassage={onOpenPassage} />
          )}
          {/* One quiet footer: where the answer came from, what else could be checked, what it took. */}
          {(message.scope || message.usage) && (
            <footer className="space-y-1">
              {message.scope && (
                <ScopeLine
                  scope={message.scope}
                  followUp={asked?.followUp === true}
                  action={
                    showAction ? (
                      <ScopeAction
                        label={action?.label ?? ""}
                        used={!!message.checked}
                        disabled={busy}
                        onClick={() => action && onFollowUp(index, question, action)}
                      />
                    ) : undefined
                  }
                />
              )}
              {message.usage && <UsageLine usage={message.usage} />}
            </footer>
          )}
        </div>
      )}
    </article>
  );
});

/** The conversation column: welcome (when empty), messages, and what is happening right now. */
export default function MessageList({
  messages,
  isLoading,
  thinkingSteps,
  hasAssistantTokens,
  pendingScope,
  welcome,
  library,
  pickedIds,
  onOpenPassage,
  onFollowUp,
}: {
  messages: Message[];
  isLoading: boolean;
  thinkingSteps: string[];
  hasAssistantTokens: boolean;
  /** Scope of the answer being prepared, before its first token. */
  pendingScope: ScopeInfo | null;
  welcome: ReactNode;
  /** The shelves, for the "check the other books" action under an answer. */
  library: FollowUpLibrary;
  /** The chat's hand-picked books: what a question saved without its own scope was asked against. */
  pickedIds: string[];
  onOpenPassage: (source: Source) => void;
  /** Ask the answer's question again against the books its action names. */
  onFollowUp: (answerIndex: number, question: string, action: FollowUpAction) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const waiting = isLoading && !hasAssistantTokens;
  const chatPick = useMemo<AskedScope | undefined>(
    () => (pickedIds.length ? { bookIds: pickedIds } : undefined),
    [pickedIds]
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8 sm:px-10 lg:px-14">
      <div className="mx-auto w-full max-w-3xl space-y-11">
        {messages.length === 0 && welcome}

        {messages.map((message, i) => {
          const asker = message.role === "assistant" ? messages[questionIndexFor(messages, i)] : undefined;
          return (
            <MessageItem
              key={i}
              message={message}
              index={i}
              question={asker?.content ?? ""}
              asked={asker?.asked ?? chatPick}
              library={library}
              busy={isLoading}
              onOpenPassage={onOpenPassage}
              onFollowUp={onFollowUp}
            />
          );
        })}

        {waiting && (pendingScope || thinkingSteps.length > 0) && (
          <div className="animate-fade-in space-y-2.5 border-l-2 border-accent/50 pl-4">
            {pendingScope && <ScopeLine scope={pendingScope} />}
            {thinkingSteps.length > 0 && (
              <>
                <p className={`${LABEL} text-muted/90`}>Looking through</p>
                {thinkingSteps.map((step, i) => (
                  <p
                    key={i}
                    className={`text-sm ${
                      i === thinkingSteps.length - 1 ? "text-foreground" : "text-muted opacity-65"
                    }`}
                  >
                    {step}
                  </p>
                ))}
              </>
            )}
          </div>
        )}

        {waiting &&
          !pendingScope &&
          thinkingSteps.length === 0 &&
          messages[messages.length - 1]?.role === "user" && (
            <p className="animate-fade-in text-sm italic text-muted">Turning a page…</p>
          )}

        <div ref={endRef} />
      </div>
    </div>
  );
}
