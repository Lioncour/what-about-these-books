# Changelog

All notable changes to **What About This Book?** are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/).  
Versions follow [SemVer](https://semver.org/) when we cut releases.

> **How to use this with friends:** skim the **Why** bullets — that’s the story of the product, not just a file list.

---

## [Unreleased]

Work on `master` after `2f24d87` (desktop packaging, chat modularization, friend-voice UI, hygiene).

### Changed — librarians on a cheaper model, and the rest of the roadmap

- **Librarians run on Haiku automatically.** With no model set, the librarian calls try
  Haiku 4.5, then Sonnet 4.5 (same region prefix as the main model), then the main model;
  a model the account can't call is remembered for a week (`ops/model-routing.json`).
  Auth and network errors never mark a model unusable. The orchestrator and single-call
  answers stay on the main model. Settings → Advanced shows what is in use, with
  "Auto", "Use main model for everything", a custom id and "Re-check".
  `BEDROCK_SPECIALIST_MODEL_IDS` overrides the candidates. Live: an open question is
  3 Haiku calls (~15k tokens) plus one Opus call (~1k), where it was 7 Opus calls.
- **At most 8 librarian calls per question.** Thinness is judged on the first answers,
  the second wave is read, and only then do still-empty librarians ask again.
- **Status line names the books**: "Reading Black Ops, Valkyrie and Gateway…".
- **Recipe card is general**: no dish names in the code; an ingredient list is shown only
  when the passage really lists items.
- **Follow-up counts** ("and Joe?") are routed as counts and count where the previous one
  did.
- **Main characters** no longer include sentence starters ("The", "That", "You").
- **Edit a book** in Manage: title, author, replace cover (`PATCH /api/books`,
  `POST /api/covers/<id>`; images checked by content, 5 MB max; duplicate titles refused).
- **No more browser dialogs**: every confirm, prompt and alert is an in-app dialog that
  names what it will do; destructive ones have a danger button.
- **Scope picker**: ticking exactly one whole series asks it as a series (reading order,
  "first N books"); more than six picked books says the librarians read the first six;
  a saved chat remembers and restores its scope.
- **UI split**: `BookLibrary.tsx` 575 → 181 and `UploadArea.tsx` 526 → 146 lines.
- **Eval**: multi-turn cases (`history`), 24 cases; the script prints a hint and exits 0
  when no server is running.
- Fixed: the settings page showed stale token usage (each route kept its own in-memory
  copy); the question field could start at its maximum height.
- Prompt caching was measured and not added: the stable system text is 125–636 tokens,
  under the 1024-token minimum.
- 339 tests.

### Changed — fewer Claude calls for the same answers

- **Open questions ask the three closest books first.** The other three of the selection
  are read only when those come back thin (no findings, or every librarian unsure); the
  scope line then updates. Questions that ask for breadth ("compare", "across all the
  books", "the series") still ask all six at once; a series in focus, a named book and
  hand-picked books are never narrowed. Live on the real library: "What does Skippy think
  of humans?" is 4 calls / 17k tokens in, where an open question was 7 calls.
- **"Which books mention X?" is an exact lookup**, not seven Claude calls: the books with
  counts, and the ones that don't mention it ("Mars is mentioned in 8 of 18 books…").
  Also "In which books is X mentioned?" and "Does any book mention X?". Thematic wording
  ("talk about") still goes to the librarians.
- Eval: 18 cases, including one for each of the above.

### Added — chat eval

- `npm run eval:chat` runs the gold questions in `eval/chat-cases.json` through the real
  pipeline and checks the route taken, the books read, the number of Claude calls, the
  sources and (where the answer is real) what it says. Each case carries a note saying
  which bug or behaviour it pins.
- **Dry by default**: Claude calls are counted, not made, so routes, scope and every exact
  answer are checked in seconds for the price of a few embeddings. `-- --live` makes the
  calls and applies the text checks too; `-- id1 id2` runs single cases; `--json` prints
  the full report. Dry runs never write the specialist cache or scorecards.
- First run on the real library: 16/16, and it showed "Who is Joe in love with?" being
  answered as a plain "who is Joe" lookup. Fixed: only a place may follow the name.

### Added — choose what a question is asked against

- **Scope chip above the question field**: "Asking the whole library · 18 books",
  "Asking Paradise · named in your question" (updates as you type; catalog lookup only, no
  AI call), "Asking 2 books: Columbus Day, Paradise · picked by you".
- **Book picker** on the chip: tick books (or a whole series), filter by title. Nothing ticked
  is the whole library, one book is a focus book, two or more are read together and nothing
  else is: searches, exact counts, quotes and librarians all stay inside the pick.
- Server: `bookIds` on `POST /api/chat` builds a picked `Scope`; `POST /api/chat/scope`
  previews the scope; SCOPE reason `picked`.

### Fixed — citations survive a retitle or relabel

- The passage reader finds a citation by **the book's id, then the cited words, then the
  label** (`chat/passage-lookup.ts`). Saved chats from before Tidy carry the old flow label
  ("Chapter 12") and the old long title; the words still land on "Chapter 10 · Skippy".
  "Chapter 1" no longer matches "Chapter 10".
- The reader highlights the cited words and scrolls to them; when they can't be found word
  for word it says so instead of silently showing the start of the book.
- Every source sent to the UI carries `bookId`.
- Picking a conversation closes the Past notes drawer.

### Changed — 2026-11-12 restructuring and cleanup

- **Chat handler rebuilt** around a `Scope` and a step pipeline: `handler.ts` 1682 → 164 lines,
  one file per answer route in `src/lib/chat/steps/`. Characterization tests were written
  against the old handler first; three behaviours were unified on purpose (a book named inside
  a focused series is read alone; count follow-ups honour a named book; an exact-quote hit
  costs no embedding).
- **Every answer shows where it came from and what it cost**: `SCOPE` and `USAGE` stream lines,
  rendered as "Read from Columbus Day · named in your question" and
  "2 calls · 10.5k tokens in · 1.2k out · 12 s" (or "No AI calls · exact text search").
- **Stop reaches the embeddings too** (abort signal carried in a request context).
- **`book-store.ts` split** into `src/lib/store/*` behind the same barrel; results carry `bookId`
  so a renamed title can't break lookups; phrase counts match across line breaks.
- **Chapter labels come from the chapter's own heading** ("Chapter 10 · Skippy") instead of
  the position in the EPUB flow, which counted front matter.
- **Tidy titles & chapters** (Manage): dry run, confirmation, backup, then clean titles and
  relabel chapters for books already in the library. Title cleaning handles truncated
  filenames ("Failure Mode (Expeditionary For Craig Alanson" → "Failure Mode") and no longer
  has series-specific regexes.
- **UI split**: `page.tsx` 1196 → 219 lines and the settings page 611 → 92, into hooks and
  components; autosave once per answer instead of per token; dead specialist/why panels removed.
- **Repo cleanup**: removed the one-off `scripts/split-chat.mjs`, the stale Ollama-era
  `deploy.sh`, duplicate npm scripts, unused `concurrently`/`wait-on`; the installer icon now
  comes from the tracked `public/icon.png` (the old `build/` copy was git-ignored).
- **Tests**: 172 (handler routes in every scope, stores against a temp data dir, heading
  parser, title cleaning, UI formatters).

### Fixed — 2026-11-12 review pass

Full list with file references in `docs/REVIEW-2026-11-12.md`.

- **A book named in the question is the book that gets read.** Specialists and exact counts
  scope to titles (or "book 3" of a named series) found in the question; the STATUS line says so.
  "In Columbus Day, how does Joe first meet Skippy?" went from 7 Claude calls / ~140k input
  tokens reading books 2–7 to 2 calls / ~10k tokens reading Columbus Day.
- **Local API hardened**: same-origin check on every mutating `/api/*` request (`src/proxy.ts`),
  `bookId`/`chatId`/`seriesId`/`backupId` validated before any path join, `restoreBackup` only
  accepts listed backups, PUBLIC_MODE blocks every mutating route.
- **Data safety**: atomic JSON writes everywhere (`writeJsonAtomic`), `books.json.bak` fallback,
  ingest writes text before index/catalog and rolls back on failure, index updates serialised,
  stale reindex state detected, Vectra cache dropped after restore, series reconcile no longer
  overwrites books added meanwhile, `deleteBook` cascades to knowledge/quality/shares/chats.
- **Chat pipeline**: Stop aborts Bedrock calls; streaming auth retry no longer duplicates output;
  one SSO login at a time, none when offline; specialist cache keeps findings and keys by model
  and index generation; re-ask only when a book had nothing; question embedded once per request;
  keyword sweep limited to 6 real keywords / 40 snippets with whole-word matching; system prompt
  in the Messages `system` field; ERROR lines encoded like TEXT; stream closed properly.
- **Heuristics**: "they" no longer reads as "hey"; short plot questions go to the books, not
  model memory; "who is Joe in love with?" → Joe; "which books mention X" is not a library
  count; "appear nervous" is not a count; "the Elders" keeps its article; quotes only force
  exact-quote mode when asked for.
- **UI**: suggested questions send on click; sources collapse repeats (×N) and show a snippet;
  librarian names unique per book; new books get clean titles (EPUB metadata, else filename
  minus author/format/series tails).
- **Electron**: free-port pick (3000–3010), whole process tree killed on quit, startup errors
  shown in a dialog with the server's stderr tail.
- **Tooling**: vitest (`npm test`), CI runs typecheck + lint + test + build on Node 22,
  `@types/node` 22, `postdist` removed.

### Added

- **Architecture guide** — `docs/ARCHITECTURE.md` for “how it works / why”.
- **This changelog** — so decisions aren’t trapped in Slack or chat logs.
- **Settings page** — `/settings` with Companion vs **Raw answers** mode (turns off welcome, friend voice, presence fluff).
- **Series grouping fix** — Open Library lookup (`series:` subjects) + smarter local heuristics so “Book 6/7/14” folders merge; Manage → **Fix series grouping**.
- **True token streaming** — Bedrock `InvokeModelWithResponseStream` → `TOKEN` events in the chat UI.
- **Resizable / collapsible library** — drag handle; `]` / `[` to hide/show; width persisted.
- **Human welcome** — companion empty state uses your real library titles.
- **“Remembering with you” presence** — STATUS lines mapped to warm copy when companion mode is on.
- **CI workflow** — typecheck + lint.
- **AWS status badge**, chat module split, Ask dialogs, Stop generation, upload→ask CTA.
- **Pink accent** dark UI (Fraunces + Figtree).

### Changed

- Less power-user chrome: settings moved to a page; retries/WHY/specialist panels out of the main chat; recent chats collapsed by default.
- Soft book focus, safer multiline/`TOKEN` stream protocol, personality on specialist path.
- Quote intent tightened; structured answers no longer flattened by naturalizer.

### Why (this batch)

| Decision | Why |
|----------|-----|
| Companion vs Raw toggle | Same brain, two social modes — friends get warmth; power users get receipts. |
| Token streaming | Waiting for a full dump felt broken next to Claude.ai. |
| Collapsible library + `]` | Immersion when you’re deep in a conversation. |
| Pink accent | Softer, less “enterprise coral”; still dark and calm. |

---

## [0.1.0] — 2026-04-29

Git tag equivalent: commit `2f24d87` — *Improve Claude-first chat flow and reliability across book Q&A.*

### Added

- Specialist → orchestrator multi-book reasoning.
- Library commands from chat (list / remove / reindex patterns).
- Grounded mode, answer modes, conversation memory toggles.
- Entity graph / timeline / character / contradiction knowledge endpoints.
- Quality scorecards + specialist answer cache.
- Share links, backup/safety tools, reindex manager.
- Retrieval eval harness (`eval/gold-questions.json`, `npm run eval:harness`).

### Changed

- Chat flow centered on Claude via Bedrock with clearer STATUS progress.
- Stronger reliability around credentials and long-running answers.

### Why

Multi-book questions (“compare X across my series”) don’t fit one context window cleanly. Per-book specialists plus a merger was the scalable pattern. Deterministic shortcuts (counts, quotes) stayed outside the LLM when precision mattered.

---

## [0.0.2] — 2026-02-22

Commit `7c8797c` — *Add source citations to AI responses.*

### Added

- Source / citation payloads with assistant answers.
- UI affordances to inspect which passages backed a claim.

### Why

Without citations, a fluent model is just a confident roommate. Citations make the app a research companion you can verify.

---

## [0.0.1] — 2026-02-22

Commits `450c7b0` → `a560fd1` — Create Next App → *What About These Books* companion.

### Added

- Initial Next.js app scaffold.
- Core idea: upload books, extract text, embed, ask questions via Bedrock.
- Local catalog + vector index foundations.

### Why

Start from a familiar full-stack React framework, keep the library on disk, and use Bedrock for the heavy linguistic lifting. The Electron shell and denser “friend” UX came later once the brain worked.

---

## Version map (git → story)

| Approx version | Commit | Story |
|----------------|--------|--------|
| 0.0.1 | `a560fd1` | “It exists” — upload & ask |
| 0.0.2 | `7c8797c` | “Prove it” — citations |
| 0.1.0 | `2f24d87` | “Think across books” — specialists / reliability |
| Unreleased | working tree | “Feel like a friend” — desktop polish, voice, protocol, docs |

---

## Maintenance notes

When you ship a meaningful change:

1. Add a section under **Unreleased** (Added / Changed / Fixed / **Why**).  
2. When cutting a release, rename Unreleased → `[x.y.z] — YYYY-MM-DD` and bump `package.json` `version`.  
3. If the change is architectural, add a short pointer in `docs/ARCHITECTURE.md`.
