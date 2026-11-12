/**
 * Chapter labels for EPUB page maps, read from each section's own heading.
 *
 * An EPUB is a flow of files: cover, title page, copyright, contents, then chapters.
 * Numbering the flow ("Chapter 12") mislabels every chapter by the amount of front
 * matter, so a passage from "CHAPTER TEN SKIPPY" was cited as Chapter 12. The text we
 * keep is flattened to single spaces, so the heading is whatever recognisable heading
 * the section text starts with. Pure functions; no I/O.
 */
import type { BookPage } from "./pages";

export interface ChapterHeading {
  kind: "chapter" | "part" | "named";
  /** Chapter or part number. */
  number?: number;
  /** "Chapter", "Part", "Book", or the section's name ("Prologue", "Epilogue", …). */
  word: string;
  /** Short title after the number, title-cased. */
  title?: string;
}

const MAX_TITLE_CHARS = 40;
const MAX_CHAPTER_NUMBER = 300;

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const has = (table: Record<string, number>, word: string | undefined): word is string =>
  word !== undefined && Object.prototype.hasOwnProperty.call(table, word);
const ROMAN_RE = /^(?=[CLXVI])C{0,3}(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/** Sections that are named rather than numbered. `loose`: any text may follow the word. */
const NAMED_SECTIONS: Array<{ re: RegExp; label: string; loose?: boolean }> = [
  { re: /^prologue\b/i, label: "Prologue" },
  { re: /^epilogue\b/i, label: "Epilogue" },
  { re: /^introduction\b/i, label: "Introduction" },
  { re: /^preface\b/i, label: "Preface" },
  { re: /^foreword\b/i, label: "Foreword" },
  { re: /^afterword\b/i, label: "Afterword" },
  { re: /^interlude\b/i, label: "Interlude" },
  { re: /^acknowledge?ments?\b/i, label: "Acknowledgments", loose: true },
  { re: /^dedication\b/i, label: "Dedication", loose: true },
  { re: /^(?:table\s+of\s+)?contents\b/i, label: "Contents" },
  { re: /^copyright\b/i, label: "Copyright", loose: true },
  { re: /^about\s+the\s+authors?\b/i, label: "About the author", loose: true },
  { re: /^author['’]?s['’]?\s+notes?\b/i, label: "Author's note", loose: true },
  { re: /^glossary\b/i, label: "Glossary" },
  { re: /^appendix\b/i, label: "Appendix" },
  { re: /^also\s+by\b/i, label: "Also by the author", loose: true },
];

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with",
]);

