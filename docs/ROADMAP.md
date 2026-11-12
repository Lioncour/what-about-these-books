# Roadmap

What is open after the 2026-11-12 review and restructuring (see
[REVIEW-2026-11-12.md](REVIEW-2026-11-12.md) and the changelog). Ordered by value for
effort; move things as priorities change, and delete an item when it ships (the
changelog is the record).

## Next

1. **Cheaper model for specialists.** Every call runs on Opus today. Specialists do
   extraction to JSON and are the bulk of the tokens; Sonnet or Haiku there, Opus only
   for the orchestrator, would cut cost and latency several-fold. `modelRouting` and the
   Advanced setting exist. Needs: which Bedrock model ids the AWS account can invoke
   (owner has to check), then a default plus a fallback to the main model on
   AccessDenied.
2. **"Which books mention X?" without Claude.** The eval shows it goes to six librarians
   plus the orchestrator (7 calls). It is a per-book exact count; answer it from the
   stored text like the other counts.
3. **Open questions cost 7 calls.** Any question that names no book asks six librarians.
   Besides the cheaper model (item 1): ask only the two or three closest books first and
   widen when they come back thin.

## Soon

4. **Replace the remaining `window.confirm` / `prompt` / `alert`** (chat delete, book
   and series delete, series prompts) with `ConfirmDialog` / `AskDialog`.
5. **Split `BookLibrary.tsx` (575) and `UploadArea.tsx` (526)** the way `page.tsx` was.
6. **Prompt caching.** The stable rules/voice block is now in the `system` field; add
   `cache_control` so repeated questions in a session reuse it.
7. **Edit a book's title, author and cover in Manage** (Tidy covers the automatic part).
8. **Presence copy**: "Reading along in Librarian A, …...…" punctuation; say the book
   names instead of librarian names.
9. **Recipe card** in `passage-find.ts` is burger-specific; either generalise or drop.

## Later

- Eval follow-ups: multi-turn cases (count follow-ups like "and Joe?"), a `--live` run
  that compares cost against the previous run, cases for the series scope.
- Scope picker follow-ups: tick a whole series as a series scope (keeps reading order and
  "first N books" counts), remember the last pick per conversation, and say in the chip
  when more than six books are picked that the librarians read the first six.
- LLM router as a fallback when no heuristic in `intent.ts` fires with confidence.
- Opus/Sonnet token cost in currency on the usage line (needs a price table per model).
- macOS / Linux packaging (config exists, never built).
- `PUBLIC_MODE` as a real read-only deployment (auth, rate limits) or remove it; the
  old `deploy.sh` was deleted because it targeted Ollama.
- Electron smoke test in CI (launch, wait for window, quit).
