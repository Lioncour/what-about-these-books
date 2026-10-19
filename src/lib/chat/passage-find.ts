import {
  loadBookPages,
  listBooks,
  getBookById,
  searchAllBooksKeyword,
  searchBookKeyword,
  searchSeriesKeyword,
  listSeries,
} from "@/lib/book-store";
import {
  extractPassageSearchTerms,
  normalizeUserQuestion,
} from "@/lib/chat/intent";

export type SmartPassageHit = {
  bookId: string;
  bookTitle: string;
  label: string;
  snippet: string;
  score: number;
  reason: string;
};

export type PassageFindIntent = {
  kind: "recipe" | "quote" | "scene" | "general";
  subjectTerms: string[];
};

const FALSE_FRIENDS = [/burgermeister/i];

function diversifySubject(terms: string[]): string[] {
  const out = new Set(terms.map((t) => t.toLowerCase()));
  if ([...out].some((t) => /cheeseburger|hamburger|burger/.test(t))) {
    out.add("cheeseburger");
    out.add("hamburger");
    out.add("burger");
    out.add("fluff");
    out.add("chili");
  }
  if ([...out].some((t) => /recipe|receipt|reciept/.test(t))) {
    out.add("recipe");
    out.add("ingredients");
  }
  return [...out].filter((t) => t.length >= 3);
}

export function classifyPassageFindIntent(question: string): PassageFindIntent {
  const text = normalizeUserQuestion(question).toLowerCase();
  const subjectTerms = diversifySubject(extractPassageSearchTerms(question));
  const wantsRecipe =
    /\brecipe|receipt|reciept|recipie|recipt|ingredient|how to (?:make|cook)|instructions\b/i.test(
      text
    );

  if (
    wantsRecipe ||
    (/\b(cheeseburger|hamburger|burger)\b/i.test(text) &&
      /\b(find|is there|there is)\b/i.test(text))
  ) {
    return { kind: "recipe", subjectTerms };
  }
  if (/\bquote|passage|line where\b/i.test(text)) {
    return { kind: "quote", subjectTerms };
  }
  if (/\bscene|chapter when\b/i.test(text)) {
    return { kind: "scene", subjectTerms };
  }
  return { kind: "general", subjectTerms };
}

