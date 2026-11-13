/**
 * Finds the names in a book's text and says what each one is, without an AI call.
 *
 * A capitalised word is only evidence of a name when the capital isn't explained by
 * its position: "The", "That" and "You" open sentences, "Skippy" is capitalised in the
 * middle of one. What a name is comes from what surrounds it across the whole book:
 * people speak and carry titles ("Colonel Bishop", "Skippy said"), groups and ships
 * take an article ("the Kristang", "the Flying Dutchman"), places follow a preposition
 * ("on Paradise", "near Thomson Corners").
 *
 * Second pass: a rank alone is nobody's name, plurals fold into the group they belong
 * to ("Kristangs"), nationalities and languages are peoples, ALL-CAPS abbreviations
 * used as names are groups ("UNEF"), and a name that is somewhere more often than it
 * says something is a place even when part of it is also a person's name.
 */

export type EntityType = "character" | "place" | "faction" | "unknown";

/** What surrounded a name in one book; summed across books to settle its type library-wide. */
export interface EntityEvidence {
  total: number;
  speech: number;
  title: number;
  article: number;
  /** After any preposition of place or direction ("to Skippy" counts too). */
  place: number;
  /** After a preposition only a location takes ("in", "near", "at" without a verb of looking). */
  loc: number;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  /** Occurrences in the book, aliases included. */
  mentions: number;
  /** Other forms counted into this entity ("Joe", "Bishop" for "Joe Bishop"; "Kristangs" for "Kristang"). */
  aliases: string[];
  evidence?: EntityEvidence;
}

const TITLES = new Set(
  (
    "colonel captain sergeant major general admiral lieutenant private corporal commander " +
    "doctor dr mr mrs ms miss sir lord lady king queen prince princess president professor " +
    "uncle aunt chief specialist ensign commodore governor senator emperor empress master " +
    "father mother brother sister saint agent detective officer inspector " +
    "gunnery gunny staff brigadier marshal commandant commissioner subcaptain cadet airman seaman " +
    "petty warrant chancellor ambassador minister judge reverend pastor nurse coach"
  ).split(" ")
);

