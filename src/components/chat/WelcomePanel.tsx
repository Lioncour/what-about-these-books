"use client";

import BrandMark from "@/components/BrandMark";
import { formatTitlesPhrase } from "@/components/chat/format";

function suggestionsFor(hasFocus: boolean, bookCount: number): string[] {
  if (hasFocus) {
    return [
      "What's this one about?",
      "Who matters most here?",
      "Any pop-culture references?",
      "Find a memorable quote",
    ];
  }
  if (bookCount > 0) {
    return [
      "Any pop culture references in the books?",
      "Who shows up across the series?",
      "Help me pick what to reread",
      "How many times is Skippy mentioned in the first 7 books?",
    ];
  }
  return ["What can you do?", "How do I add a book?"];
}

/** The empty conversation: a greeting and a few questions to start from. */
export default function WelcomePanel({
  companionMode,
  bookCount,
  recentTitles,
  hasFocus,
  onAsk,
}: {
  companionMode: boolean;
  bookCount: number;
  /** Display titles (already cleaned) of the most recent books. */
  recentTitles: string[];
  hasFocus: boolean;
  onAsk: (question: string) => void;
}) {
  const titlesPhrase = formatTitlesPhrase(recentTitles);
  return (
    <div className="animate-rise-in py-8 sm:py-14">
      {companionMode ? (
        <>
          <BrandMark className="mb-7 h-14 w-14 opacity-90" />
          <p className="max-w-2xl font-display text-[1.85rem] font-semibold leading-[1.2] tracking-tight sm:text-[2.15rem]">
            {bookCount > 0
              ? `Ready whenever you are — ${bookCount} book${bookCount === 1 ? "" : "s"} on the shelves.`
              : "Add a book on the left, then ask anything."}
          </p>
          {titlesPhrase && (
            <p className="animate-rise-in stagger-1 mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              Lately that includes {titlesPhrase}
            </p>
          )}
          <div className="animate-rise-in stagger-2 mt-9 flex flex-col items-start gap-3">
            {suggestionsFor(hasFocus, bookCount).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onAsk(suggestion)}
                className="prompt-link text-[15px]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="font-display text-xl text-muted">Ask about a book</p>
      )}
    </div>
  );
}
