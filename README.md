# What About This Book?

A desktop app that lets you upload books and chat with AI about their contents using **AWS Bedrock** (Claude + Titan embeddings).

> Think of it as a **friend who knows your books extremely well** — your library stays on disk; Bedrock only does the reading/thinking.

## Docs worth reading

| Doc | What’s in it |
|-----|----------------|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Deep dive: how Electron → Next → Bedrock → `~/.whataboutthisbook` fit together, and **why** |
| **[CHANGELOG.md](CHANGELOG.md)** | What changed over time (good for explaining the project to friends) |

## How It Works

1. Upload a book (PDF, EPUB, or TXT)
2. The app extracts text, chunks it, and builds a searchable index using Bedrock embeddings
3. Ask questions — the app finds relevant passages and sends them to Claude on Bedrock
4. Get answers with citations, progress steps, and optional specialist/orchestrator routing

## Prerequisites

- **AWS CLI** with SSO (or other credentials the SDK can use)
- **Bedrock access** for your Claude model + Titan embedding model in your region
- Copy `.env.example` to `.env` and set `AWS_PROFILE` / `AWS_REGION`

The app proactively runs `aws sso login` when credentials are missing or expired (chat, upload, indexing).

## Getting Started

This is a **desktop app** (Electron). You do not need to open a browser.

```bash
npm install
cp .env.example .env   # edit AWS_PROFILE
npm run dev
```

That launches a standalone window. The Next.js server runs locally in the background (not meant for browser use).

Optional: `npm run dev:web` opens the same UI at http://localhost:3000 in a browser (for debugging only).

### Install on Windows (desktop shortcut + Start menu)

Build the installer once:

```bash
npm run dist
```

Open `dist/` and run **`What About This Book Setup x.x.x.exe`**. The installer can create a **desktop shortcut** and Start menu entry.

After building, you can also point a shortcut at the unpacked app without installing:

```bash
npm run dist:setup   # copies .env to %USERPROFILE%\.whataboutthisbook\ and adds a Desktop shortcut to win-unpacked
```

On first launch, edit `%USERPROFILE%\.whataboutthisbook\.env` (created automatically) and set `AWS_PROFILE`, then run `aws sso login` once.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Desktop app (dev) — **use this** |
| `npm run dev:web` | Browser-only dev server (optional) |
| `npm run build` | Production build (required before `npm start`) |
| `npm run start` | Desktop app (production build) |
| `npm run dist` | Build Windows `.exe` installer |
| `npm run dist:setup` | User `.env` + Desktop shortcut (unpacked build) |
| `npm run electron:build` | Alias for `dist` |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run eval:harness` | Retrieval quality eval (`eval/gold-questions.json`) |

## Tech Stack

- **Electron** — Standalone desktop window (primary UI)
- **Next.js** — UI + API routes
- **AWS Bedrock** — Claude + Titan embeddings
- **Vectra** — Local vector store
- **unpdf / epub2** — Text extraction

## Architecture (high level)

```
Electron → Next.js (UI + /api) → Bedrock (Claude + Titan)
                              ↘ ~/.whataboutthisbook (books, vectors, chats)
```

Chat brain lives in `src/lib/chat/` (intent → specialists → orchestrator → stream).  
Full walkthrough: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Major Features

- Specialist + orchestrator model routing
- Grounded answer mode, quality scorecards, specialist cache
- Entity graph, timeline checks, re-index manager
- Share links (with expiry), backup/safety tools, workspace notes
- AWS status badge, Stop on long answers, soft book focus
- Friend-voice answers with citations

## Data Storage

Local data under `~/.whataboutthisbook/` (override with `DATA_DIR`):

- `books.json` — catalog
- `index/` — vectors
- `texts/`, `covers/`, `specialists/`, `chats/`, `knowledge/`, `ops/`

## Public mode

Set `PUBLIC_MODE=true` to disable uploads/deletes and restrict share link administration.
