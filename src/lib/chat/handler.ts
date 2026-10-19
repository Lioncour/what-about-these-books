import { NextRequest } from "next/server";
import { DEFAULT_BEDROCK_MODEL_ID } from "@/lib/bedrock-client";
import {
  queryBook,
  queryAllBooks,
  querySeriesBooks,
  searchBookKeyword,
  searchAllBooksKeyword,
  searchSeriesKeyword,
  countAllBooksKeywordMentions,
  countBookKeywordMentions,
  searchExactQuoteInBook,
  searchExactQuoteAllBooks,
  searchExactQuoteInSeries,
  listSeries,
  listBooks,
  loadSettings,
  getBookById,
} from "@/lib/book-store";
import { logChatEvent } from "@/lib/chat-debug";
import { detectChronologyConflicts, queryEntityGraph } from "@/lib/knowledge-store";
import { callClaudeText, callClaudeStream } from "@/lib/bedrock-claude";
import { getLibrarianName } from "@/lib/chat/constants";
import { RESPONSE_FORMATTING_RULES, buildPersonalityInstructions, voicePreamble } from "@/lib/chat/response-formatting";
import { presenceStatus } from "@/lib/chat/presence";
import { encodeStreamField } from "@/lib/chat/stream-protocol";
import {
  selectBooksForLibrarySpecialists,
  selectBooksForSeriesSpecialists,
} from "@/lib/chat/specialist-limits";
import type { ChatMessage, ChatSource } from "@/lib/chat/types";
import {
  extractQuotedText,
  looksLikeQuoteLookup,
  extractMentionCountTarget,
  resolveCountTarget,
  looksLikeMentionCountQuestion,
  looksLikeMainCharacterQuestion,
  extractWhoIsTarget,
  shouldBypassSpecialists,
  extractRetryQuestion,
  looksLikeLibraryCountQuestion,
  looksLikeHaveYouReadQuestion,
  buildRecentConversation,
  normalizeUserQuestion,
  extractBookCountScope,
  buildSeriesContinuityHint,
} from "@/lib/chat/intent";
import {
  collectMentionSources,
  countMentionsInOrderedBooks,
  describeBookCountScope,
  formatExactMentionAnswer,
  listOrderedSeriesBooks,
  resolveSeriesForMentionCount,
} from "@/lib/chat/mention-count";
import {
  findSmartPassages,
  formatPassageFindAnswer,
  cleanBookDisplayTitle,
} from "@/lib/chat/passage-find";
import {
  findPopCultureReferences,
  formatPopCultureAnswer,
  popCultureHitsToSources,
  dedupeSources,
} from "@/lib/chat/theme-survey";
import { describeRoute, routeChatQuestion } from "@/lib/chat/router";
import {
  deriveMainCharacters,
  askBookSpecialist,
  synthesizeWhoIsAnswer,
  toSpecialistReports,
} from "@/lib/chat/specialist";
import {
  looksLikeThinAnswer,
  orchestrateSpecialists,
  claudeNaturalAnswer,
} from "@/lib/chat/orchestrator";
import {
  resolveLibraryCommand,
  executeLibraryCommand,
  type LibraryCommand,
} from "@/lib/chat/library-commands";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const { bookId, bookTitle, messages } = (await request.json()) as {
      bookId: string;
      bookTitle: string;
      messages: ChatMessage[];
    };

    if (!bookId || !messages?.length) {
      return Response.json(
        { error: "Missing book ID or messages" },
        { status: 400 }
      );
    }

    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMessage) {
      return Response.json({ error: "No user message" }, { status: 400 });
    }
    logChatEvent("chat_request_received", {
      bookId,
      bookTitle,
      messageCount: messages.length,
      lastUserMessage: lastUserMessage.content.slice(0, 300),
    });

    const readable = new ReadableStream({
      async start(controller) {
        let companionMode = true;
        const send = (type: string, data: string) => {
          const payload = type === "STATUS" ? presenceStatus(data, companionMode) : data;
          controller.enqueue(encoder.encode(`${type}:${payload}\n`));
        };
        const emitToken = (delta: string) => {
          if (!delta) return;
          controller.enqueue(encoder.encode(encodeStreamField("TOKEN", delta)));
        };

        try {
          const emitAnswer = (text: string, meta?: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(encodeStreamField("TEXT", text)));
            logChatEvent("chat_answer_emitted", {
              bookId,
              chars: text.length,
              thin: looksLikeThinAnswer(text),
              ...meta,
            });
          };
          let systemPrompt: string;
          const aiSettings = loadSettings();
          const specialistModelId = aiSettings.modelRouting?.specialistModelId || DEFAULT_BEDROCK_MODEL_ID;
          const orchestratorModelId = aiSettings.modelRouting?.orchestratorModelId || DEFAULT_BEDROCK_MODEL_ID;
          const groundedMode = Boolean(aiSettings.groundedMode);
          const countMode = aiSettings.countMode || "whole_word";
          const answerMode = aiSettings.answerMode || "Evidence-heavy";
          companionMode = aiSettings.companionMode !== false;

          const sources: ChatSource[] = [];
          const retryQuestion = extractRetryQuestion(lastUserMessage.content);
          const questionText = normalizeUserQuestion(
            retryQuestion?.question || lastUserMessage.content
          );
          if (retryQuestion) {
            logChatEvent("chat_retry_requested", {
              bookId,
              step: retryQuestion.step,
              originalInput: lastUserMessage.content.slice(0, 220),
              restoredQuestion: questionText.slice(0, 220),
            });
          }
          const mentionTargetRaw = extractMentionCountTarget(questionText);
          const mentionTarget = resolveCountTarget(questionText, messages);
          const bookCountScope = extractBookCountScope(questionText);
          const seriesForMentionCount = mentionTarget
            ? resolveSeriesForMentionCount(questionText, bookId)
            : null;
          let recentConversation =
            aiSettings.useConversationMemory === false ? "" : buildRecentConversation(messages);

          // Series continuity for open-ended / specialist answers
          const seriesForContinuity =
            seriesForMentionCount ||
            (bookId.startsWith("series:")
              ? listSeries().find((s) => s.id === bookId.slice("series:".length)) || null
              : bookId !== "all"
                ? listSeries().find((s) => s.bookIds.includes(bookId)) || null
                : null);
          const continuityHint = buildSeriesContinuityHint({
            orderedTitles: seriesForContinuity
              ? listOrderedSeriesBooks(seriesForContinuity.id).map((r) =>
                  cleanBookDisplayTitle(r.book.title)
                )
              : [],
            focusTitle: bookTitle,
          });
          if (continuityHint) {
            recentConversation = recentConversation
              ? `${continuityHint}\n\n${recentConversation}`
              : continuityHint;
          }

          const runLibraryCommand = async (command: LibraryCommand): Promise<boolean> => {
            send("STATUS", "Running library command...");
            const scopeBookId =
              bookId && bookId !== "all" && !bookId.startsWith("series:") ? bookId : undefined;
            const result = await executeLibraryCommand(command, { focusBookId: scopeBookId });
            emitAnswer(result.message, {
              reason: "library_command",
              command: command.type,
            });
            if (result.libraryChanged) {
              send("LIBRARY_CHANGED", JSON.stringify({ clearFocus: Boolean(result.clearFocus) }));
            }
            logChatEvent("library_command_executed", {
              command: command.type,
              libraryChanged: result.libraryChanged,
            });
            return true;
          };

          const libraryCommand = resolveLibraryCommand(
            lastUserMessage.content,
            questionText
          );
          if (libraryCommand) {
            await runLibraryCommand(libraryCommand);
            controller.close();
            return;
          }

          const route = routeChatQuestion({
            question: questionText,
            messages,
            answerMode,
          });
          logChatEvent("chat_routed", {
            bookId,
            kind: route.kind,
            reason: route.reason,
            usesTool: route.usesTool,
            target: route.target || null,
          });

          const forceExactCount = route.kind === "mention_count";

          // Exact mention counts always win — never specialists / estimates.
          if (mentionTarget && forceExactCount) {
            const series =
              seriesForMentionCount ||
              (bookId.startsWith("series:")
                ? listSeries().find((s) => s.id === bookId.slice("series:".length)) || null
                : null);

            if (series) {
              send(
                "STATUS",
                `Counting exact mentions of "${mentionTarget}" in series "${series.name}"...`
              );
              const counted = countMentionsInOrderedBooks({
                seriesId: series.id,
                keyword: mentionTarget,
                countMode,
                scope: bookCountScope,
              });
              const byBook = counted.rows.map(
                (r) => [r.bookTitle, r.count] as [string, number]
              );
              sources.push(
                ...collectMentionSources(
                  counted.rows.map((r) => r.bookId),
                  mentionTarget,
                  4
                )
              );
              const text = formatExactMentionAnswer({
                target: mentionTarget,
                total: counted.total,
                byBook,
                scopeLabel: describeBookCountScope(bookCountScope, series.name),
                countMode,
                includedTitles:
                  bookCountScope.kind !== "all" ? counted.includedTitles : undefined,
              });
              logChatEvent("mention_count_answered", {
                scope: "series",
                seriesId: series.id,
                mentionTarget,
                total: counted.total,
                bookCountScope,
                booksCounted: counted.scopedBookCount,
                exact: true,
                earlyGate: true,
              });
              emitAnswer(text, { reason: "exact_mention_count", scope: "series" });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            if (bookId !== "all" && !bookId.startsWith("series:")) {
              send("STATUS", `Counting exact mentions of "${mentionTarget}" in "${bookTitle}"...`);
              const total = countBookKeywordMentions(bookId, mentionTarget, countMode);
              const mentionMatches = searchBookKeyword(bookId, [mentionTarget], 40);
              for (const m of mentionMatches) {
                sources.push({
                  book: bookTitle,
                  excerpt: m.snippet,
                  position: m.label,
                });
              }
              const text = formatExactMentionAnswer({
                target: mentionTarget,
                total,
                byBook: total > 0 ? [[bookTitle, total]] : [],
                scopeLabel: `in **${bookTitle}**`,
                countMode,
              });
              logChatEvent("mention_count_answered", {
                scope: "book",
                bookId,
                mentionTarget,
                total,
                exact: true,
                earlyGate: true,
              });
              emitAnswer(text, { reason: "exact_mention_count", scope: "book" });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            send("STATUS", `Counting exact mentions of "${mentionTarget}" across your library...`);
            const byBookRows = countAllBooksKeywordMentions(mentionTarget, countMode);
            const total = byBookRows.reduce((sum, r) => sum + r.count, 0);
            const byBook = byBookRows.map((r) => [r.bookTitle, r.count] as [string, number]);
            const mentionMatches = searchAllBooksKeyword([mentionTarget], 40);
            for (const m of mentionMatches) {
              sources.push({
                book: m.bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
            }
            const text = formatExactMentionAnswer({
              target: mentionTarget,
              total,
              byBook,
              scopeLabel: "across your library",
              countMode,
            });
            logChatEvent("mention_count_answered", {
              scope: "all",
              mentionTarget,
              total,
              books: byBook.length,
              exact: true,
              earlyGate: true,
            });
            emitAnswer(text, { reason: "exact_mention_count", scope: "all" });
            if (sources.length) send("SOURCES", JSON.stringify(sources));
            controller.close();
            return;
          }

          if (forceExactCount && !mentionTarget) {
            emitAnswer("I can count mentions exactly in your indexed text — who should I count?", {
              reason: "missing_mention_target",
            });
            logChatEvent("mention_count_missing_target", {
              bookId,
              input: questionText.slice(0, 180),
              earlyGate: true,
            });
            controller.close();
            return;
          }

          // Passage / recipe / "find that thing" — short answer + clickable sources.
          if (route.kind === "passage_find") {
            send("STATUS", describeRoute(route));
            const hits = findSmartPassages({
              question: questionText,
              bookId,
              maxHits: 3,
            });
            // Primary hit first; keep at most a couple related refs for Sources
            for (const hit of hits.slice(0, 2)) {
              sources.push({
                book: cleanBookDisplayTitle(hit.bookTitle),
                excerpt: hit.snippet,
                position: hit.label,
                bookId: hit.bookId,
              });
            }
            const text = formatPassageFindAnswer({ question: questionText, hits });
            logChatEvent("passage_find_answered", {
              bookId,
              hits: hits.length,
              topScore: hits[0]?.score ?? 0,
              topReason: hits[0]?.reason ?? null,
              topBook: hits[0]?.bookTitle ?? null,
              route: route.kind,
            });
            emitAnswer(text, { reason: "passage_find", hits: hits.length });
            const uniqueSources = dedupeSources(sources);
            if (uniqueSources.length) send("SOURCES", JSON.stringify(uniqueSources));
            controller.close();
            return;
          }

          // Theme surveys (e.g. pop culture / movies / books references)
          if (route.kind === "theme_pop_culture") {
            send("STATUS", describeRoute(route));
            const hits = findPopCultureReferences({ bookId, maxHits: 10 });
            const text = formatPopCultureAnswer(hits);
            const themeSources = dedupeSources(popCultureHitsToSources(hits));
            sources.push(...themeSources);
            logChatEvent("theme_survey_answered", {
              bookId,
              kind: "pop_culture",
              hits: hits.length,
              labels: hits.map((h) => h.label),
              route: route.kind,
            });
            emitAnswer(text, { reason: "theme_survey_pop_culture", hits: hits.length });
            if (themeSources.length) send("SOURCES", JSON.stringify(themeSources));
            controller.close();
            return;
          }

          const bookGroundedIntent = /\b(book|books|library|chapter|page|quote|character|theme|plot|series|mentioned|mentions|who is|in this book)\b/i.test(
            questionText
          );
          send("STATUS", describeRoute(route));
          logChatEvent("claude_specialist_decision_started", {
            bookId,
            bookGroundedIntent,
            route: route.kind,
            input: questionText.slice(0, 180),
          });
          logChatEvent("chat_pipeline_start", {
            bookId,
            mentionTargetRaw,
            mentionTargetResolved: mentionTarget,
            quoteLookup: looksLikeQuoteLookup(questionText),
            route: route.kind,
            retryStep: retryQuestion?.step || null,
          });
          if (route.kind === "mention_count" && !mentionTarget) {
            emitAnswer("I can count mentions exactly in your indexed text — who should I count?", {
              reason: "missing_mention_target",
            });
            logChatEvent("mention_count_missing_target", {
              bookId,
              input: questionText.slice(0, 180),
            });
            controller.close();
            return;
          }

          if (route.kind === "entity_graph" || /entity graph|relationship graph|who is connected/i.test(questionText)) {
            const graph = queryEntityGraph(questionText.replace(/entity graph|relationship graph/gi, "").trim());
            const lines: string[] = ["## Entity Graph Matches", ""];
            lines.push(`Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);
            for (const node of graph.nodes.slice(0, 20)) {
              lines.push(`- **${node.name}** (${node.type}) mentions: ${node.mentions}`);
            }
            emitAnswer(lines.join("\n"), { reason: "entity_graph" });
            controller.close();
            return;
          }
          if (/timeline conflict|chronology conflict|timeline issue/i.test(questionText)) {
            const conflicts = detectChronologyConflicts();
            const text = conflicts.length
              ? `## Timeline Conflicts\n\n${conflicts.map((c) => `- ${c}`).join("\n")}`
              : "## Timeline Conflicts\n\nNo obvious chronology conflicts detected.";
            emitAnswer(text, { reason: "timeline_conflict_check" });
            controller.close();
            return;
          }

          if (bookId === "all") {
            send("STATUS", "Searching across your entire library (semantic search)...");
            if (looksLikeHaveYouReadQuestion(questionText)) {
              const totalBooks = listBooks().length;
              const factual =
                totalBooks > 0
                  ? `Yes — I’ve indexed your uploaded library and can answer questions from it. Right now I can see **${totalBooks} book${totalBooks === 1 ? "" : "s"}**.`
                  : "Not yet — I don’t see any uploaded books in your library. Add a book and I can answer from it immediately.";
              const text = await claudeNaturalAnswer({ userQuestion: questionText, factualAnswer: factual, modelId: orchestratorModelId, companionMode });
              emitAnswer(text, { reason: "have_you_read", scope: "all", usedSpecialists: false });
              controller.close();
              return;
            }
            if (looksLikeLibraryCountQuestion(questionText)) {
              const totalBooks = listBooks().length;
              const text =
                totalBooks === 0
                  ? "You currently have **0 books** in your library."
                  : `You currently have **${totalBooks} book${totalBooks === 1 ? "" : "s"}** in your library.`;
              const natural = await claudeNaturalAnswer({ userQuestion: questionText, factualAnswer: text, modelId: orchestratorModelId, companionMode });
              emitAnswer(natural, { reason: "library_count", usedSpecialists: false });
              logChatEvent("library_count_answered", { totalBooks });
              controller.close();
              return;
            }
            const whoTarget = extractWhoIsTarget(questionText);
            if (whoTarget) {
              send("STATUS", `Looking up who "${whoTarget}" is in your library...`);
              const matches = searchAllBooksKeyword([whoTarget], 120);
              for (const hit of matches.slice(0, 30)) {
                sources.push({
                  book: hit.bookTitle,
                  excerpt: hit.snippet,
                  position: hit.label,
                });
              }
              const grouped = new Map<string, number>();
              for (const m of matches) grouped.set(m.bookTitle, (grouped.get(m.bookTitle) || 0) + 1);
              const topBook = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0];
              const scopeLabel = topBook?.[0]
                ? `your library (mostly in ${topBook[0]})`
                : "your library";
              const summary = await synthesizeWhoIsAnswer({
                target: whoTarget,
                scopeLabel,
                snippets: sources.map((s) => ({
                  book: s.book,
                  label: s.position || "Unknown location",
                  snippet: s.excerpt,
                })),
                conversationContext: recentConversation,
                modelId: orchestratorModelId,
              });
              const lines = [summary];
              controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              logChatEvent("who_is_answered", { scope: "all", whoTarget, matches: matches.length });
              controller.close();
              return;
            }
            if (!mentionTarget && shouldBypassSpecialists(questionText) && !bookGroundedIntent) {
              send("STATUS", "This is a general prompt — replying directly as your library assistant...");
              const directPrompt = `You are a friendly, practical digital librarian assistant.
Answer naturally like a real helpful person.
Do not claim you searched books unless the user asked for book-grounded evidence.
Use recent conversation context for follow-up references.
Recent conversation:
${recentConversation}
User message: ${questionText}`;
              const directText = await callClaudeText(directPrompt, 900, 0.4, orchestratorModelId);
              const final = directText || "I can help you explore your library, compare books, find quotes, count mentions, and summarize chapters with sources.";
              emitAnswer(final, { reason: "bypass_general_prompt", scope: "all", usedSpecialists: false });
              logChatEvent("specialist_bypass_general_prompt", { scope: "all", input: questionText.slice(0, 160) });
              controller.close();
              return;
            }

            const quotedText = extractQuotedText(questionText);
            const quoteMode = quotedText || (looksLikeQuoteLookup(questionText) ? questionText : null);
            if (looksLikeMainCharacterQuestion(questionText)) {
              const allIds = listBooks().map((b) => b.id);
              const mains = deriveMainCharacters(allIds);
              const lines: string[] = [];
              if (mains.length) {
                lines.push(
                  `Short answer: I detect about **${mains.length} main characters** across the current scope, based on repeated entity prominence in the text.`
                );
                lines.push("");
                lines.push("## Likely main characters");
                for (const m of mains) {
                  lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
                }
                for (const m of mains.slice(0, 5)) {
                  const matches = searchAllBooksKeyword([m.name], 4);
                  for (const hit of matches) {
                    sources.push({
                      book: hit.bookTitle,
                      excerpt: hit.snippet,
                      position: hit.label,
                    });
                  }
                }
              } else {
                lines.push(
                  "I couldn't confidently identify main characters yet. Try re-indexing this book or asking with a specific book selected."
                );
              }
              logChatEvent("main_character_answered", { scope: "all", count: mains.length });
              const natural = await claudeNaturalAnswer({ userQuestion: questionText, factualAnswer: lines.join("\n"), modelId: orchestratorModelId, companionMode });
              emitAnswer(natural, { reason: "main_character", scope: "all", usedSpecialists: false });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (mentionTarget) {
              // Prefer series (or first-N / range) when we can resolve one.
              if (seriesForMentionCount) {
                send(
                  "STATUS",
                  `Counting exact mentions of "${mentionTarget}" in series "${seriesForMentionCount.name}"...`
                );
                const counted = countMentionsInOrderedBooks({
                  seriesId: seriesForMentionCount.id,
                  keyword: mentionTarget,
                  countMode,
                  scope: bookCountScope,
                });
                const byBook = counted.rows.map(
                  (r) => [r.bookTitle, r.count] as [string, number]
                );
                sources.push(
                  ...collectMentionSources(
                    counted.rows.map((r) => r.bookId),
                    mentionTarget,
                    4
                  )
                );
                const text = formatExactMentionAnswer({
                  target: mentionTarget,
                  total: counted.total,
                  byBook,
                  scopeLabel: describeBookCountScope(
                    bookCountScope,
                    seriesForMentionCount.name
                  ),
                  countMode,
                  includedTitles:
                    bookCountScope.kind !== "all" ? counted.includedTitles : undefined,
                });
                logChatEvent("mention_count_answered", {
                  scope: "series",
                  seriesId: seriesForMentionCount.id,
                  mentionTarget,
                  total: counted.total,
                  bookCountScope,
                  booksCounted: counted.scopedBookCount,
                  exact: true,
                });
                emitAnswer(text, { reason: "exact_mention_count", scope: "series" });
                if (sources.length) send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }

              send("STATUS", `Counting exact mentions of "${mentionTarget}" across your library...`);
              const byBookRows = countAllBooksKeywordMentions(mentionTarget, countMode);
              const total = byBookRows.reduce((sum, r) => sum + r.count, 0);
              const byBook = byBookRows.map((r) => [r.bookTitle, r.count] as [string, number]);
              const mentionMatches = searchAllBooksKeyword([mentionTarget], 40);
              for (const m of mentionMatches) {
                sources.push({
                  book: m.bookTitle,
                  excerpt: m.snippet,
                  position: m.label,
                });
              }
              const text = formatExactMentionAnswer({
                target: mentionTarget,
                total,
                byBook,
                scopeLabel: "across your library",
                countMode,
              });
              logChatEvent("mention_count_answered", {
                scope: "all",
                mentionTarget,
                total,
                books: byBook.length,
                exact: true,
              });
              emitAnswer(text, { reason: "exact_mention_count", scope: "all" });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            if (forceExactCount) {
              emitAnswer("I can count mentions exactly — tell me the name to count.", {
                reason: "exact_count_mode_missing_target",
              });
              controller.close();
              return;
            }

            if (!quoteMode && !forceExactCount) {
              const libraryCmdLate = resolveLibraryCommand(
                lastUserMessage.content,
                questionText
              );
              if (libraryCmdLate) {
                await runLibraryCommand(libraryCmdLate);
                controller.close();
                return;
              }
              send("STATUS", "Building specialist roster from your books...");
              const chosenBooks = await selectBooksForLibrarySpecialists(questionText);

              if (!chosenBooks.length) {
                send("ERROR", "No books available for specialist analysis.");
                controller.close();
                return;
              }

              const roster = chosenBooks
                .slice(0, 4)
                .map((b, i) => `Librarian ${getLibrarianName(b.title, i)}`)
                .join(", ");
              send("STATUS", `Consulting ${chosenBooks.length} Librarian agents${roster ? `: ${roster}` : ""}...`);
              const specialistAnswers = await Promise.all(
                chosenBooks.map((b) =>
                  askBookSpecialist({
                    bookId: b.id,
                    bookTitle: b.title,
                    userQuestion: questionText,
                    modelId: specialistModelId,
                  })
                )
              );
              logChatEvent("specialists_completed", {
                scope: "all",
                count: specialistAnswers.length,
                lowConfidence: specialistAnswers.filter((s) => s.confidence === "low").length,
              });

              for (const ans of specialistAnswers) {
                for (const finding of ans.findings.slice(0, 6)) {
                  sources.push({
                    book: ans.bookTitle,
                    excerpt: finding.evidence || finding.finding,
                    position: finding.location,
                  });
                }
              }

              send("STATUS", "Main AI is merging specialist reports...");
              send("SPECIALISTS", JSON.stringify(toSpecialistReports(specialistAnswers)));
              const personalityHint = buildPersonalityInstructions({
                language: aiSettings.language,
                tone: aiSettings.tone,
                focusAreas: aiSettings.focusAreas,
                customInstructions: aiSettings.customInstructions,
                answerMode,
                companionMode,
              });
              const finalText = await orchestrateSpecialists(
                questionText,
                specialistAnswers,
                orchestratorModelId,
                personalityHint,
                { companionMode, onToken: emitToken, continuityHint }
              );
              logChatEvent("orchestrator_text_generated", {
                scope: "all",
                chars: finalText.length,
                thin: looksLikeThinAnswer(finalText),
              });
              logChatEvent("chat_answer_emitted", {
                bookId,
                chars: finalText.length,
                thin: looksLikeThinAnswer(finalText),
                reason: "orchestrated_specialists",
                scope: "all",
                usedSpecialists: true,
                streamed: true,
              });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            const passagesPromise = queryAllBooks(questionText, 20);
            if (quoteMode) {
              send("STATUS", "Running exact quote lookup across all books...");
              const exactMatches = searchExactQuoteAllBooks(quoteMode, 120);
              if (exactMatches.length > 0) {
                send("STATUS", `Exact quote matches found: ${exactMatches.length}`);
                const grouped = new Map<string, { label: string; snippet: string }[]>();
                for (const m of exactMatches) {
                  if (!grouped.has(m.bookTitle)) grouped.set(m.bookTitle, []);
                  grouped.get(m.bookTitle)!.push({ label: m.label, snippet: m.snippet });
                  sources.push({
                    book: m.bookTitle,
                    excerpt: m.snippet,
                    position: m.label,
                  });
                }
                const lines: string[] = [];
                lines.push("## Exact Quote Matches");
                lines.push("");
                lines.push(`Found **${exactMatches.length}** matches across **${grouped.size}** book(s).`);
                for (const [title, entries] of grouped) {
                  lines.push("");
                  lines.push(`### ${title}`);
                  for (const entry of entries) {
                    lines.push(`- **${entry.label}**: ${entry.snippet}`);
                  }
                }
                emitAnswer(lines.join("\n"), { reason: "exact_quote", scope: "all" });
                send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
              send("STATUS", "No exact quote matches found in stored page text");
            }

            send("STATUS", "Running keyword search for exact matches...");
            const queryWords = questionText
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 5);
            const [passages, keywordMatches] = await Promise.all([
              passagesPromise,
              Promise.resolve(queryWords.length ? searchAllBooksKeyword(queryWords, 500) : []),
            ]);

            const totalFound = passages.length + keywordMatches.length;
            if (totalFound) {
              const bookNames = [
                ...new Set([
                  ...passages.map((p) => p.bookTitle),
                  ...keywordMatches.map((m) => m.bookTitle),
                ]),
              ];
              send(
                "STATUS",
                `Found ${passages.length} semantic + ${keywordMatches.length} keyword matches from ${bookNames.length} book${bookNames.length !== 1 ? "s" : ""}`
              );
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            let passageNum = 0;
            const contextParts: string[] = [];

            for (const p of passages) {
              passageNum++;
              sources.push({
                book: p.bookTitle,
                excerpt: p.text.slice(0, 200).replace(/\s+/g, " ").trim(),
                position: p.location,
              });
              contextParts.push(`[Passage ${passageNum} — from "${p.bookTitle}", ${p.location}]\n${p.text}`);
            }

            for (const m of keywordMatches) {
              passageNum++;
              sources.push({
                book: m.bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
              contextParts.push(`[Passage ${passageNum} — from "${m.bookTitle}", ${m.label}]\n${m.snippet}`);
            }

            const context = contextParts.length
              ? contextParts.join("\n\n---\n\n")
              : "(No relevant passages found across your library.)";

            systemPrompt = `You are a close friend who knows this library extremely well. Answer with care, warmth, and accuracy.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, "${passages[0]?.bookTitle || "Book Title"}", Page X or Chapter Y). Always include the page/chapter location. Never state something without a citation.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting. Use phrases like "The text states..." vs. "This suggests..." or "One could interpret this as..."
4. When multiple passages or books address the same topic, COMPARE and CONTRAST them. Note agreements, contradictions, or different perspectives.
5. If the evidence is insufficient or ambiguous, say so explicitly. Never fill gaps with speculation presented as fact. If you suspect there may be MORE instances beyond the provided passages, say so.
6. Structure your response clearly: lead with a direct answer, then present the supporting evidence, then add any caveats or limitations.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

${voicePreamble(companionMode)}

${RESPONSE_FORMATTING_RULES}

Sound like a friend who remembers the books — warm, clear, and honest about uncertainty.

Relevant passages from the user's library:

${context}`;
          } else if (bookId.startsWith("series:")) {
            const seriesId = bookId.replace("series:", "");
            const seriesEntry = listSeries().find((s) => s.id === seriesId);
            const seriesName = seriesEntry?.name || bookTitle;
            send("STATUS", `Searching series "${seriesName}" (semantic search)...`);
            if (looksLikeHaveYouReadQuestion(questionText)) {
              const seriesBooks = listBooks().filter((b) => seriesEntry?.bookIds.includes(b.id));
              const factual =
                seriesBooks.length > 0
                  ? `Yes — I’ve indexed the books in **${seriesName}** and can answer from them. I currently see **${seriesBooks.length}** book${seriesBooks.length === 1 ? "" : "s"} in this series.`
                  : `Not yet — I can’t find indexed books in **${seriesName}** yet.`;
              const text = await claudeNaturalAnswer({ userQuestion: questionText, factualAnswer: factual, modelId: orchestratorModelId, companionMode });
              emitAnswer(text, { reason: "have_you_read", scope: "series", seriesId, usedSpecialists: false });
              controller.close();
              return;
            }
            const whoTarget = extractWhoIsTarget(questionText);
            if (whoTarget) {
              send("STATUS", `Looking up who "${whoTarget}" is in series "${seriesName}"...`);
              const matches = searchSeriesKeyword(seriesId, [whoTarget], 120);
              for (const hit of matches.slice(0, 30)) {
                sources.push({
                  book: hit.bookTitle,
                  excerpt: hit.snippet,
                  position: hit.label,
                });
              }
              const grouped = new Map<string, number>();
              for (const m of matches) grouped.set(m.bookTitle, (grouped.get(m.bookTitle) || 0) + 1);
              const topBook = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0];
              const scopeLabel = topBook?.[0]
                ? `series ${seriesName} (mostly in ${topBook[0]})`
                : `series ${seriesName}`;
              const summary = await synthesizeWhoIsAnswer({
                target: whoTarget,
                scopeLabel,
                snippets: sources.map((s) => ({
                  book: s.book,
                  label: s.position || "Unknown location",
                  snippet: s.excerpt,
                })),
                conversationContext: recentConversation,
                modelId: orchestratorModelId,
              });
              const lines = [summary];
              controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              logChatEvent("who_is_answered", { scope: "series", seriesId, whoTarget, matches: matches.length });
              controller.close();
              return;
            }
            if (!mentionTarget && shouldBypassSpecialists(questionText) && !bookGroundedIntent) {
              send("STATUS", "General prompt detected — replying directly without specialist fan-out...");
              const directPrompt = `You are a friendly librarian assistant helping with a selected series context (${seriesName}).
If the user is not asking for evidence from books, respond conversationally and briefly.
Use recent conversation context for follow-up references.
Recent conversation:
${recentConversation}
User message: ${questionText}`;
              const directText = await callClaudeText(directPrompt, 900, 0.4, orchestratorModelId);
              const final = directText || "I can help with this series — ask me about characters, themes, or specific evidence when you want citations.";
              emitAnswer(final, { reason: "bypass_general_prompt", scope: "series", usedSpecialists: false });
              logChatEvent("specialist_bypass_general_prompt", { scope: "series", seriesId, input: questionText.slice(0, 160) });
              controller.close();
              return;
            }

            const quotedText = extractQuotedText(questionText);
            const quoteMode = quotedText || (looksLikeQuoteLookup(questionText) ? questionText : null);
            if (looksLikeMainCharacterQuestion(questionText)) {
              const seriesBookIds = listSeries().find((s) => s.id === seriesId)?.bookIds || [];
              const mains = deriveMainCharacters(seriesBookIds);
              const lines: string[] = [];
              if (mains.length) {
                lines.push(
                  `Short answer: in **${seriesName}**, I detect about **${mains.length} main characters** from repeated prominence patterns.`
                );
                lines.push("");
                lines.push("## Likely main characters");
                for (const m of mains) {
                  lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
                }
                for (const m of mains.slice(0, 5)) {
                  const matches = searchSeriesKeyword(seriesId, [m.name], 4);
                  for (const hit of matches) {
                    sources.push({
                      book: hit.bookTitle,
                      excerpt: hit.snippet,
                      position: hit.label,
                    });
                  }
                }
              } else {
                lines.push("I couldn't confidently identify main characters in this series yet.");
              }
              logChatEvent("main_character_answered", { scope: "series", seriesId, count: mains.length });
              controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (mentionTarget) {
              const seriesIdForCount = seriesForMentionCount?.id || seriesId;
              const seriesNameForCount = seriesForMentionCount?.name || seriesName;
              send(
                "STATUS",
                `Counting exact mentions of "${mentionTarget}" in series "${seriesNameForCount}"...`
              );
              const counted = countMentionsInOrderedBooks({
                seriesId: seriesIdForCount,
                keyword: mentionTarget,
                countMode,
                scope: bookCountScope,
              });
              const byBook = counted.rows.map(
                (r) => [r.bookTitle, r.count] as [string, number]
              );
              sources.push(
                ...collectMentionSources(
                  counted.rows.map((r) => r.bookId),
                  mentionTarget,
                  4
                )
              );
              const text = formatExactMentionAnswer({
                target: mentionTarget,
                total: counted.total,
                byBook,
                scopeLabel: describeBookCountScope(bookCountScope, seriesNameForCount),
                countMode,
                includedTitles:
                  bookCountScope.kind !== "all" ? counted.includedTitles : undefined,
              });
              logChatEvent("mention_count_answered", {
                scope: "series",
                seriesId: seriesIdForCount,
                mentionTarget,
                total: counted.total,
                bookCountScope,
                booksCounted: counted.scopedBookCount,
                exact: true,
              });
              emitAnswer(text, { reason: "exact_mention_count", scope: "series" });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            if (forceExactCount) {
              emitAnswer("I can count mentions exactly — tell me the name to count.", {
                reason: "exact_count_mode_missing_target",
              });
              controller.close();
              return;
            }

            if (!quoteMode && !forceExactCount && seriesEntry) {
              const libraryCmdSeries = resolveLibraryCommand(
                lastUserMessage.content,
                questionText
              );
              if (libraryCmdSeries) {
                await runLibraryCommand(libraryCmdSeries);
                controller.close();
                return;
              }
              const catalogBooks = selectBooksForSeriesSpecialists(seriesEntry.bookIds);
              if (catalogBooks.length) {
                const roster = catalogBooks
                  .slice(0, 4)
                  .map((b, i) => `Librarian ${getLibrarianName(b.title, i)}`)
                  .join(", ");
                send("STATUS", `Consulting ${catalogBooks.length} series Librarians${roster ? `: ${roster}` : ""}...`);
                const specialistAnswers = await Promise.all(
                  catalogBooks.map((b) =>
                    askBookSpecialist({
                      bookId: b.id,
                      bookTitle: b.title,
                    userQuestion: questionText,
                      modelId: specialistModelId,
                    })
                  )
                );
                logChatEvent("specialists_completed", {
                  scope: "series",
                  count: specialistAnswers.length,
                  lowConfidence: specialistAnswers.filter((s) => s.confidence === "low").length,
                });
                for (const ans of specialistAnswers) {
                  for (const finding of ans.findings.slice(0, 6)) {
                    sources.push({
                      book: ans.bookTitle,
                      excerpt: finding.evidence || finding.finding,
                      position: finding.location,
                    });
                  }
                }
                send("STATUS", "Main AI is merging specialist reports...");
                send("SPECIALISTS", JSON.stringify(toSpecialistReports(specialistAnswers)));
                const personalityHint = buildPersonalityInstructions({
                language: aiSettings.language,
                tone: aiSettings.tone,
                focusAreas: aiSettings.focusAreas,
                customInstructions: aiSettings.customInstructions,
                answerMode,
                companionMode,
              });
              const finalText = await orchestrateSpecialists(
                questionText,
                specialistAnswers,
                orchestratorModelId,
                personalityHint,
                { companionMode, onToken: emitToken, continuityHint }
              );
                logChatEvent("orchestrator_text_generated", {
                  scope: "series",
                  chars: finalText.length,
                  thin: looksLikeThinAnswer(finalText),
                });
                logChatEvent("chat_answer_emitted", {
                  bookId,
                  chars: finalText.length,
                  thin: looksLikeThinAnswer(finalText),
                  reason: "orchestrated_specialists",
                  scope: "series",
                  usedSpecialists: true,
                  streamed: true,
                });
                if (sources.length) send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
            }

            const passagesPromise = querySeriesBooks(seriesId, questionText, 20);
            if (quoteMode) {
              send("STATUS", `Running exact quote lookup in series "${seriesName}"...`);
              const exactMatches = searchExactQuoteInSeries(seriesId, quoteMode, 90);
              if (exactMatches.length > 0) {
                send("STATUS", `Exact quote matches found: ${exactMatches.length}`);
                const grouped = new Map<string, { label: string; snippet: string }[]>();
                for (const m of exactMatches) {
                  if (!grouped.has(m.bookTitle)) grouped.set(m.bookTitle, []);
                  grouped.get(m.bookTitle)!.push({ label: m.label, snippet: m.snippet });
                  sources.push({
                    book: m.bookTitle,
                    excerpt: m.snippet,
                    position: m.label,
                  });
                }
                const lines: string[] = [];
                lines.push(`## Exact Quote Matches in ${seriesName}`);
                lines.push("");
                lines.push(`Found **${exactMatches.length}** matches across **${grouped.size}** book(s).`);
                for (const [title, entries] of grouped) {
                  lines.push("");
                  lines.push(`### ${title}`);
                  for (const entry of entries) {
                    lines.push(`- **${entry.label}**: ${entry.snippet}`);
                  }
                }
                controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
                send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
              send("STATUS", "No exact quote matches found in this series");
            }

            send("STATUS", "Running keyword search for exact matches...");
            const queryWords = questionText
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 5);
            const [passages, keywordMatches] = await Promise.all([
              passagesPromise,
              Promise.resolve(queryWords.length ? searchSeriesKeyword(seriesId, queryWords, 400) : []),
            ]);

            const totalFound = passages.length + keywordMatches.length;
            if (totalFound) {
              const bookNames = [
                ...new Set([
                  ...passages.map((p) => p.bookTitle),
                  ...keywordMatches.map((m) => m.bookTitle),
                ]),
              ];
              send(
                "STATUS",
                `Found ${passages.length} semantic + ${keywordMatches.length} keyword matches from ${bookNames.length} book${bookNames.length !== 1 ? "s" : ""} in this series`
              );
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            let passageNum = 0;
            const contextParts: string[] = [];

            for (const p of passages) {
              passageNum++;
              sources.push({
                book: p.bookTitle,
                excerpt: p.text.slice(0, 200).replace(/\s+/g, " ").trim(),
                position: p.location,
              });
              contextParts.push(`[Passage ${passageNum} — from "${p.bookTitle}", ${p.location}]\n${p.text}`);
            }

            for (const m of keywordMatches) {
              passageNum++;
              sources.push({
                book: m.bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
              contextParts.push(`[Passage ${passageNum} — from "${m.bookTitle}", ${m.label}]\n${m.snippet}`);
            }

            const context = contextParts.length
              ? contextParts.join("\n\n---\n\n")
              : `(No relevant passages found for series "${seriesName}".)`;

            systemPrompt = `You are a close friend who knows the series "${seriesName}" extremely well. Answer with care, warmth, and accuracy.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, "Book Title", Page X or Chapter Y). Always include both book title and location.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting.
4. Compare how the books in the series agree or differ when relevant.
5. If evidence is insufficient or ambiguous, say so explicitly.
6. Structure your response with a direct answer, supporting evidence, then caveats.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

${voicePreamble(companionMode)}

${RESPONSE_FORMATTING_RULES}

Relevant passages from series "${seriesName}":

${context}`;
          } else {
            send("STATUS", `Searching "${bookTitle}" (semantic search)...`);
            if (looksLikeHaveYouReadQuestion(questionText)) {
              const selected = getBookById(bookId);
              const factual = selected
                ? `Yes — I’ve indexed **${selected.title}** and can answer questions about it.`
                : "I don’t have that selected book indexed yet. Re-add or re-index it and I can answer immediately.";
              const text = await claudeNaturalAnswer({ userQuestion: questionText, factualAnswer: factual, modelId: orchestratorModelId, companionMode });
              emitAnswer(text, { reason: "have_you_read", scope: "book", bookId, usedSpecialists: false });
              controller.close();
              return;
            }
            const whoTarget = extractWhoIsTarget(questionText);
            if (whoTarget) {
              send("STATUS", `Looking up who "${whoTarget}" is in "${bookTitle}"...`);
              const matches = searchBookKeyword(bookId, [whoTarget], 120);
              for (const hit of matches.slice(0, 30)) {
                sources.push({
                  book: bookTitle,
                  excerpt: hit.snippet,
                  position: hit.label,
                });
              }
              const summary = await synthesizeWhoIsAnswer({
                target: whoTarget,
                scopeLabel: `book ${bookTitle}`,
                snippets: sources.map((s) => ({
                  book: s.book,
                  label: s.position || "Unknown location",
                  snippet: s.excerpt,
                })),
                conversationContext: recentConversation,
                modelId: orchestratorModelId,
              });
              const lines = [summary];
              controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              logChatEvent("who_is_answered", { scope: "book", bookId, whoTarget, matches: matches.length });
              controller.close();
              return;
            }
            if (!mentionTarget && shouldBypassSpecialists(questionText) && !bookGroundedIntent) {
              send("STATUS", "General prompt detected — replying directly as Claude...");
              const directPrompt = `You are a friendly librarian assistant helping with one selected book (${bookTitle}).
If user asks generally, answer naturally first.
If they ask for evidence, then use citations.
Use recent conversation context for follow-up references.
Recent conversation:
${recentConversation}
User message: ${questionText}`;
              const directText = await callClaudeText(directPrompt, 900, 0.4, orchestratorModelId);
              const final = directText || "Sure — I can help with summaries, character overviews, themes, quotes, and exact evidence from this book.";
              emitAnswer(final, { reason: "bypass_general_prompt", scope: "book", usedSpecialists: false });
              logChatEvent("specialist_bypass_general_prompt", { scope: "book", bookId, input: questionText.slice(0, 160) });
              controller.close();
              return;
            }

            const quotedText = extractQuotedText(questionText);
            const quoteMode = quotedText || (looksLikeQuoteLookup(questionText) ? questionText : null);
            if (looksLikeMainCharacterQuestion(questionText)) {
              const mains = deriveMainCharacters([bookId]);
              const lines: string[] = [];
              if (mains.length) {
                lines.push(
                  `Short answer: in **${bookTitle}**, I detect about **${mains.length} main characters** by repeated prominence in the text.`
                );
                lines.push("");
                lines.push("## Likely main characters");
                for (const m of mains) {
                  lines.push(`- **${m.name}** (mentions: ${m.mentions})`);
                }
                for (const m of mains.slice(0, 5)) {
                  const matches = searchBookKeyword(bookId, [m.name], 4);
                  for (const hit of matches) {
                    sources.push({
                      book: bookTitle,
                      excerpt: hit.snippet,
                      position: hit.label,
                    });
                  }
                }
              } else {
                lines.push("I couldn't confidently identify the main characters yet for this book.");
              }
              logChatEvent("main_character_answered", { scope: "book", bookId, count: mains.length });
              controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }
            if (mentionTarget) {
              // Multi-book phrasing ("first 10 books", "in the series") wins over single-book focus.
              if (seriesForMentionCount) {
                send(
                  "STATUS",
                  `Counting exact mentions of "${mentionTarget}" in series "${seriesForMentionCount.name}"...`
                );
                const counted = countMentionsInOrderedBooks({
                  seriesId: seriesForMentionCount.id,
                  keyword: mentionTarget,
                  countMode,
                  scope: bookCountScope,
                });
                const byBook = counted.rows.map(
                  (r) => [r.bookTitle, r.count] as [string, number]
                );
                sources.push(
                  ...collectMentionSources(
                    counted.rows.map((r) => r.bookId),
                    mentionTarget,
                    4
                  )
                );
                const text = formatExactMentionAnswer({
                  target: mentionTarget,
                  total: counted.total,
                  byBook,
                  scopeLabel: describeBookCountScope(
                    bookCountScope,
                    seriesForMentionCount.name
                  ),
                  countMode,
                  includedTitles:
                    bookCountScope.kind !== "all" ? counted.includedTitles : undefined,
                });
                logChatEvent("mention_count_answered", {
                  scope: "series",
                  seriesId: seriesForMentionCount.id,
                  mentionTarget,
                  total: counted.total,
                  bookCountScope,
                  booksCounted: counted.scopedBookCount,
                  exact: true,
                  redirectedFromBook: bookId,
                });
                emitAnswer(text, { reason: "exact_mention_count", scope: "series" });
                if (sources.length) send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }

              send("STATUS", `Counting exact mentions of "${mentionTarget}" in "${bookTitle}"...`);
              const total = countBookKeywordMentions(bookId, mentionTarget, countMode);
              const mentionMatches = searchBookKeyword(bookId, [mentionTarget], 40);
              for (const m of mentionMatches) {
                sources.push({
                  book: bookTitle,
                  excerpt: m.snippet,
                  position: m.label,
                });
              }
              const text = formatExactMentionAnswer({
                target: mentionTarget,
                total,
                byBook: total > 0 ? [[bookTitle, total]] : [],
                scopeLabel: `in **${bookTitle}**`,
                countMode,
              });
              logChatEvent("mention_count_answered", {
                scope: "book",
                bookId,
                mentionTarget,
                total,
                exact: true,
              });
              emitAnswer(text, { reason: "exact_mention_count", scope: "book" });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            if (forceExactCount) {
              emitAnswer("I can count mentions exactly — tell me the name to count.", {
                reason: "exact_count_mode_missing_target",
              });
              controller.close();
              return;
            }
            if (!quoteMode && !forceExactCount) {
              const libraryCmdBook = resolveLibraryCommand(
                lastUserMessage.content,
                questionText
              );
              if (libraryCmdBook) {
                await runLibraryCommand(libraryCmdBook);
                controller.close();
                return;
              }
              send("STATUS", `Consulting Librarian ${getLibrarianName(bookTitle)} for "${bookTitle}"...`);
              const specialistAnswer = await askBookSpecialist({
                bookId,
                bookTitle,
                userQuestion: questionText,
                modelId: specialistModelId,
              });
              logChatEvent("specialist_completed", {
                scope: "book",
                bookId,
                confidence: specialistAnswer.confidence,
                findings: specialistAnswer.findings.length,
              });
              for (const finding of specialistAnswer.findings.slice(0, 10)) {
                sources.push({
                  book: specialistAnswer.bookTitle,
                  excerpt: finding.evidence || finding.finding,
                  position: finding.location,
                });
              }
              send("STATUS", "Main AI is composing final answer...");
              send("SPECIALISTS", JSON.stringify(toSpecialistReports([specialistAnswer])));
              const personalityHint = buildPersonalityInstructions({
                language: aiSettings.language,
                tone: aiSettings.tone,
                focusAreas: aiSettings.focusAreas,
                customInstructions: aiSettings.customInstructions,
                answerMode,
                companionMode,
              });
              const finalText = await orchestrateSpecialists(
                questionText,
                [specialistAnswer],
                orchestratorModelId,
                personalityHint,
                { companionMode, onToken: emitToken, continuityHint }
              );
              logChatEvent("orchestrator_text_generated", {
                scope: "book",
                chars: finalText.length,
                thin: looksLikeThinAnswer(finalText),
              });
              logChatEvent("chat_answer_emitted", {
                bookId,
                chars: finalText.length,
                thin: looksLikeThinAnswer(finalText),
                reason: "orchestrated_specialists",
                scope: "book",
                usedSpecialists: true,
                streamed: true,
              });
              if (sources.length) send("SOURCES", JSON.stringify(sources));
              controller.close();
              return;
            }

            const relevantChunksPromise = queryBook(bookId, questionText, 20);
            if (quoteMode) {
              send("STATUS", "Running exact quote lookup in this book...");
              const exactMatches = searchExactQuoteInBook(bookId, quoteMode, 70);
              if (exactMatches.length > 0) {
                send("STATUS", `Exact quote matches found: ${exactMatches.length}`);
                const lines: string[] = [];
                lines.push(`## Exact Quote Matches in ${bookTitle}`);
                lines.push("");
                lines.push(`Found **${exactMatches.length}** matches.`);
                for (const m of exactMatches) {
                  lines.push(`- **${m.label}**: ${m.snippet}`);
                  sources.push({
                    book: bookTitle,
                    excerpt: m.snippet,
                    position: m.label,
                  });
                }
                controller.enqueue(encoder.encode(encodeStreamField("TEXT", lines.join("\n"))));
                send("SOURCES", JSON.stringify(sources));
                controller.close();
                return;
              }
              send("STATUS", "No exact quote matches found in this book");
            }

            send("STATUS", "Running keyword search for exact matches...");
            const queryWords = questionText
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 5);
            const [relevantChunks, keywordMatches] = await Promise.all([
              relevantChunksPromise,
              Promise.resolve(queryWords.length ? searchBookKeyword(bookId, queryWords, 300) : []),
            ]);

            const totalFound = relevantChunks.length + keywordMatches.length;
            if (totalFound) {
              send("STATUS", `Found ${relevantChunks.length} semantic + ${keywordMatches.length} keyword matches`);
            } else {
              send("STATUS", "No closely matching passages found — the AI will do its best");
            }

            let passageNum = 0;
            const contextParts: string[] = [];

            for (const passage of relevantChunks) {
              passageNum++;
              sources.push({
                book: bookTitle,
                excerpt: passage.text.slice(0, 200).replace(/\s+/g, " ").trim(),
                position: passage.location,
              });
              contextParts.push(`[Passage ${passageNum}, ${passage.location}]\n${passage.text}`);
            }

            for (const m of keywordMatches) {
              passageNum++;
              sources.push({
                book: bookTitle,
                excerpt: m.snippet,
                position: m.label,
              });
              contextParts.push(`[Passage ${passageNum}, ${m.label}]\n${m.snippet}`);
            }

            const context = contextParts.length
              ? contextParts.join("\n\n---\n\n")
              : "(No relevant passages found for this question.)";

            systemPrompt = `You are a close friend who knows "${bookTitle}" extremely well. Answer with care, warmth, and accuracy.

RULES YOU MUST FOLLOW:
1. EVERY claim you make MUST be backed by a specific passage. Cite inline like this: (Passage 3, Page X or Chapter Y). Always include the page/chapter location from the passage header. Never state something without a citation.
2. List ALL relevant findings from the passages — do NOT summarize or skip items. If the user asks "list all X", include every single match you find in the passages.
3. Clearly DISTINGUISH between what the text explicitly states vs. what you are inferring or interpreting. Use phrases like "The text states..." vs. "This suggests..." or "One could interpret this as..."
4. When multiple passages address the same topic, SYNTHESIZE them. Note if they reinforce, expand on, or contradict each other.
5. If the evidence is insufficient or ambiguous, say so explicitly. Never fill gaps with speculation presented as fact. If you suspect there may be MORE instances beyond the provided passages, say so.
6. Structure your response clearly: lead with a direct answer, then present the supporting evidence, then add any caveats or limitations.
7. Start with one plain-language sentence that sounds natural and directly answers the question.

${voicePreamble(companionMode)}

${RESPONSE_FORMATTING_RULES}

Sound like a friend who remembers the books — warm, clear, and honest about uncertainty.

Relevant passages from "${bookTitle}":

${context}`;
          }

          systemPrompt += `\n\nUSER PERSONALITY SETTINGS:\n${buildPersonalityInstructions({
            language: aiSettings.language,
            tone: aiSettings.tone,
            focusAreas: aiSettings.focusAreas,
            customInstructions: aiSettings.customInstructions,
            answerMode,
            companionMode,
          })}`;

          send("STATUS", `Building context from ${sources.length} passage${sources.length !== 1 ? "s" : ""} (${(systemPrompt.length / 1000).toFixed(1)}k characters)...`);

          const conversation = (aiSettings.useConversationMemory === false ? [lastUserMessage] : messages)
            .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
            .join("\n\n");
          const finalPrompt = `${systemPrompt}\n\nConversation so far:\n${conversation}`;

          send("STATUS", "Sending to Claude on Bedrock — reading passages and reasoning...");
          const streamStart = Date.now();
          let finalText = "";
          if (groundedMode) {
            // Need full text first for grounded gate — stream after check via buffered approach:
            finalText = await callClaudeText(finalPrompt, 2500, 0.2, orchestratorModelId);
            const hasCitation = /\(Passage\s+\d+/i.test(finalText) || /\bPage\s+\d+/i.test(finalText) || /\bChapter\s+\d+/i.test(finalText);
            if (!hasCitation || sources.length === 0) {
              finalText = "insufficient evidence";
              send("STATUS", "Grounded mode blocked unsupported answer.");
              emitToken(finalText);
            } else {
              emitToken(finalText);
            }
          } else {
            finalText = await callClaudeStream(
              finalPrompt,
              emitToken,
              2500,
              0.2,
              orchestratorModelId
            );
          }
          send(
            "WHY",
            JSON.stringify({
              groundedMode,
              sourceCount: sources.length,
              specialistModelId,
              orchestratorModelId,
            })
          );
          logChatEvent("chat_answer_completed", {
            bookId,
            groundedMode,
            sources: sources.length,
            answerChars: finalText.length,
          });
          const totalTime = ((Date.now() - streamStart) / 1000).toFixed(1);
          send("STATUS", `Done — response generated in ${totalTime}s`);

          if (sources.length) {
            send("SOURCES", JSON.stringify(sources));
          }

          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          const msg = error instanceof Error ? error.message : String(error);
          logChatEvent("chat_stream_error", { bookId, error: msg });
          if (/ExpiredToken|credentials|Unable to locate credentials|Forbidden|AccessDenied/i.test(msg)) {
            send(
              "ERROR",
              "Failed to generate response. AWS credentials or Bedrock permissions are invalid/expired. Run AWS login again and verify model access."
            );
          } else {
            send("ERROR", "Failed to generate response. " + msg);
          }
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Chat error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    logChatEvent("chat_request_error", { error: msg });

    return Response.json(
      { error: "Failed to generate response. " + msg },
      { status: 500 }
    );
  }
}
