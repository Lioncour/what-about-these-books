import {
  loadBookPages,
  listBooks,
  getBookById,
  searchAllBooksKeyword,
  searchBookKeyword,
  searchSeriesKeyword,
  listSeries,
} from "@/lib/book-store";
import { cleanBookDisplayTitle } from "@/lib/chat/display-title";
import {
  extractPassageSearchTerms,
  looksLikeRecipeQuestion,
  normalizeUserQuestion,
} from "@/lib/chat/intent";

export type SmartPassageHit = {
  bookId: string;
  bookTitle: string;
  label: string;
  snippet: string;
  score: number;
  reason: string;
  /** Recipe questions: the items the passage lists, when it really lists some. */
  items?: string[];
  /** Recipe questions: what the passage calls the dish ("called it the …"). */
  name?: string;
  /** Recipe questions: every content word of the question is in the passage (as a phrase, if several). */
  aboutAll?: boolean;
};

type PassageFindIntent = {
  kind: "recipe" | "quote" | "scene" | "general";
  subjectTerms: string[];
};

/** Words of a recipe question that say "recipe", not what the recipe is for. */
const RECIPE_FILLER = new Set([
  "recipe", "recipes", "receipt", "reciept", "recipie", "recipt", "ingredient", "ingredients",
  "make", "makes", "made", "making", "cook", "cooks", "cooked", "cooking", "prepare", "bake",
  "brew", "mix", "instructions", "exactly", "does", "did", "are", "was", "were", "has", "have",
  "goes", "into", "what", "whats", "which", "who", "tell", "give", "list", "get", "got",
  "there", "they", "them", "their", "his", "her", "its", "from", "would", "could", "should",
  "again", "called", "famous", "favorite", "favourite", "own", "the", "and", "for", "you",
  "how", "can", "any", "all",
]);

