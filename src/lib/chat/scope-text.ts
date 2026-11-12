import { getBookById, listBooks, type SeriesEntry } from "@/lib/book-store";
import { RESPONSE_FORMATTING_RULES } from "@/lib/chat/response-formatting";

/**
 * Everything a scope says: status lines, canned facts and prompts. The pipeline is the
 * same for library / series / book; only this wording differs.
 */
export interface ScopeText {
  /** STATUS before the scoped steps start. */
  searching: string;
  /** Facts for "have you read…?" */
  coverage(): string;
  whoIs: { status(target: string): string; label(topBook: string | undefined): string };
  smallTalk: { status: string; prompt(recentConversation: string, question: string): string; fallback: string };
  mainCharacters: { found(count: number): string; none: string };
  quote: { status: string; heading: string; miss: string };
  specialists: {
    /** STATUS while the roster is being picked (library only). */
    roster?: string;
    consulting(count: number, roster: string): string;
    merging: string;
  };
  rag: {
    found(semantic: number, keyword: number, bookCount: number): string;
    passageHeader(n: number, bookTitle: string, location: string): string;
    noPassages: string;
    /** `citeTitle`: a title to use in the citation example; `voice`: the voice preamble. */
    system(opts: { citeTitle: string | undefined; voice: string; context: string }): string;
  };
}

const plural = (n: number) => (n === 1 ? "" : "s");

export function libraryText(): ScopeText {
  return {
    searching: "Searching across your entire library (semantic search)...",
    coverage() {
      const total = listBooks().length;
      return total > 0
        ? `Yes — I’ve indexed your uploaded library and can answer questions from it. Right now I can see **${total} book${plural(total)}**.`
        : "Not yet — I don’t see any uploaded books in your library. Add a book and I can answer from it immediately.";
    },
    whoIs: {
      status: (target) => `Looking up who "${target}" is in your library...`,
      label: (topBook) => (topBook ? `your library (mostly in ${topBook})` : "your library"),
    },
    smallTalk: {
      status: "This is a general prompt — replying directly as your library assistant...",
      prompt: (recent, question) => `You are a friendly, practical digital librarian assistant.
Answer naturally like a real helpful person.
Do not claim you searched books unless the user asked for book-grounded evidence.
Use recent conversation context for follow-up references.
Recent conversation:
${recent}
User message: ${question}`,
      fallback:
        "I can help you explore your library, compare books, find quotes, count mentions, and summarize chapters with sources.",
    },
    mainCharacters: {
      found: (count) =>
        `Short answer: I detect about **${count} main characters** across the current scope, based on repeated entity prominence in the text.`,
      none: "I couldn't confidently identify main characters yet. Try re-indexing this book or asking with a specific book selected.",
    },
    quote: {
      status: "Running exact quote lookup across all books...",
      heading: "## Exact Quote Matches",
      miss: "No exact quote matches found in stored page text",
    },
    specialists: {
      roster: "Building specialist roster from your books...",
      consulting: (count, roster) => `Consulting ${count} Librarian agents${roster ? `: ${roster}` : ""}...`,
      merging: "Main AI is merging specialist reports...",
    },
    rag: {
      found: (semantic, keyword, bookCount) =>
        `Found ${semantic} semantic + ${keyword} keyword matches from ${bookCount} book${plural(bookCount)}`,
      passageHeader: (n, bookTitle, location) => `[Passage ${n} — from "${bookTitle}", ${location}]`,
      noPassages: "(No relevant passages found across your library.)",
      system: ({ citeTitle, voice, context }) => `You are a close friend who knows this library extremely well. Answer with care, warmth, and accuracy.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, "${citeTitle || "Book Title"}", Page X or Chapter Y). Always include the page/chapter location. Never state something without a citation.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting. Use phrases like "The text states..." vs. "This suggests..." or "One could interpret this as..."
4. When multiple passages or books address the same topic, COMPARE and CONTRAST them. Note agreements, contradictions, or different perspectives.
5. If the evidence is insufficient or ambiguous, say so explicitly. Never fill gaps with speculation presented as fact. If you suspect there may be MORE instances beyond the provided passages, say so.
6. Structure your response clearly: lead with a direct answer, then present the supporting evidence, then add any caveats or limitations.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

${voice}

${RESPONSE_FORMATTING_RULES}

Sound like a friend who remembers the books — warm, clear, and honest about uncertainty.

Relevant passages from the user's library:

${context}`,
    },
  };
}