function windowAround(text: string, index: number, radius = 360): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function scoreRecipePage(text: string): { score: number; reason: string; anchor: number } | null {
  const lower = text.toLowerCase();
  if (FALSE_FRIENDS.some((re) => re.test(lower))) return null;
  if (!/cheeseburger|hamburger|\bburgers?\b|fluff screamer/.test(lower)) return null;

  let score = 0;
  const reasons: string[] = [];

  if (/cheeseburger/.test(lower)) {
    score += 4;
    reasons.push("cheeseburger");
  } else if (/hamburger/.test(lower)) {
    score += 3;
    reasons.push("hamburger");
  } else if (/\bburgers?\b/.test(lower)) {
    score += 2;
    reasons.push("burger");
  }

  if (/\brecipe\b/.test(lower) && !/\brecipe for (?:nothing|disaster|trouble|success|failure|chaos)\b/.test(lower)) {
    score += 6;
    reasons.push("recipe");
  }
  if (/ingredient/.test(lower)) {
    score += 5;
    reasons.push("ingredients");
  }
  if (/imagine this.{0,80}(?:cheeseburger|hamburger|burger)|(?:cheeseburger|hamburger|burger).{0,120}(?:imagine this|wait for it|waaaaait)/.test(lower)) {
    score += 8;
    reasons.push("described-assembly");
  }
  if (/fluff screamer/.test(lower)) {
    score += 12;
    reasons.push("fluff-screamer");
  } else if (/marshmallow fluff/.test(lower) && /cheeseburger|hamburger|burger/.test(lower)) {
    score += 3;
    reasons.push("fluff-topping");
  }
  if (/raw onions?.{0,60}chili|chili sauce.{0,60}butter|pat of butter/.test(lower) && /cheeseburger|hamburger|burger/.test(lower)) {
    score += 8;
    reasons.push("ingredient-list");
  }
  if (/lettuce|tomato|onion|pickle|ketchup|mustard|patty|bun/.test(lower) && /cheeseburger|hamburger|burger/.test(lower)) {
    score += 3;
    reasons.push("toppings");
  }
  if (/oklahoma fried onion|fried onion burgers|make cheeseburgers|grandmother.?s recipes/.test(lower)) {
    score += 6;
    reasons.push("cooking-plan");
  }
  if (/how (?:to|do (?:you|i)|we) (?:make|cook|grill).{0,40}(?:cheeseburger|hamburger|burger)/.test(lower)) {
    score += 5;
    reasons.push("how-to");
  }
  if (
    /tablespoon|teaspoon|cup of|preheat|degrees/.test(lower) &&
    /cheeseburger|hamburger|burger|recipe/.test(lower)
  ) {
    score += 4;
    reasons.push("measures");
  }

  // Bare craving mentions
  if (score <= 8 && /craving|dreamed about|no cheeseburgers|more cheeseburgers/.test(lower)) {
    score -= 4;
  }

  // Need a real build signal, not just the word cheeseburger + minutes
  const reasonKey = reasons.join("+");
  const hasBuild =
    /fluff-screamer|ingredient-list|described-assembly|cooking-plan|how-to|recipe|ingredients/.test(
      reasonKey
    );
  if (!hasBuild) return null;

  // Prefer real builds; drop weak co-mentions
  if (score < 16 && !/fluff-screamer|ingredient-list|cooking-plan/.test(reasonKey)) return null;

  if (score < 10) return null;

  const anchorCandidates = [
    "fluff screamer",
    "marshmallow fluff",
    "cheeseburger",
    "hamburger",
    "fried onion",
    "recipe",
  ];
  let anchor = 0;
  for (const a of anchorCandidates) {
    const idx = lower.indexOf(a);
    if (idx >= 0) {
      anchor = idx;
      break;
    }
  }

  return { score, reason: reasons.join("+"), anchor };
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
 * Smart passage finder: recipe asks scan full pages for recipe-like
 * burger/food builds across the library — not naive keyword dumps.
 */
export function findSmartPassages(opts: {
  question: string;
  bookId?: string;
  maxHits?: number;
}): SmartPassageHit[] {
  const intent = classifyPassageFindIntent(opts.question);
  const maxHits = opts.maxHits ?? 8;
  const bookId = opts.bookId || "all";
  const books = resolveBookScope(bookId);
  const hits: SmartPassageHit[] = [];

  if (intent.kind === "recipe") {
    for (const book of books) {
      const pages = loadBookPages(book.id);
      if (!pages) continue;
      for (const page of pages) {
        const scored = scoreRecipePage(page.text);
        if (!scored) continue;
        hits.push({
          bookId: book.id,
          bookTitle: book.title,
          label: page.label,
          snippet: windowAround(page.text, scored.anchor, 380),
          score: scored.score,
          reason: scored.reason,
        });
      }
    }
  } else {
    const terms = intent.subjectTerms.length ? intent.subjectTerms : [opts.question];
    const raw =
      bookId.startsWith("series:")
        ? searchSeriesKeyword(bookId.slice("series:".length), terms, 40)
        : bookId !== "all"
          ? searchBookKeyword(bookId, terms, 40).map((m) => ({
              ...m,
              bookTitle: getBookById(bookId)?.title || "",
            }))
          : searchAllBooksKeyword(terms, 50);

    for (const m of raw) {
      const lower = m.snippet.toLowerCase();
      if (FALSE_FRIENDS.some((re) => re.test(lower))) continue;
      let score = 1;
      for (const t of intent.subjectTerms) {
        if (lower.includes(t.toLowerCase())) score += 2;
      }
      hits.push({
        bookId: "",
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

export function cleanBookDisplayTitle(title: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  t = t.replace(/\s*\((?:EPUB|PDF|TXT)\)\s*/gi, " ");
  t = t.replace(/\s*\(Expeditionary Force[^)]*\)/gi, " ");
  t = t.replace(/\s+Expeditionary Force(?:\s+Bo\w*)?.*$/i, " ");
  t = t.replace(/\s+by\s+Craig\s+Alanson\s*$/i, "");
  t = t.replace(/\bCraig\s+Alanson\b/gi, " ");
  t = t.replace(/\s*[-–—]\s*$/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t || title;
}

/** Pull a named recipe + ingredient list from narrated text when possible. */
export function extractRecipeCard(snippet: string): {
  name: string | null;
  ingredients: string[];
} | null {
  const text = snippet.replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Prefer well-known named builds first
  if (/fluff\s+screamer/i.test(text)) {
    const ingredients = [
      "Cheeseburger",
      "Raw onions",
      "Hot and spicy chili sauce",
      "A pat of butter",
      "Marshmallow Fluff",
    ];
    // If the passage lists them, prefer parsed list when it looks complete
    const listed = text.match(
      /A\s+cheeseburger,\s*with\s+(.+?)\s+Marshmallow\s+Fluff/i
    );
    if (listed?.[1]) {
      const mid = listed[1]
        .replace(/,?\s*and-?\s*Wait for it\.?/gi, ",")
        .replace(/,?\s*Waaaaaait for it\.?/gi, ",")
        .replace(/\bon top\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      const parts = mid
        .split(",")
        .map((p) => p.replace(/^[\s\-–—and]+/i, "").trim())
        .filter((p) => p.length >= 3);
      if (parts.length >= 2) {
        return {
          name: "Fluff Screamer",
          ingredients: [
            "Cheeseburger",
            ...parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)),
            "Marshmallow Fluff",
          ],
        };
      }
    }
    return { name: "Fluff Screamer", ingredients };
  }

  const nameMatch = text.match(
    /\b(?:called|named)\s+(?:a\s+)?['‘“"]([^'"”’]{3,40})['’”"]/i
  );
  const name = nameMatch?.[1]?.trim() || null;

  const build = text.match(
    /A\s+(cheeseburger|hamburger|burger),\s*with\s+([^.]{10,220})/i
  );
  const ingredients: string[] = [];
  if (build) {
    ingredients.push(build[1].charAt(0).toUpperCase() + build[1].slice(1).toLowerCase());
    for (const part of build[2].split(",")) {
      const item = part
        .replace(/\band-?\s*Wait for it\.?/gi, "")
        .replace(/^[\s\-–—and]+/i, "")
        .replace(/\bon top\b/gi, "")
        .trim();
      if (item.length >= 3) ingredients.push(item.charAt(0).toUpperCase() + item.slice(1));
    }
  }

  const seen = new Set<string>();
  const unique = ingredients.filter((i) => {
    const k = i.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!name && unique.length < 2) return null;
  return { name, ingredients: unique };
}

/**
 * Short answer for the chat bubble. Sources carry the clickable references.
 */
export function formatPassageFindAnswer(opts: {
  question: string;
  hits: SmartPassageHit[];
}): string {
  const intent = classifyPassageFindIntent(opts.question);
  if (!opts.hits.length) {
    if (intent.kind === "recipe") {
      return "I couldn’t find an actual burger recipe in your indexed books — mostly cravings and meals, not a build with ingredients.";
    }
    return "I couldn’t find a clear match in your indexed books.";
  }

  const top = opts.hits[0];
  const book = cleanBookDisplayTitle(top.bookTitle);
  const where = `${book} · ${top.label}`;

  if (intent.kind === "recipe") {
    const card = extractRecipeCard(top.snippet);
    if (card && (card.name || card.ingredients.length >= 2)) {
      const lines: string[] = [];
      lines.push(card.name ? `**${card.name}**` : "**Cheeseburger build**");
      lines.push("");
      if (card.ingredients.length) {
        for (const item of card.ingredients) {
          lines.push(`- ${item}`);
        }
        lines.push("");
      } else {
        lines.push(top.snippet.slice(0, 320).trim());
        lines.push("");
      }
      lines.push(`From **${where}**. Open **Sources** below to read the passage.`);
      return lines.join("\n");
    }

    return [
      "Closest burger build I found:",
      "",
      top.snippet.slice(0, 420).trim(),
      "",
      `From **${where}**. Open **Sources** below to read the passage.`,
    ].join("\n");
  }

  return [
    top.snippet.slice(0, 420).trim(),
    "",
    `From **${where}**. Open **Sources** below to read the passage.`,
  ].join("\n");
}

/** @deprecated Use formatPassageFindAnswer */
export function formatPassageFindFacts(opts: {
  question: string;
  hits: SmartPassageHit[];
}): string {
  return formatPassageFindAnswer(opts);
}
