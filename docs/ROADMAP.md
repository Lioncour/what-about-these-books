# Roadmap

What is open after 0.2.0 (see the changelog for what shipped). Ordered by value for
effort; move things as priorities change, and delete an item when it ships.

## Next

1. **Install 0.2.0 on a clean machine.** The packaged app passes the smoke test here and
   in CI, where Node, AWS CLI and (here) a library exist. Run the installer on a machine
   without them and walk the first-run path: AWS profile dialog, empty library, first
   upload, first question. This is the one thing never tested.
2. **Check that CI builds the installers.** The Linux AppImage and Windows installer jobs
   were written without being run; the first push shows whether they work.
3. **Check the price table against the AWS bill** (`src/lib/model-prices.ts` or
   `MODEL_PRICES_JSON`), especially for the EU inference profiles.
4. **Verify the loose eval checks live.** Eight cases have text checks that were not run
   live (see the changelog); `npm run eval:chat -- --live --save-baseline` covers them
   for about 80 calls.

## Soon

5. **Who-is reads the right books.** Evidence is the first hits in shelf order, so a
   character who arrives late is described from their first, minor appearance. Rank the
   hits by how much of the passage is about the character, or by the graph's per-book
   mention counts.
6. **Ships without an article** ("Valkyrie") now classify as places, and "How many books
   is Nagatha in?" routes to the library count. Both are small rule fixes with eval cases.
7. **Past notes** show a pick from its saved title; `listChats()` should return the saved
   pick so the drawer can say exactly which books.
8. **A larger pick** ranks only the ten books the one ranking query returns; the rest fall
   back to shelf order. A per-book score from the index would rank them all.

## Later

- Code signing (Windows SmartScreen warns on unsigned builds) and a macOS build: both
  need things only the owner can get; `docs/RELEASING.md` says what.
- `PUBLIC_MODE` as a real read-only deployment (auth, rate limits) or remove it.
- Replace vectra with a small local index: the installer is already half the size, and
  this would remove the last large unused dependency (the tokenizer tables).
- Librarian model: measured 2026-11-13, Haiku stays. Repeat when the eval's content
  checks have grown.
- Prompt caching: measured and skipped (the stable system text is under the minimum).