/** "Colonel", "Captains", "Gunnery": a rank or form of address, never a name on its own. */
function isTitleWord(word: string): boolean {
  const w = word.toLowerCase().replace(/[.’']/g, "");
  return TITLES.has(w) || (w.endsWith("s") && TITLES.has(w.slice(0, -1)));
}

/** Nationalities and languages: a people, not a person ("French", "the Chinese"). */
const DEMONYMS = new Set(
  (
    "american british english french german chinese russian indian japanese canadian mexican spanish " +
    "italian korean australian irish scottish welsh dutch swedish norwegian danish finnish nigerian " +
    "european african asian brazilian israeli polish greek turkish arab arabic latin mandarin hindi " +
    "portuguese egyptian iranian iraqi pakistani vietnamese thai filipino swiss belgian austrian " +
    "ukrainian cuban texan californian hawaiian soviet roman"
  ).split(" ")
);

/** Capitalised abbreviations that are things or shouting, not the name of a group. */
const NOT_ACRONYMS = new Set(
  (
    "dna rna ftl emp gps mre suv tnt rpg ptsd dvd vip eta awol usa ufo atm cpr icu mri hud led lcd " +
    "ceo pdf wtf omg lol asap snafu fubar radar laser sonar scuba aka diy faq rsvp " +
    "the and but not you are was for all any yes his her its our who why how what when that this " +
    "with from have has had can will get got out now one two too off"
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
/** "in Paradise", "near Earth": only a location follows these. "at" after a verb of looking or shouting doesn't count. */
const LOC_BEFORE = /\b(?:in|near|at|orbiting|above|below|outside|inside|beyond|across|leaving|reaching)\s+$/i;
const AIMED_AT =
  /\b(?:look|star|glar|glanc|gaz|peer|yell|shout|scream|snap|smil|grinn|wink|point|laugh|aim|shoot|shot|fir|wav|nodd|frown|scowl|blink|mad|angry|swor|swear|bark|snarl|hiss|thr[eo]w|toss|direct)\w*\s+at\s+$/i;
const PLACE_WORD =
  /\b(?:planet|city|station|base|moon|island|mountain|valley|river|ocean|sea|street|county|province|system|sector|nebula|galaxy|corners?|falls|springs|heights|creek|lake|bay|harbou?r|camp|fort|fortress|town|village|ridge|canyon|desert|forest|plains|beach|port|road|avenue|highway|bridge|park|square|peninsula|continent|crater|moonbase)\b/i;
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
    "ugh hmm wow yeah yep yup nope nah jeez geez gee gosh ooh duh whoa huh heh ha haha hah aw aww eww ew " +
    "argh gah oof ouch oops shh psst mmm hmph bah whew phew darn dang goddamn bullshit wait listen " +
    "except dear surprise mom dad mommy daddy grandma grandpa honey buddy pal kid kids folks gentlemen ladies " +
    "do does did is are was were be been have has had can could will would shall should may might must " +
    "let get got go going come look see tell say said think know want need make take give " +
    "with without for from into onto over under about above below between through at by in on of to as up down out off"
  ).split(" ")
);

/** "Hmmm", "Ooooh", "Ughh": a drawn-out interjection of any length. */
const INTERJECTION =
  /^(?:h+m+|o+h+|u+g+h+|a+h+|w+o+w+|who+a+|ye+a+h*|na+h+|je+e+z+|du+h+|e+w+|a+w+|u+m+|u+h+|ha(?:ha)+h?|he+h+|sh+|mm+|argh+|whe+w+|yo+)$/i;

const lowerKey = (word: string) => word.toLowerCase().replace(/’/g, "'");
const notName = (word: string) => {
  const w = lowerKey(word);
  if (NOT_NAMES.has(w) || INTERJECTION.test(w)) return true;
  // "You're", "Don't", "We'll": a contraction of a word that is no name.
  const cut = w.search(/n't$|'(?:re|ll|ve|d|m|s)$/);
  return cut > 0 && (NOT_NAMES.has(w.slice(0, cut)) || /^(?:do|is|was|ca|wo|did|are|has|had|have|does|were|could|would|should|ai)$/.test(w.slice(0, cut)));
};

interface Stats extends EntityEvidence {
  name: string;
  /** Capitalised where a sentence start doesn't explain it. */
  mid: number;
}

const emptyStats = (name: string): Stats => ({ name, total: 0, mid: 0, speech: 0, title: 0, article: 0, place: 0, loc: 0 });

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
        if (isTitleWord(words[0]) && words.length > 1) {
          titled = true;
        } else if (!(notName(words[0]) && (atStart || words.length > 1))) {
          break;
        }
        start += words[0].length + 1;
        words = words.slice(1);
        atStart = false;
      }
      // "Reed's Condor" is Reed, then something of hers: the name ends at the possessive.
      const owner = words.findIndex((w, i) => i < words.length - 1 && /[’']s$/i.test(w));
      if (owner >= 0) words = words.slice(0, owner + 1);
      // …and trailing words that aren't names ("Skippy The", "Joe And").
      while (words.length && notName(words[words.length - 1])) words = words.slice(0, -1);
      if (!words.length) continue;
      if (words.length === 1 && notName(words[0])) continue;
      // A rank alone ("Colonel", "Gunnery Sergeant") addresses someone; it names nobody.
      if (words.every(isTitleWord)) continue;

      const name = words.join(" ").replace(/[’']s$/i, "");
      if (name.length < 3 || name.length > 40) continue;

      const before = text.slice(Math.max(0, start - 24), start);
      const after = text.slice(start + words.join(" ").length, start + words.join(" ").length + 16);
      const key = lowerKey(name);
      const row = stats.get(key) || emptyStats(name);
      row.total += 1;
      // In "Joe Bishop sighed." the first capital is explained by the sentence start,
      // the second is not: a multi-word name is evidence wherever it stands.
      if (!atStart || words.length > 1) row.mid += 1;
      if (titled || isTitleWord(before.trim().split(/\s+/).pop() || "")) row.title += 1;
      if (SPEECH_AFTER.test(after) || SPEECH_BEFORE.test(before)) row.speech += 1;
      if (ARTICLE_BEFORE.test(before)) row.article += 1;
      if (PLACE_BEFORE.test(before)) row.place += 1;
      if (LOC_BEFORE.test(before) && !AIMED_AT.test(before)) row.loc += 1;
      stats.set(key, row);
    }
  }
  return { stats, lower };
}

const ACRONYM = /\b[A-Z]{3,6}\b/g;
const NAME_USE_BEFORE = /\b(?:the|by|of|from|with|for|to|at|in|and)\s+$/i;
const A_BEFORE = /\ban?\s+$/i;
const CAPS_WORD = /^[A-Z]{2,}[.,!?;:'’"”-]*$/;

/**
 * ALL-CAPS abbreviations used as a name ("UNEF ordered", "the UNEF", "from UNEF"). A
 * shouted word ("WHAT"), a heading ("CHAPTER TWO") and a thing ("an FTL jump") are not.
 */
function collectAcronyms(
  pages: Array<{ text: string }>,
  stats: Map<string, Stats>,
  lower: Map<string, number>
): Stats[] {
  const found = new Map<string, Stats & { asThing: number; used: number }>();
  for (const page of pages) {
    const text = page.text;
    for (const match of text.matchAll(ACRONYM)) {
      const word = match[0];
      const key = word.toLowerCase();
      if (NOT_ACRONYMS.has(key) || NOT_NAMES.has(key)) continue;
      const start = match.index ?? 0;
      const before = text.slice(Math.max(0, start - 24), start);
      const after = text.slice(start + word.length, start + word.length + 16);
      // Part of a run of capitals: shouting or a heading.
      const prev = before.trim().split(/\s+/).pop() || "";
      const next = after.trim().split(/\s+/)[0] || "";
      if (CAPS_WORD.test(prev) || CAPS_WORD.test(next)) continue;
      const row = found.get(key) || { ...emptyStats(word), asThing: 0, used: 0 };
      row.total += 1;
      row.mid += 1;
      const speech = SPEECH_AFTER.test(after) || SPEECH_BEFORE.test(before);
      if (speech) row.speech += 1;
      if (ARTICLE_BEFORE.test(before)) row.article += 1;
      if (A_BEFORE.test(before)) row.asThing += 1;
      if (speech || /^[’']s\b/.test(after) || NAME_USE_BEFORE.test(before)) row.used += 1;
      found.set(key, row);
    }
  }
  return [...found.values()]
    .filter((row) => {
      const key = row.name.toLowerCase();
      if (row.total < 3) return false;
      // The same word written normally is a word, or a name already counted ("SKIPPY!").
      if ((lower.get(key) || 0) > 0 || stats.has(key)) return false;
      return row.used >= Math.max(2, row.total * 0.2) && row.asThing < row.total * 0.3;
    })
    .map((row) => ({
      name: row.name,
      total: row.total,
      mid: row.mid,
      speech: row.speech,
      title: 0,
      article: row.article,
      place: 0,
      loc: 0,
    }));
}

function isRealName(row: Stats, lower: Map<string, number>): boolean {
  if (row.mid < 2 || row.total < 3) return false;
  const words = lowerKey(row.name).split(/\s+/);
  if (words.length === 1) {
    // "Hope" the person vs "hope" the word: a name is rarely written in lower case.
    return (lower.get(words[0]) || 0) < row.total * 0.5;
  }
  // A phrase of ordinary words that happened to be capitalised ("Holy Crap", "Merry Band").
  return !words.every((w) => (lower.get(w) || 0) > 3 || NOT_NAMES.has(w));
}

const isAcronym = (name: string) => /^[A-Z]{3,6}$/.test(name);

/** Named after what it is: "Thomson Corners", "Camp Alpha", "Ragnar Station". */
function looksLikePlaceName(name: string): boolean {
  return PLACE_WORD.test(name) && !GROUP_WORD.test(name);
}

/**
 * What a name is, from what surrounded it. Exported so the graph can settle a name's
 * type on the evidence of every book it appears in.
 */
export function classifyEntity(name: string, row: EntityEvidence): EntityType {
  const person = row.speech + row.title * 2;
  if (DEMONYMS.has(lowerKey(name)) || isAcronym(name)) return "faction";
  if (GROUP_WORD.test(name)) return "faction";
  if (PLACE_WORD.test(name)) return "place";
  // Somewhere ("in X", "near X") more often than someone ("X said", "Colonel X").
  if (row.loc >= 2 && row.loc > person && row.loc >= row.article) return "place";
  if (person >= Math.max(2, row.total * 0.03) && person >= row.article) return "character";
  if (row.article >= Math.max(2, row.total * 0.3)) return "faction";
  if (row.place >= Math.max(2, row.total * 0.3)) return "place";
  if (person >= 1 && row.article === 0 && row.loc === 0) return "character";
  return "unknown";
}

function addEvidence(into: EntityEvidence, from: EntityEvidence): void {
  into.total += from.total;
  into.speech += from.speech;
  into.title += from.title;
  into.article += from.article;
  into.place += from.place;
  into.loc += from.loc;
}

/** How often a full name must appear, relative to the short form folded into it. */
const MIN_FULL_NAME_SHARE = 0.01;

type Kept = Stats & { type: EntityType; aliases: string[] };

/** The singular a plural form would belong to: "kristangs" → "kristang", "vortexes" → "vortex". */
function singularKeys(key: string): string[] {
  if (key.length < 5 || !key.endsWith("s")) return [];
  const out = [key.slice(0, -1)];
  if (key.endsWith("es")) out.push(key.slice(0, -2));
  return out;
}

/**
 * "Kristangs" is the Kristang, "Sentinels" the Sentinel, "Americans" the American: a
 * plural folds into its singular. Two people are left alone ("Adams" is not several Adam).
 */
function foldPlurals(kept: Map<string, Kept>): void {
  for (const [key, plural] of [...kept]) {
    const baseKey = singularKeys(key).find((k) => kept.has(k));
    if (!baseKey) continue;
    const base = kept.get(baseKey)!;
    if (plural.type === "character" || (base.type === "character" && base.title + base.speech > 2)) continue;
    const group = base.type === "faction" || plural.type === "faction";
    addEvidence(base, plural);
    base.mid += plural.mid;
    base.aliases.push(plural.name, ...plural.aliases);
    kept.delete(key);
    const type = classifyEntity(base.name, base);
    // Something that comes in several and takes an article is a kind, not a person.
    base.type = group || ((type === "unknown" || type === "character") && base.article > 0) ? "faction" : type;
  }
}

/**
 * Names found in one book, most mentioned first. "Joe" and "Bishop" are folded into
 * "Joe Bishop" when that is the only full name either belongs to.
 */
export function extractBookEntities(pages: Array<{ text: string }>, maxEntities = 200): ExtractedEntity[] {
  const { stats, lower } = collectStats(pages);
  const kept = new Map<string, Kept>();
  for (const [key, row] of stats) {
    if (!isRealName(row, lower)) continue;
    kept.set(key, { ...row, type: classifyEntity(row.name, row), aliases: [] });
  }
  for (const row of collectAcronyms(pages, stats, lower)) {
    kept.set(row.name.toLowerCase(), { ...row, type: "faction", aliases: [] });
  }
  foldPlurals(kept);

  /** An everyday word that only looks like half a name: "Club" in "Club Skippy", "Angry" in "Angry Joe". */
  const ordinaryWord = (word: string): boolean => {
    const written = lower.get(word) || 0;
    return written >= 2 && written >= (stats.get(word)?.total || 0) * 0.5;
  };

  // Fold first and last names into the full name they belong to.
  const fullNames = [...kept.values()].filter((r) => r.name.includes(" ") && r.name.split(" ").length === 2);
  const startsWith = new Map<string, number>();
  const endsWith = new Map<string, number>();
  for (const full of fullNames) {
    const [first, last] = lowerKey(full.name).split(" ");
    startsWith.set(first, (startsWith.get(first) || 0) + 1);
    endsWith.set(last, (endsWith.get(last) || 0) + 1);
  }
  for (const full of fullNames.sort((a, b) => b.total - a.total)) {
    const fullKey = lowerKey(full.name);
    if (!kept.has(fullKey)) continue;
    // "Thomson Corners" is a town even if a Thomson lives in the book, and "Club Skippy"
    // is where people go, not Skippy's full name.
    const personal = full.speech + full.title * 2;
    if (looksLikePlaceName(full.name) || full.type === "place" || full.type === "faction") continue;
    if (full.loc > personal || (personal === 0 && full.place + full.article > 0)) continue;
    const [first, last] = fullKey.split(" ");
    // "Skippy Claus" (5 times) is a joke about Skippy (5,000 times), not his full name:
    // a full name is used at least now and then where its short form is.
    const parts = [
      startsWith.get(first) === 1 && !ordinaryWord(last) ? kept.get(first) : undefined,
      endsWith.get(last) === 1 && !ordinaryWord(first) ? kept.get(last) : undefined,
    ].filter(
      (p): p is NonNullable<typeof p> =>
        !!p && p.type !== "place" && p.type !== "faction" && full.total >= p.total * MIN_FULL_NAME_SHARE
    );
    const person = full.type === "character" || parts.some((p) => p.type === "character");
    if (!person) continue;
    const target = kept.get(fullKey)!;
    for (const part of parts) {
      addEvidence(target, part);
      target.aliases.push(part.name, ...part.aliases);
      kept.delete(lowerKey(part.name));
    }
    target.type = "character";
  }

  return [...kept.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, maxEntities)
    .map((r) => ({
      name: r.name,
      type: r.type,
      mentions: r.total,
      aliases: r.aliases,
      evidence: { total: r.total, speech: r.speech, title: r.title, article: r.article, place: r.place, loc: r.loc },
    }));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matcher that finds the given entities (by name or alias) in a piece of text, in order. */
export function entityFinder(entities: ExtractedEntity[]): (text: string) => string[] {
  const byForm = new Map<string, string>();
  /** Abbreviations match as written only: "UNEF" is not "unef", "STAR" is not "star". */
  const exact = new Set<string>();
  for (const e of entities) {
    byForm.set(e.name.toLowerCase(), e.name);
    if (isAcronym(e.name)) exact.add(e.name.toLowerCase());
    for (const alias of e.aliases) byForm.set(alias.toLowerCase(), e.name);
  }
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length);
  if (!forms.length) return () => [];
  const re = new RegExp(`\\b(?:${forms.map(escapeRe).join("|")})\\b`, "gi");
  return (text) => {
    const found: string[] = [];
    for (const m of text.matchAll(re)) {
      const form = m[0].toLowerCase();
      if (exact.has(form) && m[0] !== m[0].toUpperCase()) continue;
      const name = byForm.get(form);
      if (name && !found.includes(name)) found.push(name);
    }
    return found;
  };
}

/**
 * One name, one type, across the library. Each book classifies on its own evidence, so
 * "Kristang" can be a group in seventeen books and unknown in the one that mentions it
 * twice. The type most of its mentions agree on wins; a name no book could place is
 * classified once more on the evidence of all books together, and a plural takes the
 * type of its singular ("Sentinels" where another book has the group "Sentinel").
 */
export function settleEntityTypes(
  nodes: Array<{ name: string; type: string; mentions: number; evidence?: EntityEvidence }>
): void {
  const groups = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const key = lowerKey(node.name);
    groups.set(key, [...(groups.get(key) || []), node]);
  }
  const settled = new Map<string, EntityType>();
  for (const [key, group] of groups) {
    const votes = new Map<EntityType, number>();
    const sum: EntityEvidence = { total: 0, speech: 0, title: 0, article: 0, place: 0, loc: 0 };
    for (const node of group) {
      if (node.type === "character" || node.type === "place" || node.type === "faction") {
        votes.set(node.type, (votes.get(node.type) || 0) + Math.max(1, node.mentions));
      }
      if (node.evidence) addEvidence(sum, node.evidence);
    }
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    settled.set(key, winner || (sum.total > 0 ? classifyEntity(group[0].name, sum) : "unknown"));
  }
  for (const [key, type] of settled) {
    if (type !== "unknown") continue;
    const singular = singularKeys(key).find((k) => settled.get(k) === "faction");
    if (singular) settled.set(key, "faction");
  }
  for (const [key, group] of groups) {
    const type = settled.get(key);
    if (!type || type === "unknown") continue;
    for (const node of group) node.type = type;
  }
}