export function seriesText(seriesName: string, series: SeriesEntry | null): ScopeText {
  return {
    searching: `Searching series "${seriesName}" (semantic search)...`,
    coverage() {
      const count = listBooks().filter((b) => series?.bookIds.includes(b.id)).length;
      return count > 0
        ? `Yes — I’ve indexed the books in **${seriesName}** and can answer from them. I currently see **${count}** book${plural(count)} in this series.`
        : `Not yet — I can’t find indexed books in **${seriesName}** yet.`;
    },
    whoIs: {
      status: (target) => `Looking up who "${target}" is in series "${seriesName}"...`,
      label: (topBook) => (topBook ? `series ${seriesName} (mostly in ${topBook})` : `series ${seriesName}`),
    },
    smallTalk: {
      status: "General prompt detected — replying directly without specialist fan-out...",
      prompt: (recent, question) => `You are a friendly librarian assistant helping with a selected series context (${seriesName}).
If the user is not asking for evidence from books, respond conversationally and briefly.
Use recent conversation context for follow-up references.
Recent conversation:
${recent}
User message: ${question}`,
      fallback:
        "I can help with this series — ask me about characters, themes, or specific evidence when you want citations.",
    },
    mainCharacters: {
      found: (count) =>
        `Short answer: in **${seriesName}**, I detect about **${count} main characters** from repeated prominence patterns.`,
      none: "I couldn't confidently identify main characters in this series yet.",
    },
    quote: {
      status: `Running exact quote lookup in series "${seriesName}"...`,
      heading: `## Exact Quote Matches in ${seriesName}`,
      miss: "No exact quote matches found in this series",
    },
    specialists: {
      consulting: (count, roster) => `Consulting ${count} series Librarians${roster ? `: ${roster}` : ""}...`,
      merging: "Main AI is merging specialist reports...",
    },
    rag: {
      found: (semantic, keyword, bookCount) =>
        `Found ${semantic} semantic + ${keyword} keyword matches from ${bookCount} book${plural(bookCount)} in this series`,
      passageHeader: (n, bookTitle, location) => `[Passage ${n} — from "${bookTitle}", ${location}]`,
      noPassages: `(No relevant passages found for series "${seriesName}".)`,
      system: ({ voice, context }) => `You are a close friend who knows the series "${seriesName}" extremely well. Answer with care, warmth, and accuracy.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, "Book Title", Page X or Chapter Y). Always include both book title and location.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting.
4. Compare how the books in the series agree or differ when relevant.
5. If evidence is insufficient or ambiguous, say so explicitly.
6. Structure your response with a direct answer, supporting evidence, then caveats.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

${voice}

${RESPONSE_FORMATTING_RULES}

Relevant passages from series "${seriesName}":

${context}`,
    },
  };
}

export function bookText(bookId: string, bookTitle: string): ScopeText {
  return {
    searching: `Searching "${bookTitle}" (semantic search)...`,
    coverage() {
      const selected = getBookById(bookId);
      return selected
        ? `Yes — I’ve indexed **${selected.title}** and can answer questions about it.`
        : "I don’t have that selected book indexed yet. Re-add or re-index it and I can answer immediately.";
    },
    whoIs: {
      status: (target) => `Looking up who "${target}" is in "${bookTitle}"...`,
      label: () => `book ${bookTitle}`,
    },
    smallTalk: {
      status: "General prompt detected — replying directly as Claude...",
      prompt: (recent, question) => `You are a friendly librarian assistant helping with one selected book (${bookTitle}).
If user asks generally, answer naturally first.
If they ask for evidence, then use citations.
Use recent conversation context for follow-up references.
Recent conversation:
${recent}
User message: ${question}`,
      fallback:
        "Sure — I can help with summaries, character overviews, themes, quotes, and exact evidence from this book.",
    },
    mainCharacters: {
      found: (count) =>
        `Short answer: in **${bookTitle}**, I detect about **${count} main characters** by repeated prominence in the text.`,
      none: "I couldn't confidently identify the main characters yet for this book.",
    },
    quote: {
      status: "Running exact quote lookup in this book...",
      heading: `## Exact Quote Matches in ${bookTitle}`,
      miss: "No exact quote matches found in this book",
    },
    specialists: {
      consulting: (_count, roster) => `Consulting ${roster} for "${bookTitle}"...`,
      merging: "Main AI is composing final answer...",
    },
    rag: {
      found: (semantic, keyword) => `Found ${semantic} semantic + ${keyword} keyword matches`,
      passageHeader: (n, _bookTitle, location) => `[Passage ${n}, ${location}]`,
      noPassages: "(No relevant passages found for this question.)",
      system: ({ voice, context }) => `You are a close friend who knows "${bookTitle}" extremely well. Answer with care, warmth, and accuracy.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, Page X or Chapter Y). Always include the page/chapter location from the passage header. Never state something without a citation.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting. Use phrases like "The text states..." vs. "This suggests..." or "One could interpret this as..."
4. When multiple passages address the same topic, SYNTHESIZE them. Note if they reinforce, expand on, or contradict each other.
5. If the evidence is insufficient or ambiguous, say so explicitly. Never fill gaps with speculation presented as fact. If you suspect there may be MORE instances beyond the provided passages, say so.
6. Structure your response clearly: lead with a direct answer, then present the supporting evidence, then add any caveats or limitations.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

${voice}

${RESPONSE_FORMATTING_RULES}

Sound like a friend who remembers the books — warm, clear, and honest about uncertainty.

Relevant passages from "${bookTitle}":

${context}`,
    },
  };
}
