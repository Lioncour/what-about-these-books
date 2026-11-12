"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AppHeader from "@/components/AppHeader";
import BookLibrary from "@/components/BookLibrary";
import ConfirmDialog from "@/components/ConfirmDialog";
import LibraryRail from "@/components/LibraryRail";
import UploadArea from "@/components/UploadArea";
import AskDialog from "@/components/chat/AskDialog";
import ChatHeader from "@/components/chat/ChatHeader";
import Composer, { type ComposerHandle } from "@/components/chat/Composer";
import type { Source } from "@/components/chat/MessageExtras";
import MessageList from "@/components/chat/MessageList";
import PassageReader, { type PassageReaderTarget } from "@/components/chat/PassageReader";
import PastNotes from "@/components/chat/PastNotes";
import ScopeChip from "@/components/chat/ScopeChip";
import WelcomePanel from "@/components/chat/WelcomePanel";
import { useAskScope } from "@/hooks/useAskScope";
import { useChatHistory } from "@/hooks/useChatHistory";
import { useChatStream } from "@/hooks/useChatStream";
import { useLibrary } from "@/hooks/useLibrary";
import { useLibraryRail } from "@/hooks/useLibraryRail";
import { useQuickActions } from "@/hooks/useQuickActions";
import { useScopePreview } from "@/hooks/useScopePreview";

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
    books,
    series,
    loaded: libraryLoaded,
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

  // The focus (a book or a series) or the hand-picked books the next question is asked against.
  const askScope = useAskScope({ books, series, loaded: libraryLoaded, focus, setFocus, toggleFocus });
  const { pickedIds } = askScope;

  const chat = useChatStream({ focus, pickedIds, onLibraryChanged: handleLibraryChanged });
  const scopePreview = useScopePreview({ question: input, focus, pickedIds, books, series });
  const history = useChatHistory({
    messages: chat.messages,
    setMessages: chat.setMessages,
    isLoading: chat.isLoading,
    scope: askScope.saved,
    restoreScope: askScope.restore,
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
    onClearFocus: askScope.askAll,
  });

  const { focusOn, toggleShelfFocus } = askScope;
  const handleBookLoaded = useCallback(
    (id: string, title: string) => {
      refreshLibrary();
      focusOn({ id, title });
      focusComposer();
    },
    [refreshLibrary, focusOn, focusComposer]
  );

  const handleSelectBook = useCallback(
    (book: { id: string; title: string }) => {
      // Clicking a book (or a series row) on the shelves is a single focus; it replaces a picked set.
      toggleShelfFocus(book);
      focusComposer();
    },
    [toggleShelfFocus, focusComposer]
  );

  // A focused book was renamed in Manage → Edit: show its new title.
  const handleBookEdited = useCallback(
    (book: { id: string; title: string }) => {
      if (focus?.id === book.id) setFocus(book);
    },
    [focus, setFocus]
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
              onBookEdited={handleBookEdited}
              activeBookId={focus?.id ?? null}
              readOnly={publicMode}
            />
          </LibraryRail>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <ChatHeader
            focus={focus}
            pickedCount={pickedIds.length}
            bookCount={bookCount}
            pastNotesOpen={pastNotesOpen}
            onClearFocus={askScope.askAll}
            onTogglePastNotes={() => setPastNotesOpen((prev) => !prev)}
            onNewChat={startNewChat}
          />

          {pastNotesOpen && (
            <PastNotes
              chats={history.chats}
              activeChatId={history.chatId}
              onOpen={(id) => {
                // Picking a conversation puts the drawer away so the notes are readable.
                setPastNotesOpen(false);
                void history.loadChat(id);
              }}
              onDelete={history.requestDelete}
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
                focusKind={focus ? (focus.id.startsWith("series:") ? "series" : "book") : null}
                firstTitle={books[0]?.title}
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
            above={
              bookCount > 0 ? (
                <ScopeChip
                  preview={scopePreview}
                  books={books}
                  series={series}
                  selectedIds={askScope.tickedIds}
                  onApply={(ids) => {
                    askScope.applyTicked(ids);
                    focusComposer();
                  }}
                />
              ) : null
            }
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

      <ConfirmDialog
        open={history.pendingDelete !== null}
        title="Delete this chat?"
        confirmLabel="Delete"
        tone="danger"
        onClose={history.cancelDelete}
        onConfirm={() => void history.confirmDelete()}
      >
        Delete “{history.pendingDelete?.title}” from your past notes? It can’t be brought back.
      </ConfirmDialog>

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