const escapeRegex = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a recipe question is about: "Can you find the cheeseburger recipe?" → ["cheeseburger"]. */
function recipeSubjectTerms(question: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeUserQuestion(question).replace(/[^\w\s'’-]/g, " ").split(/\s+/)) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, "").replace(/['’]s$/, "").toLowerCase();
    if (w.length < 3 || /^\d+$/.test(w) || RECIPE_FILLER.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  // Generic scope words only matter when nothing else is left.
  const specific = out.filter((w) => !/^(books?|library|series|novels?|find|show|please|where|about|this|that|some|with)$/.test(w));
  return specific.slice(0, 6);
}

function classifyPassageFindIntent(question: string): PassageFindIntent {
  const text = normalizeUserQuestion(question).toLowerCase();
  if (looksLikeRecipeQuestion(text)) return { kind: "recipe", subjectTerms: recipeSubjectTerms(question) };
  const subjectTerms = extractPassageSearchTerms(question);
  if (/\bquote|passage|line where\b/i.test(text)) return { kind: "quote", subjectTerms };
  if (/\bscene|chapter when\b/i.test(text)) return { kind: "scene", subjectTerms };
  return { kind: "general", subjectTerms };
}

// --- Lists in narrated text --------------------------------------------------

const MAX_ITEM_WORDS = 6;
const MAX_ITEM_CHARS = 48;
/** A piece that starts like a clause is the sentence going on, not another item. */
const CLAUSE_START =
  /^(?:he|she|they|we|i|it|you|that|which|who|whom|when|while|because|but|so|then|if|as|until|although|though|where|after|before)\b/i;
/** Tails that say where an item goes, not what it is. */
const ITEM_TAIL = /\s+(?:on top|on the side|to taste|for good measure|as well|too)$/i;

const NOT_A_THING =
  /^(?:except|oops|well|yes|no|okay|ok|maybe|anyway|however|though|too|also|please|sorry|right|sure|etc|not|never|again|now|here|there|really|actually|obviously|basically)$/i;
const DANGLING_END = /\s(?:our|the|an?|my|your|his|her|their|its|of|to|and|or|with|in|on|at|for|from|by|is|was|are|were)$/i;

function cleanItem(raw: string): string | null {
  const item = raw
    .replace(/^[\s\-–—•*]+/, "")
    .replace(/^(?:and|or|plus|then)\s+/i, "")
    .replace(/^(?:also|finally|of course)\s+/i, "")
    .replace(ITEM_TAIL, "")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();
  if (item.length < 3 || item.length > MAX_ITEM_CHARS) return null;
  if (item.split(/\s+/).length > MAX_ITEM_WORDS) return null;
  if (CLAUSE_START.test(item) || /["“”]/.test(item)) return null;
  // A thing has a noun in it: not a lone aside ("except", "oops") or a phrase left hanging ("took our").
  if (NOT_A_THING.test(item) || DANGLING_END.test(item)) return null;
  return item.charAt(0).toUpperCase() + item.slice(1);
}

/**
 * "raw onions, hot and spicy chili sauce, a pat of butter, and Marshmallow Fluff on top"
 * → the items. Only commas separate items ("hot and spicy" stays whole), except a final
 * "X and Y" without a serial comma. An item cut off by a dash ("and— wait for it") ends
 * the list. Null when fewer than three things are listed.
 */
function splitInlineList(segment: string, after = ""): string[] | null {
  const pieces = segment.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (pieces.length >= 2) {
    const last = pieces[pieces.length - 1];
    if (!/^(?:and|or)\b/i.test(last)) {
      const at = last.toLowerCase().lastIndexOf(" and ");
      if (at > 0) pieces.splice(pieces.length - 1, 1, last.slice(0, at), last.slice(at + 5));
    }
  }
  const items: string[] = [];
  const add = (item: string) => {
    if (!items.some((i) => i.toLowerCase() === item.toLowerCase())) items.push(item);
  };
  for (const piece of pieces) {
    const pause = piece.match(/^(?:and|or)?\s*[-–—]+\s*(.*)$/i);
    if (pause || /^(?:and|or)$/i.test(piece)) {
      const delayed = pause && items.length >= 2 ? itemAfterPause(pause[1], after) : null;
      if (delayed) add(delayed);
      break;
    }
    const item = cleanItem(piece);
    if (!item) {
      if (items.length >= 3) break;
      return null;
    }
    add(item);
  }
  return items.length >= 3 ? items : null;
}

/**
 * A last item held back for effect: "…, a pat of butter, and- Wait for it. Waaaait for
 * it. Marshmallow Fluff." The pause phrase and its repetitions (sentences ending on the
 * same words) are skipped; the next sentence is the item if it is short enough to be one.
 */
function itemAfterPause(pausePhrase: string, after: string): string | null {
  const tail = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/).slice(-2).join(" ");
  const pauseTail = tail(pausePhrase);
  const sentences = after.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  for (const sentence of sentences) {
    if (pauseTail && tail(sentence) === pauseTail) continue;
    return /[.!]$/.test(sentence) ? cleanItem(sentence) : null;
  }
  return null;
}

/** Words after which a comma list is a list of parts. A bare "with" only counts next to the dish. */
const LIST_CUE =
  /\b(?:(with)|made\s+(?:of|from|with|out\s+of)|topped\s+with|filled\s+with|stuffed\s+with|loaded\s+with|consist(?:s|ed|ing)?\s+of|ingredients?(?:\s+(?:are|were|is|was|include[sd]?|list))?|you(?:['’]ll|\s+will)?\s+need)\s*[:\-–—]?\s+/gi;

/** "A cheeseburger, with …" → "Cheeseburger": the thing the list is built on. */
function listBase(before: string): string | null {
  const m = before.match(/(?:^|[.!?:]\s+)(?:an?|the|one)\s+([A-Za-z][\w'’-]*(?:\s+[A-Za-z][\w'’-]*){0,2}),?\s*$/i);
  return m ? cleanItem(m[1]) : null;
}

function inlineLists(text: string, subject: RegExp[]): Array<{ at: number; items: string[] }> {
  const found: Array<{ at: number; items: string[] }> = [];
  for (const m of text.matchAll(LIST_CUE)) {
    const at = m.index ?? 0;
    // The sentence so far. "Mara ate with Joe, Skippy and the others" is company, not a
    // recipe: a bare "with" needs the dish in front of it ("A cheeseburger, with …").
    // Either the dish the question asks about, or "A <thing>, with …".
    const before = text.slice(Math.max(0, at - 90), at).split(/[.!?]\s+/).pop() || "";
    const base = m[1] ? listBase(before) : null;
    // The asked-about dish must stand right in front of the "with" ("his chili with beans, …"),
    // not merely earlier in the sentence ("…the wormholes into position with our railguns, …").
    if (m[1] && !base && !subject.some((re) => re.test(before.slice(-36)))) continue;
    const rest = text.slice(at + m[0].length, at + m[0].length + 400);
    const end = rest.search(/[.!?](?:\s|$)|\n\s*\n|[:(]/);
    const items =
      end === -1 ? splitInlineList(rest.slice(0, 280)) : splitInlineList(rest.slice(0, end), rest.slice(end + 1));
    if (!items) continue;
    found.push({ at, items: base && !items.includes(base) ? [base, ...items] : items });
  }
  return found;
}

/** "1. Flour 2. Eggs 3. Milk" or "1) …" in running order. */
function numberedList(text: string): { at: number; items: string[] } | null {
  const marks = [...text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s+(?=\S)/g)];
  for (let start = 0; start < marks.length; start++) {
    if (Number(marks[start][1]) !== 1) continue;
    const items: string[] = [];
    for (let i = start; i < marks.length && Number(marks[i][1]) === items.length + 1; i++) {
      const from = (marks[i].index ?? 0) + marks[i][0].length;
      const to = i + 1 < marks.length ? marks[i + 1].index ?? text.length : Math.min(text.length, from + 120);
      const line = text.slice(from, to).split(/\n/)[0].replace(/[\s.,;]+$/, "").trim();
      if (!line || line.length > 110) break;
      items.push(line.charAt(0).toUpperCase() + line.slice(1));
    }
    if (items.length >= 3) return { at: marks[start].index ?? 0, items };
  }
  return null;
}

/** Three or more short lines in a row: bulleted, or under a line that ends with a colon. */
function lineList(text: string): { at: number; items: string[] } | null {
  const lines = text.split(/\r?\n/);
  const runs: Array<{ at: number; items: string[] }> = [];
  let offset = 0;
  let run: string[] = [];
  let runAt = 0;
  let open = false;
  const close = () => {
    if (run.length >= 3) runs.push({ at: runAt, items: run });
    run = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-•*]\s+\S/.test(line);
    const item = line && (bullet || open) && !/[.!?:]$/.test(line) ? cleanItem(line) : null;
    if (item) {
      if (!run.length) runAt = offset;
      run.push(item);
    } else {
      close();
      // A heading line ("Ingredients:", "You will need:") opens a list; anything else closes it.
      open = /:$/.test(line);
    }
    offset += raw.length + 1;
  }
  close();
  return runs.sort((x, y) => y.items.length - x.items.length)[0] || null;
}

/** The list a passage gives, preferring real list layout, then the inline list nearest `anchor`. */
function extractListedItems(text: string, anchor: number, subject: RegExp[]): string[] | null {
  const structured = lineList(text) || numberedList(text);
  if (structured) return structured.items.slice(0, 20);
  const inline = inlineLists(text, subject);
  if (!inline.length) return null;
  inline.sort((a, b) => Math.abs(a.at - anchor) - Math.abs(b.at - anchor));
  return inline[0].items.slice(0, 20);
}

/** "He called it the Fluff Screamer." → "Fluff Screamer". */
function extractDishName(text: string): string | null {
  const m = text.match(
    /\b(?:call(?:s|ed|ing)?\s+(?:it|this|that|them|these)|(?:is|was|are|were)\s+called|named\s+(?:it|this|that)|known\s+as|dubbed(?:\s+(?:it|this))?)\s+(?:the\s+|an?\s+)?["“‘']?([A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,3})/
  );
  return m?.[1]?.replace(/['’]$/, "").trim() || null;
}

// --- Finding the passage -----------------------------------------------------

/** The passage shown: a little before the match, more after it (the description follows the name). */
const WINDOW_BEFORE = 220;
const WINDOW_AFTER = 560;
const MAX_ANCHORS_PER_PAGE = 60;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A window of raw text around `index`, cut at word boundaries. */
function rawWindow(text: string, index: number): { text: string; anchor: number } {
  let start = Math.max(0, index - WINDOW_BEFORE);
  let end = Math.min(text.length, index + WINDOW_AFTER);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < index) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > index) end = space;
  }
  return { text: text.slice(start, end), anchor: index - start };
}

function resolveBookScope(bookId: string): ReturnType<typeof listBooks> {
  if (bookId.startsWith("series:")) {
    const seriesId = bookId.slice("series:".length);
    const series = listSeries().find((s) => s.id === seriesId);
    if (!series) return listBooks();
    return listBooks().filter((b) => series.bookIds.includes(b.id));
  }
  if (bookId !== "all") {
    const one = getBookById(bookId);
    return one ? [one] : [];
  }
  return listBooks();
}

/**
 * A question word as it may appear in the text: plural, or (from five letters) inside a
 * longer word, so "burger" finds "cheeseburger" without a list of dishes.
 */
function termPattern(term: string): string {
  const t = escapeRegex(term);
  return term.length >= 5 ? `\\b\\w*${t}\\w*` : `\\b${t}(?:e?s)?\\b`;
}

/**
 * Recipe questions: the passage that best matches the question's content words, with
 * extra weight when it actually lists things or names the dish. One hit per page.
 */
function findRecipePassages(terms: string[], books: ReturnType<typeof listBooks>): SmartPassageHit[] {
  // No dish in the question ("is there a recipe in here?"): look for the word itself.
  const anchors = terms.length ? terms : ["recipe", "ingredients"];
  const termRes = anchors.map((t) => new RegExp(termPattern(t), "i"));
  const subjectRes = terms.length ? termRes : [];
  const anyTerm = new RegExp(anchors.map(termPattern).join("|"), "gi");
  const phrase = terms.length > 1 ? new RegExp(terms.map(escapeRegex).join("[\\s-]+"), "i") : null;
  const hits: SmartPassageHit[] = [];

  for (const book of books) {
    const pages = loadBookPages(book.id);
    if (!pages) continue;
    for (const page of pages) {
      let best: SmartPassageHit | null = null;
      let lastScored = -Infinity;
      let seen = 0;
      for (const m of page.text.matchAll(anyTerm)) {
        const index = m.index ?? 0;
        // Overlapping windows say the same thing.
        if (index - lastScored < WINDOW_BEFORE) continue;
        if (++seen > MAX_ANCHORS_PER_PAGE) break;
        lastScored = index;
        const win = rawWindow(page.text, index);
        const matched = termRes.filter((re) => re.test(win.text)).length;
        const reasons = [`${matched}/${anchors.length} words`];
        let score = matched * 4;
        if (phrase?.test(win.text)) {
          score += 4;
          reasons.push("phrase");
        }
        const items = extractListedItems(win.text, win.anchor, subjectRes);
        if (items) {
          score += 6 + Math.min(items.length, 6);
          reasons.push("list");
        }
        if (terms.length && /\b(?:recipe|ingredients?)\b/i.test(win.text)) {
          score += 2;
          reasons.push("recipe-word");
        }
        const name = items ? extractDishName(win.text) : null;
        if (name) {
          score += 2;
          reasons.push("named");
        }
        if (!best || score > best.score) {
          best = {
            bookId: book.id,
            bookTitle: book.title,
            label: page.label,
            snippet: collapse(win.text),
            score,
            reason: reasons.join("+"),
            aboutAll: matched === anchors.length && (!phrase || phrase.test(win.text)),
            ...(items ? { items } : {}),
            ...(name ? { name } : {}),
          };
        }
      }
      if (best) hits.push(best);
    }
  }
  return hits;
}

/**
 * Smart passage finder. Recipe questions ("X recipe", "how do you make X", "ingredients
 * of X") scan the stored pages for the passage about X and pull out what it lists;
 * other finds are a scored keyword search.
 */
export function findSmartPassages(opts: {
  question: string;
  bookId?: string;
  maxHits?: number;
}): SmartPassageHit[] {
  const intent = classifyPassageFindIntent(opts.question);
  const maxHits = opts.maxHits ?? 8;
  const bookId = opts.bookId || "all";
  const hits: SmartPassageHit[] = [];

  if (intent.kind === "recipe") {
    hits.push(...findRecipePassages(intent.subjectTerms, resolveBookScope(bookId)));
  } else {
    const terms = intent.subjectTerms.length ? intent.subjectTerms : [opts.question];
    const raw =
      bookId.startsWith("series:")
        ? searchSeriesKeyword(bookId.slice("series:".length), terms, 40)
        : bookId !== "all"
          ? searchBookKeyword(bookId, terms, 40).map((m) => ({
              ...m,
              bookId,
              bookTitle: getBookById(bookId)?.title || "",
            }))
          : searchAllBooksKeyword(terms, 50);

    for (const m of raw) {
      const lower = m.snippet.toLowerCase();
      let score = 1;
      for (const t of intent.subjectTerms) {
        if (lower.includes(t.toLowerCase())) score += 2;
      }
      hits.push({
        bookId: (m as { bookId?: string }).bookId || "",
        bookTitle: m.bookTitle,
        label: m.label,
        snippet: m.snippet,
        score,
        reason: "keyword",
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);

  const out: SmartPassageHit[] = [];
  const perBook = new Map<string, number>();
  const seenSnips = new Set<string>();

  for (const hit of hits) {
    const bookKey = hit.bookId || hit.bookTitle;
    const count = perBook.get(bookKey) || 0;
    if (count >= 2) continue;
    const snipKey = hit.snippet.slice(0, 120).toLowerCase();
    if (seenSnips.has(snipKey)) continue;
    seenSnips.add(snipKey);
    perBook.set(bookKey, count + 1);
    out.push(hit);
    if (out.length >= maxHits) break;
  }

  return out;
}

const titleCase = (words: string[]) => words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/**
 * Short answer for the chat bubble. Sources carry the clickable references.
 * A recipe question gets a card (name + listed items) when the passage lists items,
 * and the passage itself when it doesn't.
 */
export function formatPassageFindAnswer(opts: {
  question: string;
  hits: SmartPassageHit[];
}): string {
  const intent = classifyPassageFindIntent(opts.question);
  if (!opts.hits.length) {
    if (intent.kind === "recipe" && intent.subjectTerms.length) {
      return `I couldn’t find a passage about **${intent.subjectTerms.join(" ")}** in your indexed books.`;
    }
    return "I couldn’t find a clear match in your indexed books.";
  }

  const top = opts.hits[0];
  const book = cleanBookDisplayTitle(top.bookTitle);
  const from = `From **${book} · ${top.label}**. Open **Sources** below to read the passage.`;

  if (intent.kind === "recipe" && top.items?.length) {
    const title = top.name || (intent.subjectTerms.length ? titleCase(intent.subjectTerms) : "Recipe");
    return [`**${title}**`, "", ...top.items.map((item) => `- ${item}`), "", from].join("\n");
  }

  return [top.snippet.slice(0, 600).trim(), "", from].join("\n");
}