const SENTENCE_END_RE = /[.!?]["”']?$/;

function stripEdgePunct(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function hasLower(token: string): boolean {
  return /\p{Ll}/u.test(token);
}

function isCapsToken(token: string): boolean {
  return /[\p{Lu}\p{N}]/u.test(token) && !hasLower(token);
}

function startsCapital(token: string): boolean {
  return /^[\p{Lu}\p{N}]/u.test(stripEdgePunct(token));
}

function romanValue(token: string): number | null {
  if (!ROMAN_RE.test(token)) return null;
  let total = 0;
  for (let i = 0; i < token.length; i++) {
    const v = ROMAN_VALUES[token[i]];
    const next = ROMAN_VALUES[token[i + 1]] || 0;
    total += v < next ? -v : v;
  }
  return total;
}

/** Number words in `words` from the start: "ten", "twenty one", "one hundred and five". */
function parseNumberWords(words: string[]): { value: number; used: number } | null {
  let i = 0;
  let value = 0;
  if (has(UNITS, words[i]) && UNITS[words[i]] < 10 && words[i + 1] === "hundred") {
    value = UNITS[words[i]] * 100;
    i += 2;
    const afterAnd = words[i] === "and" ? i + 1 : i;
    if (has(UNITS, words[afterAnd]) || has(TENS, words[afterAnd])) i = afterAnd;
    else return { value, used: i };
  }
  if (has(TENS, words[i])) {
    value += TENS[words[i]];
    i++;
    if (has(UNITS, words[i]) && UNITS[words[i]] < 10) {
      value += UNITS[words[i]];
      i++;
    }
  } else if (has(UNITS, words[i])) {
    value += UNITS[words[i]];
    i++;
  }
  return i > 0 ? { value, used: i } : null;
}

/**
 * Number starting at `tokens[i]`: digits, upper-case roman numerals, or words
 * ("ten", "twenty-one", "ninety nine"). Returns the value and how many tokens it used.
 */
function parseNumber(tokens: string[], i: number): { value: number; used: number } | null {
  const first = stripEdgePunct(tokens[i] || "");
  if (!first) return null;
  if (/^\d{1,3}$/.test(first)) return { value: Number(first), used: 1 };
  const roman = romanValue(first);
  if (roman != null) return { value: roman, used: 1 };

  // Words, with "twenty-one" split; punctuation after a token ends the number
  // ("TWENTY: ONE SMALL STEP" is chapter 20).
  const words: string[] = [];
  const tokenOfWord: number[] = [];
  for (let j = i; j < tokens.length && j < i + 6; j++) {
    for (const part of stripEdgePunct(tokens[j]).toLowerCase().split("-")) {
      words.push(part);
      tokenOfWord.push(j);
    }
    if (/[:.,;–—]$/.test(tokens[j])) break;
  }
  const parsed = parseNumberWords(words);
  if (!parsed) return null;
  const lastToken = tokenOfWord[parsed.used - 1];
  // Half of a hyphenated token ("TWENTY-SOMETHING") is not a number.
  if (tokenOfWord[parsed.used] === lastToken) return null;
  return { value: parsed.value, used: lastToken - i + 1 };
}

/** "SKIPPY'S BIG DAY" → "Skippy's Big Day"; keeps roman numerals and small words. */
export function titleCaseHeading(raw: string): string {
  const words = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words
    .map((word, idx) => {
      const core = stripEdgePunct(word);
      if (core.length >= 2 && ROMAN_RE.test(core)) return word;
      const lower = word.toLowerCase();
      if (idx > 0 && SMALL_WORDS.has(stripEdgePunct(lower))) return lower;
      // Capitalise the first letter of the word and of each hyphenated part.
      return lower.replace(/(^|[-–—/])(\P{L}*)(\p{L})/gu, (_m, sep: string, pre: string, ch: string) =>
        sep + pre + ch.toUpperCase()
      );
    })
    .join(" ");
}

function capTitle(title: string): string {
  const cleaned = title.replace(/^[\s:.,;–—-]+|[\s:.,;–—-]+$/g, "").replace(/\s+/g, " ");
  if (cleaned.length <= MAX_TITLE_CHARS) return cleaned;
  const cut = cleaned.slice(0, MAX_TITLE_CHARS + 1);
  const atWord = cut.lastIndexOf(" ");
  return `${cut.slice(0, atWord > 12 ? atWord : MAX_TITLE_CHARS).replace(/[\s:.,;–—-]+$/g, "")}…`;
}

/**
 * The short title that follows a heading's number.
 * - `whole`: the input is the heading alone, so everything left is the title.
 * - an ALL-CAPS heading: the run of upper-case words ("CHAPTER TEN SKIPPY I woke" → "SKIPPY";
 *   a trailing "I"/"A" before more text starts the first sentence).
 * - mixed case: only after a separator ("Chapter 10: Skippy I woke"), the run of
 *   capitalised words minus the last one when lower-case text follows (it starts the sentence).
 */
function takeTitle(
  tokens: string[],
  start: number,
  opts: { whole: boolean; capsHeading: boolean; separator: boolean }
): string | undefined {
  const rest = tokens.slice(start);
  if (!rest.length) return undefined;
  if (opts.whole) return capTitle(titleCaseHeading(rest.join(" "))) || undefined;

  const MAX_RUN = 8;
  const run: string[] = [];
  if (opts.capsHeading) {
    for (const tok of rest) {
      if (!isCapsToken(tok)) break;
      run.push(tok);
      if (run.length > MAX_RUN) return undefined; // the text itself is upper case
      if (SENTENCE_END_RE.test(tok)) break;
    }
    if (rest[run.length] && run.length && /^(?:I|A)$/.test(run[run.length - 1])) run.pop();
  } else if (opts.separator) {
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      const connector =
        run.length > 0 && SMALL_WORDS.has(stripEdgePunct(tok).toLowerCase()) && startsCapital(rest[i + 1] || "");
      if (!startsCapital(tok) && !connector) break;
      run.push(tok);
      if (run.length > MAX_RUN) return undefined;
      if (SENTENCE_END_RE.test(tok)) break;
    }
    const next = rest[run.length];
    const endsSentence = SENTENCE_END_RE.test(run[run.length - 1] || "");
    if (next && !endsSentence && /^\p{Ll}/u.test(stripEdgePunct(next))) {
      run.pop();
      while (run.length && SMALL_WORDS.has(stripEdgePunct(run[run.length - 1]).toLowerCase())) run.pop();
    }
  }
  if (!run.length) return undefined;
  const title = capTitle(titleCaseHeading(run.join(" ")));
  return /\p{L}/u.test(title) ? title : undefined;
}

function parseNumbered(
  tokens: string[],
  kind: "chapter" | "part",
  word: string,
  whole: boolean
): ChapterHeading | null {
  const num = parseNumber(tokens, 1);
  if (!num || num.value < 1 || num.value > MAX_CHAPTER_NUMBER) return null;
  let next = 1 + num.used;
  let separator = /[:.–—-]$/.test(tokens[next - 1]);
  if (/^[:–—-]+$/.test(tokens[next] || "")) {
    separator = true;
    next++;
  }
  const title = takeTitle(tokens, next, { whole, capsHeading: !hasLower(tokens[0]), separator });
  return { kind, number: num.value, word, title };
}

/**
 * Recognise the heading a section's text starts with. `whole: true` means `text` is the
 * heading element alone (an `<h1>`), so whatever follows the number is the title.
 */
export function parseChapterHeading(text: string, opts: { whole?: boolean } = {}): ChapterHeading | null {
  const whole = opts.whole === true;
  const head = text.slice(0, 400).replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!head) return null;
  const tokens = head.split(" ");
  const first = stripEdgePunct(tokens[0]);
  const firstLower = first.toLowerCase();
  if (!/^\p{Lu}/u.test(first)) return null;

  if (firstLower === "chapter" || firstLower === "chap" || (firstLower === "ch" && /\.$/.test(tokens[0]))) {
    return parseNumbered(tokens, "chapter", "Chapter", whole);
  }

  if (firstLower === "part" || firstLower === "book") {
    const part = parseNumbered(tokens, "part", firstLower === "part" ? "Part" : "Book", whole);
    if (!part) return null;
    // "PART ONE CHAPTER ONE …": the chapter is the more useful label.
    const chapterAt = head.slice(0, 200).search(/\s(?:CHAPTER|Chapter)\s/);
    if (chapterAt > 0) {
      const chapter = parseChapterHeading(head.slice(chapterAt + 1), opts);
      if (chapter?.kind === "chapter") return chapter;
    }
    return part;
  }

  for (const section of NAMED_SECTIONS) {
    const m = section.re.exec(head);
    if (!m) continue;
    const after = head.slice(m[0].length).replace(/^[^\p{L}\p{N}]+/u, "");
    // Mixed case: "Prologue Joe looked up" is a heading, "Introduction to physics is" is prose.
    if (!whole && hasLower(m[0]) && !section.loose && /^\p{Ll}/u.test(after)) return null;
    return { kind: "named", word: section.label };
  }

  // A bare spelled-out number in capitals ("TEN The morning…"). Not when more capitals
  // follow: "ONE MORNING, Joe…" is a lead-in, not a heading.
  if (!hasLower(tokens[0]) && first.length >= 3 && romanValue(first) == null) {
    const num = parseNumber(tokens, 0);
    if (num && num.value >= 1 && num.value <= MAX_CHAPTER_NUMBER) {
      const next = tokens[num.used];
      if (whole ? next === undefined : next !== undefined && !isCapsToken(next)) {
        return { kind: "chapter", number: num.value, word: "Chapter" };
      }
    }
  }
  return null;
}

