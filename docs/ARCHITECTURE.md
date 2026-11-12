# Architecture — What About This Book?

A friendly deep dive you can share: **what the app is**, **how the pieces fit**, and **why we made certain choices**.

If you only want the “how do I run it?” bits, see [README.md](../README.md).  
For “what changed when?”, see [CHANGELOG.md](../CHANGELOG.md).

---

## Elevator pitch

You upload books (PDF / EPUB / TXT). The app keeps them **on your machine**, builds a local search index, and lets you chat with **Claude on AWS Bedrock** as if it were a friend who has actually read those books.

Nothing book-shaped lives in a random cloud database we run. Your library stays under `~/.whataboutthisbook/`. AWS is only used for embeddings + Claude (and only with *your* SSO / credentials).

---

## Big picture

```
┌──────────────────────────────────────────────────────────────┐
│  Electron window  (the app you see)                          │
│  electron/main.js                                            │
└────────────────────────────┬─────────────────────────────────┘
                             │ opens http://127.0.0.1:3000
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Next.js (UI + API)                                          │
│  src/app/page.tsx  →  /api/*  →  src/lib/*                   │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐    ┌─────────────────────────────┐
│  AWS Bedrock              │    │  Your disk                  │
│  Claude (answers)         │    │  ~/.whataboutthisbook       │
│  Titan (embeddings)       │    │  books, vectors, chats…     │
└───────────────────────────┘    └─────────────────────────────┘
```

**Mental model:** Electron is the picture frame. Next.js is the brain and the doorbell (APIs). Bedrock is the borrowed genius. The home folder is the bookshelf.

---

## Why Electron + Next.js?

| Choice | Why |
|--------|-----|
| **Desktop-first (Electron)** | Feels like a real app, not a tab. Easy “drop a book on the window”. Single-instance lock so you don’t accidentally open two servers fighting over port 3000. |
| **Next.js for UI *and* API** | One TypeScript codebase for React UI and local HTTP routes. No separate Express server to keep in sync. |
| **Bind to `127.0.0.1` only** | The API is powerful (delete library, restore backups). Loopback-only reduces “something else on your LAN can hit it” risk. |
| **Standalone packaging** | Production builds ship Next’s `standalone` server inside the installer so users don’t need a global Node install. |

Dev: `npm run dev` → Electron spawns `next dev`.  
Prod: build standalone → Electron runs `resources/standalone/server.js`.

---

## Why AWS Bedrock (and SSO)?

We wanted **Claude-quality** answers without shipping book text to a third-party chat SaaS we don’t control as tightly — Bedrock runs in *your* AWS account / org.

- **Claude** → reading, synthesis, “friend who knows the books” voice  
- **Titan embeddings** → turn passages into vectors for similarity search  
- **SSO (`AWS_PROFILE`)** → matches how many workplaces already grant Bedrock access  

The app **proactively** runs `aws sso login` when credentials are missing/expired (`src/lib/bedrock-client.ts`), and the UI shows an AWS badge so you’re not guessing why chat failed.

---

## Where your data lives

Default root: **`~/.whataboutthisbook/`** (override with `DATA_DIR`).

| Path | Role |
|------|------|
| `.env` | Profile, region, model IDs, `PUBLIC_MODE` |
| `books.json` | Catalog of books + series |
| `settings.json` | Tone, language, grounded mode, model routing |
| `index/` | Vectra vector store (semantic search) |
| `texts/<bookId>.json` | Page/chapter text for keyword / quote / counts |
| `covers/` | Cover images |
| `specialists/` | Per-book “librarian memory” profiles |
| `chats/` | Saved conversations |
| `knowledge/` | Entity graph + timeline heuristics |
| `quality/` | Specialist cache + scorecards |
| `ops/` | Shares, workspace notes, reindex state |
| `backups/` | Snapshots |
| `logs/chat.log` | Debug trail (what the pipeline did) |

