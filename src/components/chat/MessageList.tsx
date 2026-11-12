"use client";

import { memo, useEffect, useRef, type ReactNode } from "react";
import ChatMarkdown from "@/components/ChatMarkdown";
import { ScopeLine, SourcesList, UsageLine, type Source } from "@/components/chat/MessageExtras";
import type { ScopeInfo } from "@/components/chat/format";
import type { Message } from "@/components/chat/messages";

const LABEL = "text-[11px] font-medium uppercase tracking-[0.16em]";

const MessageItem = memo(function MessageItem({
  message,
  onOpenPassage,
}: {
  message: Message;
  onOpenPassage: (source: Source) => void;
}) {
  const hasSources = !!message.sources?.length;
  return (
    <article className="animate-fade-in">
      {message.role === "user" ? (
        <div className="border-b border-border/25 pb-7">
          <p className={`mb-2 ${LABEL} text-muted/90`}>You asked</p>
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
        <div className="mt-5 space-y-3">
          {message.scope && <ScopeLine scope={message.scope} />}
          {hasSources && (
            <SourcesList sources={message.sources ?? []} onOpenPassage={onOpenPassage} />
          )}
          {message.usage && <UsageLine usage={message.usage} />}
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
  onOpenPassage,
}: {
  messages: Message[];
  isLoading: boolean;
  thinkingSteps: string[];
  hasAssistantTokens: boolean;
  /** Scope of the answer being prepared, before its first token. */
  pendingScope: ScopeInfo | null;
  welcome: ReactNode;
  onOpenPassage: (source: Source) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const waiting = isLoading && !hasAssistantTokens;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8 sm:px-10 lg:px-14">
      <div className="mx-auto w-full max-w-3xl space-y-11">
        {messages.length === 0 && welcome}

        {messages.map((message, i) => (
          <MessageItem key={i} message={message} onOpenPassage={onOpenPassage} />
        ))}

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
