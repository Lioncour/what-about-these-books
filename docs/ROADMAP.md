# Roadmap

What is open after the 2026-11-12 review, restructuring and roadmap pass (see
[REVIEW-2026-11-12.md](REVIEW-2026-11-12.md) and the changelog). Ordered by value for
effort; move things as priorities change, and delete an item when it ships (the
changelog is the record).

## Next

1. **Entity graph quality.** The eval showed "The / That / You" as main characters; they
   are filtered at read time now, but `knowledge-store.ts` still extracts noisy entities
   at ingest ("Kristang" as a character). Extract names with better rules (or one cheap
   Haiku pass per book at ingest) and rebuild the graph for existing books.
2. **Live eval as a habit.** `npm run eval:chat -- --live` works; add a saved baseline
   (cost and pass/fail per case) and print the difference, so a prompt or model change
   shows what it did. Then tune the first wave (3 books) and the librarian model
   (Haiku vs Sonnet) against answer quality, not just cost.
3. **Electron check.** Everything since the review was verified in the browser build.
   Launch the desktop app once (`npm run dev`), check the port pick, quit behaviour and
   the installer (`npm run dist`), and add an Electron smoke test to CI.

## Soon

4. **Token cost in currency** on the usage line and the settings page (needs a price
   table per model; Haiku and Opus now differ a lot, so tokens alone mislead).
5. **LLM router fallback.** When no heuristic in `intent.ts` fires with confidence, one
   small Haiku call could pick the route instead of defaulting to the librarians.
6. **Saved chats and the scope picker.** A chat remembers its pick; show it in Past
   notes ("3 picked books") and let a question be re-asked against a different scope.
7. **Upload**: the non-compact `UploadArea` variant is unused; remove it or use it for an
   empty library.

## Later

- macOS / Linux packaging (config exists, never built).
- `PUBLIC_MODE` as a real read-only deployment (auth, rate limits) or remove it; the old
  `deploy.sh` was deleted because it targeted Ollama.
- Prompt caching: measured and skipped. The stable system text is 125–636 tokens, under
  the 1024-token minimum, and the passages change per question. Revisit only if prompts
  grow or a whole book is put in context.