function formatChapterLabel(heading: ChapterHeading): string {
  const base = heading.number != null ? `${heading.word} ${heading.number}` : heading.word;
  return heading.title ? `${base} · ${heading.title}` : base;
}

/** Label for one section from its text ("Chapter 10 · Skippy"), or null without a heading. */
export function chapterLabelFromText(text: string): string | null {
  const heading = parseChapterHeading(text);
  return heading ? formatChapterLabel(heading) : null;
}

/** First `<h1>`–`<h3>` (else `<h4>`–`<h6>`) of a chapter's HTML, as plain text. */
export function firstHtmlHeading(html: string): string | undefined {
  const m =
    /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(html) || /<h([4-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(html);
  if (!m) return undefined;
  const text = m[2].replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
  return text && text.length <= 160 ? text : undefined;
}

function headingFor(text: string, hint?: string): ChapterHeading | null {
  const fromText = parseChapterHeading(text);
  const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  // The hint is only trusted when the section really starts with it.
  const fromHint =
    hint && squash(text.slice(0, 400).replace(/^[^\p{L}\p{N}]+/u, "")).startsWith(squash(hint))
      ? parseChapterHeading(hint, { whole: true })
      : null;
  if (!fromHint) return fromText;
  if (!fromText) return fromHint;
  // "<h1>CHAPTER TEN</h1><h2>SKIPPY</h2>": the hint has the number, the text has the title.
  if (!fromHint.title && fromText.title && fromText.number === fromHint.number && fromText.kind === fromHint.kind) {
    return fromText;
  }
  return fromHint;
}

/** Fewer recognised chapter headings than this and a book keeps its labels as they are. */
const MIN_CHAPTER_HEADINGS = 2;

/**
 * Labels for an EPUB's sections in flow order: the section's own heading where one is
 * recognised; otherwise "Front matter" before the first heading and "Section N" (N =
 * position in the flow) after it. Repeated labels get " (2)", " (3)" so a citation
 * finds one section. Returns null when fewer than two chapter headings were recognised:
 * then the headings can't be trusted to describe the book and nothing should change.
 *
 * `hints[i]` may carry section i's heading element text (ingest has the HTML).
 */
export function epubSectionLabels(
  texts: readonly string[],
  hints: readonly (string | undefined)[] = []
): string[] | null {
  const headings = texts.map((text, i) => headingFor(text, hints[i]));
  if (headings.filter((h) => h?.kind === "chapter").length < MIN_CHAPTER_HEADINGS) return null;

  const seen = new Map<string, number>();
  const unique = (label: string): string => {
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} (${n})`;
  };

  let sawHeading = false;
  return headings.map((heading, i) => {
    if (heading) {
      sawHeading = true;
      return unique(formatChapterLabel(heading));
    }
    return unique(sawHeading ? `Section ${i + 1}` : "Front matter");
  });
}

/** `epubSectionLabels` applied to a page map. Page text is never changed. */
export function relabelEpubPages(
  pages: readonly BookPage[],
  hints: readonly (string | undefined)[] = []
): BookPage[] {
  const labels = epubSectionLabels(pages.map((p) => p.text), hints);
  if (!labels) return pages.map((p) => ({ ...p }));
  return pages.map((p, i) => ({ ...p, label: labels[i] }));
}
