# Roadmap

What is open after the 2026-11-12 review, restructuring and roadmap pass (see
[REVIEW-2026-11-12.md](REVIEW-2026-11-12.md) and the changelog). Ordered by value for
effort; move things as priorities change, and delete an item when it ships (the
changelog is the record).

## Next

1. **Judge the cheaper librarian model.** Haiku is in use and the eval's fact checks pass,
   but nobody has compared answers side by side. Save a live baseline
   (`npm run eval:chat -- --live --save-baseline`, about 50 calls), switch the librarians
   to Sonnet or the main model in Settings, run again and read the differences. Add text
   checks to the cases where the answers diverge.
2. **Entity graph, second pass.** Names are now found by evidence, but a place like
   "Thomson Corners" can still read as a person, and 1,085 names stay "unknown". Use the
   graph for more than main characters (who-is lookups, the scope chip), and consider one
   Haiku pass per book at ingest for the top 50 names.
3. **Installer on a clean machine.** The packaged app passes the smoke test here, where
   Node, AWS CLI and a library already exist. Install `dist/What About This Book Setup`
   on a machine without them and walk the first-run path (AWS profile dialog, empty
   library, first upload). Then cut a release: bump the version, rename Unreleased.

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

- Installer size: vectra brings 93 dependencies (an OpenAI client, cheerio, …) that the
  app never calls, on top of `sharp` and the full AWS SDK. Check what the server really
  loads, or replace vectra with a small local index.
- Code signing for the installer (Windows SmartScreen warns on unsigned builds).
- macOS / Linux packaging (config exists, never built).
- `PUBLIC_MODE` as a real read-only deployment (auth, rate limits) or remove it; the old
  `deploy.sh` was deleted because it targeted Ollama.
- Prompt caching: measured and skipped. The stable system text is 125–636 tokens, under
  the 1024-token minimum, and the passages change per question. Revisit only if prompts
  grow or a whole book is put in context.
