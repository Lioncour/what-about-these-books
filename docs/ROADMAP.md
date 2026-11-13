# Roadmap

What is open after the 2026-11-12 review, restructuring and roadmap pass (see
[REVIEW-2026-11-12.md](REVIEW-2026-11-12.md) and the changelog). Ordered by value for
effort; move things as priorities change, and delete an item when it ships (the
changelog is the record).

## Next

1. **Entity graph, second pass.** Names are now found by evidence, but a place like
   "Thomson Corners" can still read as a person, and 1,085 names stay "unknown". Use the
   graph for more than main characters (who-is lookups, the scope chip), and consider one
   Haiku pass per book at ingest for the top 50 names.
2. **Installer on a clean machine.** The packaged app passes the smoke test here, where
   Node, AWS CLI and a library already exist. Install `dist/What About This Book Setup`
   on a machine without them and walk the first-run path (AWS profile dialog, empty
   library, first upload). Then cut a release: bump the version, rename Unreleased.

## Soon

3. **LLM router fallback.** When no heuristic in `intent.ts` fires with confidence, one
   small Haiku call could pick the route instead of defaulting to the librarians.
4. **Re-ask against a different scope.** A saved chat shows and restores its scope; a
   button on an answer could ask the same question of other books ("check the rest").
   The answers now offer that in words.
5. **Check the price table.** `model-prices.ts` holds list prices as known in November
   2026. Compare once with the AWS bill and correct the table (or set
   `MODEL_PRICES_JSON`), especially for the EU inference profiles.

## Later

- Librarian model: measured 2026-11-13 (see the changelog). Haiku stays. Worth repeating
  only if answers start missing facts, or with text checks on more eval cases, since
  24 of 24 passing says little when most cases check routes and not content.
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
