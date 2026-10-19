# Changelog

All notable changes to **What About This Book?** are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/).  
Versions follow [SemVer](https://semver.org/) when we cut releases.

> **How to use this with friends:** skim the **Why** bullets — that’s the story of the product, not just a file list.

---

## [Unreleased]

Work on `master` after `2f24d87` (desktop packaging, chat modularization, friend-voice UI, hygiene).

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
