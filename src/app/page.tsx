"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ScopeChip from "@/components/chat/ScopeChip";
import WelcomePanel from "@/components/chat/WelcomePanel";
import { useChatHistory } from "@/hooks/useChatHistory";
import { useChatStream } from "@/hooks/useChatStream";
import { useLibrary } from "@/hooks/useLibrary";
import { useLibraryRail } from "@/hooks/useLibraryRail";
import { useQuickActions } from "@/hooks/useQuickActions";
import { useScopePreview } from "@/hooks/useScopePreview";

const NO_BOOKS: string[] = [];

export default function Home() {
  const [input, setInput] = useState("");
  const [publicMode, setPublicMode] = useState(false);
  const [companionMode, setCompanionMode] = useState(true);
  const [pastNotesOpen, setPastNotesOpen] = useState(false);
  const [passageTarget, setPassageTarget] = useState<PassageReaderTarget | null>(null);
  // Books picked by hand for the next questions; two or more override the library scope.
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const composerRef = useRef<ComposerHandle>(null);

  const rail = useLibraryRail();
  const {
    libraryRef,
    bookCount,
    recentTitles,
    books,
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

  // Only books still on the shelves count as picked (a book may have been removed).
  const picked = pickedIds.filter((id) => books.some((b) => b.id === id));
  const activePicked = picked.length >= 2 ? picked : NO_BOOKS;
  const pickedKey = activePicked.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, not identity
  const sentPicked = useMemo(() => activePicked, [pickedKey]);

  const chat = useChatStream({ focus, pickedIds: sentPicked, onLibraryChanged: handleLibraryChanged });
  const scopePreview = useScopePreview({ question: input, focus, pickedIds: sentPicked, books });

  /** The picker's answer: nothing = whole library, one = focus book, more = picked set. */
  const applyPicked = useCallback(
    (ids: string[]) => {
      if (ids.length === 1) {
        const book = books.find((b) => b.id === ids[0]);
        setPickedIds([]);
        if (book) setFocus({ id: book.id, title: book.title });
        return;
      }
      setPickedIds(ids);
      clearFocus();
    },
    [books, setFocus, clearFocus]
  );
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
      // Clicking a book on the shelves is a single focus; it replaces a picked set.
      setPickedIds([]);
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
            pickedCount={sentPicked.length}
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
              onOpen={(id) => {
                // Picking a conversation puts the drawer away so the notes are readable.
                setPastNotesOpen(false);
                void history.loadChat(id);
              }}
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
            above={
              bookCount > 0 ? (
                <ScopeChip
                  preview={scopePreview}
                  books={books}
                  selectedIds={focus ? [focus.id] : sentPicked}
                  onApply={(ids) => {
                    applyPicked(ids);
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
