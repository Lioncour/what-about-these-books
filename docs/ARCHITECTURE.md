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
SOURCES:[{…}]
SPECIALISTS:[{…}]
WHY:{…}
```

**Caveat friends always ask about:** Claude itself is **not** token-streamed yet. Bedrock `InvokeModel` returns a full answer. The “stream” is progress updates (`STATUS`) plus a safely encoded final answer (`TEXT`), so long Markdown with newlines doesn’t break the protocol.

Encoding lives in `src/lib/chat/stream-protocol.ts`.

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

Main file: `src/lib/chat/handler.ts`  
Route is a thin re-export: `src/app/api/chat/route.ts`.

### Why specialists + orchestrator?

Stuffing *every* book into one prompt doesn’t scale. Instead:

1. **Specialist** (`specialist.ts`) — one book, structured JSON findings + confidence  
2. **Orchestrator** (`orchestrator.ts`) — merges those notes into one answer in **friend voice**

That’s more Bedrock calls, but answers stay grounded per book and disagreements can surface (“Book A says X; Book B says Y”).

Caps / selection: `specialist-limits.ts`, `constants.ts`.  
Cache: `quality-store.ts` (so repeat questions aren’t full price every time).

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
| `page.tsx` | Shell: library sidebar + chat, settings, history |
| `BookLibrary.tsx` | Covers, series, manage/duplicates |
| `UploadArea.tsx` | Drag/drop queue + “Ask about this book” |
| `ChatMarkdown.tsx` | Assistant Markdown |
| `chat/MessageExtras.tsx` | Sources / specialist reports / why |
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
| **Loopback** | Normal desktop use stays on localhost. |
| **No user accounts** | It’s a personal library app, not multi-tenant SaaS. |
| **`PUBLIC_MODE=true`** | Hides upload / blocks some deletes & share admin — for demos. Incomplete for “secure public internet hosting”. |
| **Share links** | Token in local `ops/shares.json`; treat tokens like secrets. |
| **Don’t expose the port** | If you port-forward this API to the world, you’re giving strangers delete/backup powers. |

---

## Folder map (quick reference)

```
electron/main.js          # window + spawn Next + env
src/app/page.tsx          # main UI
src/app/api/*/route.ts    # HTTP surface
src/lib/book-store.ts     # catalog + Vectra + pages + chats
src/lib/bedrock-*.ts      # AWS clients
src/lib/chat/handler.ts   # chat brain
src/lib/chat/*.ts         # intent, specialists, stream, voice
src/components/*          # React pieces
scripts/*                 # packaging, eval, shortcuts
eval/gold-questions.json  # retrieval eval fixtures
```

---

## Extension points (if a friend wants to hack)

1. **New chat shortcut** — detector in `intent.ts` + branch in `handler.ts`  
2. **New library command** — `library-commands.ts`  
3. **Voice / formatting** — `response-formatting.ts`  
4. **Models** — settings UI → `modelRouting` → Bedrock IDs  
5. **Packaging** — `prepare-standalone.mjs` + `package.json` `build`  
6. **Eval** — `eval-harness.ts` + `npm run eval:harness` (retrieval today, not full chat)

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