All JSON stores are written atomically (`writeJsonAtomic` in `runtime-config.ts`: temp file + rename), `books.json` keeps a `.bak`, and index updates are serialised (`withIndexLock` in `store/vector-index.ts`). `src/lib/book-store.ts` is only a barrel; the code lives in `src/lib/store/*` (catalog, pages, search, series, vector-index, chats, labels, tidy…).

### Dual retrieval (important!)

1. **Semantic (Vectra + Titan)** — “what’s this about?”, themes, vague questions  
2. **Exact text on disk** — “how many times is X mentioned?”, “find this quote”

Vectors are great at *meaning*. They’re mediocre at *counting*. So we keep both.

---

## Chat architecture (the interesting part)

### What the UI thinks is “streaming”

When you hit Send, the UI opens `POST /api/chat` and reads a **line protocol**:

```
STATUS:"Flipping through…"
TEXT:"Here's what I found…\n\n## Evidence\n…"
TOKEN:"Here's "
SOURCES:[{…}]
SCOPE:{"books":[{"id":"book-…","title":"Columbus Day"}],"reason":"named"}
USAGE:{"claudeCalls":2,"inputTokens":10500,"outputTokens":1200,"embedCalls":1,"ms":12000}
```

`SCOPE` says which books the answer is drawn from and why (`named`, `focus`, `series`, `semantic`, `all`); it goes out before the first Bedrock call so the reader sees early that the right book is being read. `USAGE` is the last line of every completed stream: this request's calls and tokens, collected through an `AsyncLocalStorage` request context (`chat/request-context.ts`) that also carries the abort signal down to Titan embeddings. The UI shows both under each answer.

Final answers are token-streamed (`TOKEN`) from Bedrock; deterministic answers (counts, quotes) arrive as one `TEXT`.

Encoding lives in `src/lib/chat/stream-protocol.ts`.

### Scope by named book

Before anything is embedded, `findNamedBooksInQuestion` (`specialist-limits.ts`) looks for catalog titles (or "book 3" of a series named in the question). Named books are read first and, when exactly one is named, alone; exact mention counts scope the same way. This is what keeps "In Columbus Day, …" from being answered by books 2–7.

### Choosing the scope before sending

The composer shows a scope chip (`components/chat/ScopeChip.tsx`, `hooks/useScopePreview.ts`). With a focus book or hand-picked books the scope is known in the browser; otherwise the chip asks `POST /api/chat/scope` (debounced, catalog only) whether the question names a book. Picking two or more books sends `bookIds` with the question, and `buildScope` returns a picked scope: the library scope narrowed to exactly those books, for every step.

### Pipeline overview

```
Question
  │
  ├─ Library command?  ("list my books", "@remove all books@")
  │     └─ mutate disk, maybe LIBRARY_CHANGED
  │
  ├─ Fast heuristics (intent.ts)
  │     counts · who-is · quotes · have-you-read · small-talk bypass
  │
  ├─ Multi-book path: SPECIALISTS
  │     pick up to N books → each gets a Claude JSON "librarian"
  │     → ORCHESTRATOR merges into one friendly answer
  │
  └─ Fallback RAG
        pull passages → one Claude call with citations + friend voice
```

`src/lib/chat/handler.ts` is a thin composition: it validates, builds a `Scope` (`scope.ts`: one object for library / series / single book with `semantic`, `keyword`, `exactQuote`, `countMentions`, `selectSpecialistBooks`) and runs the `PIPELINE` array of steps in `src/lib/chat/steps/*` (library-command, mention-count, passage-find, theme-survey, knowledge, catalog-facts, who-is, small-talk, main-characters, specialists, quote-lookup, rag). Each step either answers and ends the stream or passes. `tests/chat-handler.test.ts` drives the real handler with mocked stores and Bedrock and pins every route in every scope.
Route is a thin re-export: `src/app/api/chat/route.ts`.

### Why specialists + orchestrator?

Stuffing *every* book into one prompt doesn’t scale. Instead:

1. **Specialist** (`specialist.ts`) — one book, structured JSON findings + confidence  
2. **Orchestrator** (`orchestrator.ts`) — merges those notes into one answer in **friend voice**

That’s more Bedrock calls, but answers stay grounded per book and disagreements can surface (“Book A says X; Book B says Y”).

Caps / selection: `specialist-limits.ts`, `constants.ts`.  
Cache: `quality-store.ts` (so repeat questions aren’t full price every time).

An open library question doesn't ask all six selected books at once: the three closest go first (`FIRST_WAVE_SPECIALIST_BOOKS`), and `steps/specialists.ts` reads the rest only when those come back thin. Breadth questions, a series in focus, named and hand-picked books skip this.

### Which model answers

The librarians do extraction to JSON and are most of the tokens, so they run on a cheaper model than the final answer. `src/lib/model-routing.ts` (pure: region prefix, candidates, error classification) and `chat/specialist-model.ts` (the call-and-fallback loop) try Haiku 4.5, then Sonnet 4.5, then the main model; what the account can't call is remembered in `ops/model-routing.json` for a week. A model fixed in Settings → Advanced is used as is. The orchestrator, RAG and single-call answers use the main model. At most `MAX_SPECIALIST_CALLS_PER_REQUEST` (8) librarian calls are made per question.

### Why “friend voice”?

Product goal: not a sterile research bot — a **friend who knows the books extremely well**.

Shared copy lives in `response-formatting.ts` (`FRIEND_VOICE`, personality settings).  
Orchestrator + RAG prompts use it. Short factual one-liners can be softened; **structured evidence (headings, lists, tables) is preserved** so we don’t accidentally squash a good count breakdown into three vague sentences.

### Intent heuristics instead of an LLM router

Regex / pattern detectors in `intent.ts` catch:

- mention counts  
- quote lookup  
- main characters  
- “have you read…?”  
- library management  

**Why:** instant, cheap, predictable.  
**Tradeoff:** phrasing matters; we tighten detectors when we find false positives (e.g. bare “which book” no longer forces quote mode).

---

## Ingest path (upload → searchable)

1. UI `UploadArea` → `POST /api/extract` (progress stream)  
2. Parse PDF (`unpdf`) / EPUB (`epub2`) / TXT  
3. Store page map under `texts/`  
4. Chunk + embed into Vectra `index/`  
5. Optional cover, series guess (`series-detection.ts`)  
6. Build specialist profile + knowledge graph hooks  

Re-index without re-upload: `reindex-manager.ts` + `/api/reindex`.

---

## UI shape

| Piece | Role |
|-------|------|
| `page.tsx` | Thin shell composing the hooks and components below |
| `hooks/useChatStream.ts` | Send, abort, decode the line protocol |
| `hooks/useChatHistory.ts`, `useLibrary.ts`, `useLibraryRail.ts` | Saved chats, books/series/focus, rail width |
| `chat/MessageList.tsx`, `Composer.tsx`, `WelcomePanel.tsx`, `ChatHeader.tsx` | The conversation column |
| `library/TidyTitles.tsx` | Manage → “Tidy titles & chapters” (dry run, confirm, backup, apply) |
| `settings/*Section.tsx` | Settings page sections |
| `BookLibrary.tsx` + `hooks/useBookShelf.ts` + `library/*` | Shelves: `BookCard`, `SeriesHeader`, `ManageBar`, `EditBookDialog`, `LibraryDialogs` (every confirm/prompt is in-app) |
| `UploadArea.tsx` + `hooks/useUploadQueue.ts` + `upload/*` | Drag/drop queue + “Ask about this book” |
| `chat/ScopeChip.tsx` + `hooks/useAskScope.ts`, `useScopePreview.ts`, `chat/scope.ts` | What the next question is asked against: library, focus book, series, picked books; saved with the chat |
| `ConfirmDialog.tsx` | Confirm / notice dialog (`tone="danger"` for destructive actions) |
| `ChatMarkdown.tsx` | Assistant Markdown |
| `chat/MessageExtras.tsx` | Sources, scope line, usage line |
| `chat/AskDialog.tsx` | In-app prompts (no ugly `window.prompt`) |
| `AwsStatusBadge.tsx` | Bedrock login health |

