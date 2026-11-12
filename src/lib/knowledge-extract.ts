/**
 * Finds the names in a book's text and says what each one is, without an AI call.
 *
 * A capitalised word is only evidence of a name when the capital isn't explained by
 * its position: "The", "That" and "You" open sentences, "Skippy" is capitalised in the
 * middle of one. What a name is comes from what surrounds it across the whole book:
 * people speak and carry titles ("Colonel Bishop", "Skippy said"), groups and ships
 * take an article ("the Kristang", "the Flying Dutchman"), places follow a preposition
 * ("on Paradise").
 */

export type EntityType = "character" | "place" | "faction" | "unknown";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  /** Occurrences in the book, aliases included. */
  mentions: number;
  /** Other forms counted into this entity ("Joe", "Bishop" for "Joe Bishop"). */
  aliases: string[];
}

const TITLES = new Set(
  (
    "colonel captain sergeant major general admiral lieutenant private corporal commander " +
    "doctor dr mr mrs ms miss sir lord lady king queen prince princess president professor " +
    "uncle aunt chief specialist ensign commodore governor senator emperor empress master " +
    "father mother brother sister saint agent detective officer inspector"
  ).split(" ")
);

const SPEECH =
  "said|says|asked|asks|replied|answered|shouted|yelled|whispered|muttered|laughed|sighed|nodded|" +
  "grinned|snorted|added|continued|explained|agreed|groaned|growled|shrugged|smiled|interrupted|" +
  "protested|declared|admitted|announced|scoffed|chuckled|warned|insisted|demanded|suggested|" +
  "observed|remarked|complained|pleaded|snapped|grumbled|exclaimed|frowned|winked|gasped|told";
const SPEECH_AFTER = new RegExp(`^\\s+(?:${SPEECH})\\b`, "i");
const SPEECH_BEFORE = new RegExp(`\\b(?:${SPEECH})\\s+$`, "i");
const ARTICLE_BEFORE = /\bthe\s+$/i;
const PLACE_BEFORE =
  /\b(?:on|in|at|to|from|near|toward|towards|above|below|orbiting|leaving|reaching|across|into|onto|off|around|outside|inside|beyond)\s+$/i;
const PLACE_WORD = /\b(?:planet|city|station|base|moon|island|mountain|valley|river|ocean|sea|street|county|province|system|sector|nebula|galaxy)\b/i;
const GROUP_WORD = /\b(?:kingdom|fleet|empire|force|alliance|army|clan|federation|republic|coalition|command|corps|navy|council|guild|union)\b/i;

/** Words that are capitalised for reasons other than being a name. */
const NOT_NAMES = new Set(
  (
    "i i'm i'll i've i'd the a an and but or so if then when while because although though " +
    "he she it we you they his her its our your their him them me my mine us this that these those " +
    "there here what who whom whose which why how where yes no not ok okay oh ah uh um hey hi hello " +
    "well now just maybe perhaps please thanks thank sorry sure right wrong good bad great fine " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june " +
    "july august september october november december chapter part book prologue epilogue contents " +
    "copyright one two three four five six seven eight nine ten first second third next last " +
    "after before during since until once again also still even only never always nothing something " +
    "everything anything someone anyone everyone nobody all some any each every both either neither " +
    "mister madam god damn hell crap holy shit dude man guys guy sir ma'am " +
    "do does did is are was were be been have has had can could will would shall should may might must " +
    "let get got go going come look see tell say said think know want need make take give " +
    "with without for from into onto over under about above below between through at by in on of to as up down out off"
  ).split(" ")
);

interface Stats {
  name: string;
  total: number;
  /** Capitalised where a sentence start doesn't explain it. */
  mid: number;
  speech: number;
  title: number;
  article: number;
  place: number;
}

const WORD = "[A-Z][a-z]+(?:[-'’][A-Za-z]+)?";
const CANDIDATE = new RegExp(`\\b${WORD}(?:\\s+${WORD}){0,2}\\b`, "g");

function isSentenceStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  // Opening quotes and brackets belong to the sentence they open.
  while (i >= 0 && /["“‘'(\[—–-]/.test(text[i])) {
    i--;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (i < 0) return true;
  }
  return /[.!?:…”"]/.test(text[i]);
}

/** Lower-case word frequencies: a "name" that is mostly written in lower case is a word. */
function lowerCaseCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\b[a-z][a-z'’-]+\b/g)) {
    counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  }
  return counts;
}

