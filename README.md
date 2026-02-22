# What About This Book?

A desktop app that lets you upload books and chat with AI about their contents. Runs 100% locally — no API keys, no internet, no costs.

## How It Works

1. Upload a book (PDF, EPUB, or TXT)
2. The app extracts text, chunks it, and builds a searchable index using AI embeddings
3. Ask questions — the app finds relevant passages and sends them to a local AI model
4. Get streaming answers that reference specific parts of the book

## Prerequisites

### Ollama

This app uses [Ollama](https://ollama.com/) to run AI models locally.

1. Install Ollama: `irm https://ollama.com/install.ps1 | iex` (Windows PowerShell)
2. Pull the models:

```bash
ollama pull llama3.1:8b
ollama pull nomic-embed-text
```

Make sure Ollama is running before launching the app.

## Getting Started

```bash
npm install
npm run electron:dev
```

This starts the Next.js server and opens the Electron desktop window.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js dev server only (browser at localhost:3000) |
| `npm run electron:dev` | Start Next.js + Electron window |
| `npm run build` | Build for production |
| `npm run electron:start` | Launch Electron (requires built Next.js) |

## Tech Stack

- [Electron](https://www.electronjs.org/) — Desktop window
- [Next.js](https://nextjs.org/) — Web framework (UI + API routes)
- [Tailwind CSS](https://tailwindcss.com/) — Styling
- [Ollama](https://ollama.com/) — Local AI (Llama 3.1 8B for chat, nomic-embed-text for embeddings)
- [Vectra](https://github.com/Stevenic/vectra) — Local vector store for book search
- [unpdf](https://github.com/unjs/unpdf) — PDF text extraction
- [epub2](https://github.com/nickhsharp/epub2) — EPUB text extraction

## Data Storage

All data is stored locally at `~/.whataboutthisbook/`:
- `books.json` — Book catalog (titles, metadata)
- `index/` — Vector embeddings for book search
