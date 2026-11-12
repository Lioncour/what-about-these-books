"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AppHeader from "@/components/AppHeader";
import BookLibrary from "@/components/BookLibrary";
import LibraryRail from "@/components/LibraryRail";
import UploadArea from "@/components/UploadArea";
import AskDialog from "@/components/chat/AskDialog";
import ChatHeader from "@/components/chat/ChatHeader";
import Composer, { type ComposerHandle } from "@/components/chat/Composer";
import type { Source } from "@/components/chat/MessageExtras";
import MessageList from "@/components/chat/MessageList";
import PassageReader, { type PassageReaderTarget } from "@/components/chat/PassageReader";
import PastNotes from "@/components/chat/PastNotes";
import WelcomePanel from "@/components/chat/WelcomePanel";
import { useChatHistory } from "@/hooks/useChatHistory";
import { useChatStream } from "@/hooks/useChatStream";
import { useLibrary } from "@/hooks/useLibrary";
import { useLibraryRail } from "@/hooks/useLibraryRail";
import { useQuickActions } from "@/hooks/useQuickActions";

export default function Home() {
  const [input, setInput] = useState("");
  const [publicMode, setPublicMode] = useState(false);
  const [companionMode, setCompanionMode] = useState(true);
  const [pastNotesOpen, setPastNotesOpen] = useState(false);
  const [passageTarget, setPassageTarget] = useState<PassageReaderTarget | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const rail = useLibraryRail();
  const {
    libraryRef,
    bookCount,
    recentTitles,
    focus,
    setFocus,
    clearFocus,
    toggleFocus,
    refresh: refreshLibrary,
    reloadSummary,
  } = useLibrary();

  const handleLibraryChanged = useCallback(
    (shouldClearFocus: boolean) => {
      if (shouldClearFocus) clearFocus();
      refreshLibrary();
    },
    [clearFocus, refreshLibrary]
  );

  const chat = useChatStream({ focus, onLibraryChanged: handleLibraryChanged });
  const history = useChatHistory({
    messages: chat.messages,
    setMessages: chat.setMessages,
    isLoading: chat.isLoading,
    focus,
    setFocus,
  });

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setPublicMode(data.publicMode))
      .catch(() => {});
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setCompanionMode(data.companionMode !== false))
      .catch(() => {});
  }, []);

  const focusComposer = useCallback(() => composerRef.current?.focus(), []);

  const { send } = chat;
  const ask = useCallback(
    (text: string) => {
      if (send(text)) setInput("");
    },
    [send]
  );

  const { startNew } = history;
  const startNewChat = useCallback(() => {
    startNew();
    focusComposer();
  }, [startNew, focusComposer]);

  const quick = useQuickActions({
    runLocal: chat.runLocal,
    onNewChat: startNewChat,
    onClearFocus: clearFocus,
  });

  const handleBookLoaded = useCallback(
    (id: string, title: string) => {
      refreshLibrary();
      setFocus({ id, title });
      focusComposer();
    },
    [refreshLibrary, setFocus, focusComposer]
  );

  const handleSelectBook = useCallback(
    (book: { id: string; title: string }) => {
      toggleFocus(book);
      focusComposer();
    },
    [toggleFocus, focusComposer]
  );

  const openPassage = useCallback((source: Source) => {
    setPassageTarget({
      bookId: source.bookId,
      book: source.book,
      position: source.position,
      excerpt: source.excerpt,
    });
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <AppHeader
        libraryCollapsed={rail.collapsed}
        onShowLibrary={() => rail.setCollapsed(false)}
      />

      <div className="flex min-h-0 flex-1">
        {!rail.collapsed && (
          <LibraryRail
            width={rail.width}
            onCollapse={() => rail.setCollapsed(true)}
            onStartResize={rail.startResize}
          >
            {!publicMode && (
              <UploadArea
                onBookLoaded={handleBookLoaded}
                onBooksChanged={refreshLibrary}
                compact
              />
            )}
            <BookLibrary
              ref={libraryRef}
              onSelectBook={handleSelectBook}
              onLibraryChanged={reloadSummary}
              activeBookId={focus?.id ?? null}
              readOnly={publicMode}
            />
          </LibraryRail>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <ChatHeader
            focus={focus}
            bookCount={bookCount}
            pastNotesOpen={pastNotesOpen}
            onClearFocus={clearFocus}
            onTogglePastNotes={() => setPastNotesOpen((prev) => !prev)}
            onNewChat={startNewChat}
          />

          {pastNotesOpen && (
            <PastNotes
              chats={history.chats}
              activeChatId={history.chatId}
              onOpen={(id) => void history.loadChat(id)}
              onDelete={(id) => void history.deleteChat(id)}
            />
          )}

          <MessageList
            messages={chat.messages}
            isLoading={chat.isLoading}
            thinkingSteps={chat.thinkingSteps}
            hasAssistantTokens={chat.hasAssistantTokens}
            pendingScope={chat.pendingScope}
            onOpenPassage={openPassage}
            welcome={
              <WelcomePanel
                companionMode={companionMode}
                bookCount={bookCount}
                recentTitles={recentTitles}
                hasFocus={focus !== null}
                onAsk={ask}
              />
            }
          />

          <Composer
            ref={composerRef}
            value={input}
            onChange={setInput}
            onSend={() => ask(input)}
            onStop={chat.stop}
            isLoading={chat.isLoading}
            placeholder={focus ? `Ask about ${focus.title}…` : "Write a note or question…"}
          />
        </main>
      </div>

      <AskDialog
        open={quick.open}
        title="Quick action"
        label="Command"
        placeholder="new · all · character:Name · contradictions:Topic"
        confirmLabel="Run"
        onClose={quick.close}
        onSubmit={quick.run}
      />

      <PassageReader
        target={passageTarget}
        onClose={() => setPassageTarget(null)}
        onAskAbout={(prompt) => {
          setInput(prompt);
          focusComposer();
        }}
      />
    </div>
  );
}