function collectStats(pages: Array<{ text: string }>): { stats: Map<string, Stats>; lower: Map<string, number> } {
  const stats = new Map<string, Stats>();
  const lower = new Map<string, number>();

  for (const page of pages) {
    const text = page.text;
    for (const [word, n] of lowerCaseCounts(text)) lower.set(word, (lower.get(word) || 0) + n);

    for (const match of text.matchAll(CANDIDATE)) {
      let words = match[0].split(/\s+/);
      let start = match.index ?? 0;
      let atStart = isSentenceStart(text, start);
      let titled = false;

      // Peel what isn't part of the name off the front: sentence openers, then titles.
      while (words.length) {
        const first = words[0].toLowerCase();
        if (TITLES.has(first) && words.length > 1) {
          titled = true;
        } else if (!(NOT_NAMES.has(first) && (atStart || words.length > 1))) {
          break;
        }
        start += words[0].length + 1;
        words = words.slice(1);
        atStart = false;
      }
      // …and trailing words that aren't names ("Skippy The", "Joe And").
      while (words.length && NOT_NAMES.has(words[words.length - 1].toLowerCase())) words = words.slice(0, -1);
      if (!words.length) continue;
      if (words.length === 1 && NOT_NAMES.has(words[0].toLowerCase())) continue;

      const name = words.join(" ").replace(/[’']s$/i, "");
      if (name.length < 3 || name.length > 40) continue;

      const before = text.slice(Math.max(0, start - 14), start);
      const after = text.slice(start + words.join(" ").length, start + words.join(" ").length + 16);
      const key = name.toLowerCase();
      const row = stats.get(key) || { name, total: 0, mid: 0, speech: 0, title: 0, article: 0, place: 0 };
      row.total += 1;
      // In "Joe Bishop sighed." the first capital is explained by the sentence start,
      // the second is not: a multi-word name is evidence wherever it stands.
      if (!atStart || words.length > 1) row.mid += 1;
      if (titled || TITLES.has((before.trim().split(/\s+/).pop() || "").toLowerCase())) row.title += 1;
      if (SPEECH_AFTER.test(after) || SPEECH_BEFORE.test(before)) row.speech += 1;
      if (ARTICLE_BEFORE.test(before)) row.article += 1;
      if (PLACE_BEFORE.test(before)) row.place += 1;
      stats.set(key, row);
    }
  }
  return { stats, lower };
}

function isRealName(row: Stats, lower: Map<string, number>): boolean {
  if (row.mid < 2 || row.total < 3) return false;
  const words = row.name.toLowerCase().split(/\s+/);
  if (words.length === 1) {
    // "Hope" the person vs "hope" the word: a name is rarely written in lower case.
    return (lower.get(words[0]) || 0) < row.total * 0.5;
  }
  // A phrase of ordinary words that happened to be capitalised ("Holy Crap", "Merry Band").
  return !words.every((w) => (lower.get(w) || 0) > 3 || NOT_NAMES.has(w));
}

function classify(row: Stats): EntityType {
  const person = row.speech + row.title * 2;
  if (GROUP_WORD.test(row.name)) return "faction";
  if (PLACE_WORD.test(row.name)) return "place";
  if (person >= Math.max(2, row.total * 0.03) && person >= row.article) return "character";
  if (row.article >= Math.max(2, row.total * 0.3)) return "faction";
  if (row.place >= Math.max(2, row.total * 0.3)) return "place";
  if (person >= 1 && row.article === 0) return "character";
  return "unknown";
}

/**
 * Names found in one book, most mentioned first. "Joe" and "Bishop" are folded into
 * "Joe Bishop" when that is the only full name either belongs to.
 */
export function extractBookEntities(pages: Array<{ text: string }>, maxEntities = 200): ExtractedEntity[] {
  const { stats, lower } = collectStats(pages);
  const kept = new Map<string, Stats & { type: EntityType; aliases: string[] }>();
  for (const [key, row] of stats) {
    if (!isRealName(row, lower)) continue;
    kept.set(key, { ...row, type: classify(row), aliases: [] });
  }

  // Fold first and last names into the full name they belong to.
  const fullNames = [...kept.values()].filter((r) => r.name.includes(" ") && r.name.split(" ").length === 2);
  const startsWith = new Map<string, number>();
  const endsWith = new Map<string, number>();
  for (const full of fullNames) {
    const [first, last] = full.name.toLowerCase().split(" ");
    startsWith.set(first, (startsWith.get(first) || 0) + 1);
    endsWith.set(last, (endsWith.get(last) || 0) + 1);
  }
  for (const full of fullNames.sort((a, b) => b.total - a.total)) {
    const fullKey = full.name.toLowerCase();
    if (!kept.has(fullKey)) continue;
    const [first, last] = fullKey.split(" ");
    const parts = [
      startsWith.get(first) === 1 ? kept.get(first) : undefined,
      endsWith.get(last) === 1 ? kept.get(last) : undefined,
    ].filter((p): p is NonNullable<typeof p> => !!p);
    const person = full.type === "character" || parts.some((p) => p.type === "character");
    if (!person) continue;
    const target = kept.get(fullKey)!;
    for (const part of parts) {
      target.total += part.total;
      target.aliases.push(part.name);
      kept.delete(part.name.toLowerCase());
    }
    target.type = "character";
  }

  return [...kept.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, maxEntities)
    .map((r) => ({ name: r.name, type: r.type, mentions: r.total, aliases: r.aliases }));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matcher that finds the given entities (by name or alias) in a piece of text, in order. */
export function entityFinder(entities: ExtractedEntity[]): (text: string) => string[] {
  const byForm = new Map<string, string>();
  for (const e of entities) {
    byForm.set(e.name.toLowerCase(), e.name);
    for (const alias of e.aliases) byForm.set(alias.toLowerCase(), e.name);
  }
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length);
  if (!forms.length) return () => [];
  const re = new RegExp(`\\b(?:${forms.map(escapeRe).join("|")})\\b`, "gi");
  return (text) => {
    const found: string[] = [];
    for (const m of text.matchAll(re)) {
      const name = byForm.get(m[0].toLowerCase());
      if (name && !found.includes(name)) found.push(name);
    }
    return found;
  };
}
