/** Map internal STATUS strings to “remember with me” presence copy when companion mode is on. */
export function presenceStatus(raw: string, companionMode: boolean): string {
  if (!companionMode) return raw;

  const rules: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
    [/^Figuring out the best way to answer/i, "Thinking about how to answer you…"],
    [/^Running library command/i, "On it — updating your library…"],
    [/^Searching across your entire library/i, "Flipping through your whole shelf…"],
    [/^Building specialist roster/i, "Picking which books to reread with you…"],
    [
      /^Consulting (\d+) Librarian agents(?::\s*(.*))?/i,
      (m) =>
        m[2]
          ? `Reading along in ${m[2]}…`
          : `Reading along in ${m[1]} book${m[1] === "1" ? "" : "s"}…`,
    ],
    [/^Main AI is merging specialist reports/i, "Putting the pieces together…"],
    [/^Main AI is composing final answer/i, "Writing this down for you…"],
    [/^Sending to Claude on Bedrock/i, "Remembering the passages with you…"],
    [/^Building context from/i, "Gathering the pages that matter…"],
    [/^Running exact quote lookup/i, "Hunting for that exact line…"],
    [/^Running keyword search/i, "Scanning for matching words…"],
    [/^Looking up who/i, "Pulling character notes…"],
    [/^Counting mentions of/i, "Counting carefully…"],
    [/^This is a general prompt/i, "Answering without digging into the books…"],
    [/^No books available/i, "I don’t see any books to check yet."],
    [/^Done —/i, "Done."],
  ];

  for (const [re, out] of rules) {
    const m = raw.match(re);
    if (!m) continue;
    return typeof out === "function" ? out(m) : out;
  }
  return raw;
}