**Design language:** warm dark canvas, coral accent (Claude-adjacent), Fraunces + Figtree — “calm desktop companion”, not purple SaaS dashboard.

**UX choices worth explaining:**

- **Chat-first layout** — narrow library (~340px), wide conversation  
- **Soft book focus** — picking a book sets context without wiping the chat  
- **Stop** — AbortController cancels the HTTP stream (stops waiting; server work may still finish)  
- **Citations** — expandable sources; specialist details behind a quiet disclosure  

---

## Security & modes (honest version)

| Topic | Reality |
|-------|---------|
| **Loopback** | Normal desktop use stays on localhost. `src/proxy.ts` rejects mutating `/api/*` requests whose `Origin` isn't our own (or `Sec-Fetch-Site: cross-site`), so a web page open in your browser can't drive the API. Ids are validated before any path is built. |
| **No user accounts** | It’s a personal library app, not multi-tenant SaaS. |
| **`PUBLIC_MODE=true`** | Hides upload / blocks some deletes & share admin — for demos. Incomplete for “secure public internet hosting”. |
| **Share links** | Token in local `ops/shares.json`; treat tokens like secrets. |
| **Don’t expose the port** | If you port-forward this API to the world, you’re giving strangers delete/backup powers. |

---

## Folder map (quick reference)

```
electron/main.js          # window + spawn Next + env
src/app/page.tsx          # thin UI shell
src/hooks/*               # chat stream, history, library
src/components/*          # React pieces
src/app/api/*/route.ts    # HTTP surface
src/proxy.ts              # same-origin guard for /api/*
src/lib/store/*           # catalog, pages, search, series, Vectra, chats, labels, tidy
src/lib/book-store.ts     # barrel over store/*
src/lib/bedrock-*.ts      # AWS clients
src/lib/chat/handler.ts   # pipeline composition
src/lib/chat/scope.ts     # library / series / book scope
src/lib/chat/steps/*      # one file per answer route
src/lib/chat/*.ts         # intent, specialists, stream, voice
tests/*                   # vitest: handler routes, stores, titles, labels, UI formatters
scripts/*                 # packaging, eval, shortcuts
eval/gold-questions.json  # retrieval eval fixtures
```

---

## Extension points (if a friend wants to hack)

1. **New chat shortcut** — detector in `intent.ts` + a step in `chat/steps/` added to `PIPELINE` in `handler.ts` + a case in `tests/chat-handler.test.ts`  
2. **New library command** — `library-commands.ts`  
3. **Voice / formatting** — `response-formatting.ts`  
4. **Models** — settings UI → `modelRouting` → Bedrock IDs  
5. **Packaging** — `prepare-standalone.mjs` + `package.json` `build`  
6. **Eval** — `npm run eval:chat` (`src/lib/chat-eval.ts`, cases in `eval/chat-cases.json`) runs gold questions through the real pipeline in-process: dry by default (Claude calls counted via the request context's `dryRun`, not made), `--live` for real answers. Add a case whenever a routing or scope bug is fixed. `npm run eval:harness` is the older retrieval-only check.

---

## Design principles we try to keep

1. **Books stay local.** Cloud is for inference, not the bookshelf.  
2. **Be honest about uncertainty.** Cite, caveat, don’t invent plot.  
3. **Feel like a friend, not a ticket bot.** Warm voice, calm UI.  
4. **Prefer deterministic shortcuts for precise tasks** (counts, quotes).  
5. **Progress over silence.** Long Bedrock calls should show STATUS steps.  
6. **Explain why.** This doc + CHANGELOG exist so decisions don’t live only in chat history.

---

## Related docs

- [README.md](../README.md) — run / install  
- [CHANGELOG.md](../CHANGELOG.md) — history and rationale by release  
