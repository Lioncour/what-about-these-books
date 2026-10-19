import { simplifyTitleForLookup, normalizeSeriesKey } from "@/lib/series-detection";

/**
 * Official / publication reading orders for well-known series.
 * Numbers follow the author's labeling (novellas as .5).
 */
const KNOWN_SERIES_ORDERS: Record<string, Array<{ re: RegExp; order: number }>> = {
  "expeditionary force": [
    { re: /columbus\s+day/i, order: 1 },
    { re: /spec\s*ops/i, order: 2 },
    { re: /trouble\s+on\s+paradise/i, order: 3.5 },
    { re: /\bparadise\b/i, order: 3 },
    { re: /black\s+ops/i, order: 4 },
    { re: /zero\s+hour/i, order: 5 },
    { re: /\bmavericks\b/i, order: 6 },
    { re: /renegades/i, order: 7 },
    // Mavericks spin-off — chronologically after Renegades (Alanson FAQ)
    { re: /deathtrap/i, order: 7.25 },
    { re: /homefront/i, order: 7.5 },
    { re: /armageddon/i, order: 8 },
    { re: /valkyrie/i, order: 9 },
    { re: /freefall/i, order: 9.5 },
    { re: /critical\s+mass/i, order: 10 },
    { re: /brushfire/i, order: 11 },
    { re: /breakaway/i, order: 12 },
    { re: /\bfallout\b/i, order: 13 },
    { re: /match\s+game/i, order: 14 },
    { re: /failure\s+mode/i, order: 15 },
    { re: /aftermath/i, order: 16 },
    { re: /task\s+force\s+hammer/i, order: 17 },
    { re: /\bgateway\b/i, order: 18 },
    { re: /ground\s+state/i, order: 19 },
  ],
};

export type BookOrderHints = {
  title: string;
  filename?: string;
  author?: string;
  seriesName?: string | null;
  /** Already stored on the catalog entry */
  seriesOrder?: number | null;
  isbn?: string | null;
  publishedYear?: number | null;
};

/** Pull an explicit Book N / #N from title or filename. */
export function extractExplicitBookNumber(title: string, filename = ""): number | null {
  const blob = `${title} ${filename}`;

  const bookN = blob.match(/\b(?:book|volume|vol\.?)\s*#?\s*(\d{1,2})(?:\.(\d+))?\b/i);
  if (bookN?.[1]) {
    const whole = Number(bookN[1]);
    const frac = bookN[2] ? Number(`0.${bookN[2]}`) : 0;
    if (whole >= 1 && whole <= 40) return whole + frac;
  }

  const hash = blob.match(/#\s*(\d{1,2})(?:\.(\d+))?\b/);
  if (hash?.[1]) {
    const whole = Number(hash[1]);
    const frac = hash[2] ? Number(`0.${hash[2]}`) : 0;
    if (whole >= 1 && whole <= 40) return whole + frac;
  }

  // Leading "9 Valkyrie"
  const leading = blob.match(/^\s*(\d{1,2})(?:\.(\d+))?\s+[A-Za-z]/);
  if (leading?.[1]) {
    const whole = Number(leading[1]);
    if (whole >= 1 && whole <= 40) {
      const frac = leading[2] ? Number(`0.${leading[2]}`) : 0;
      return whole + frac;
    }
  }

  return null;
}

export function lookupKnownSeriesOrder(
  title: string,
  filename = "",
  seriesName?: string | null
): number | null {
  const blob = `${title} ${filename}`;
  const keys = new Set<string>();
  if (seriesName) keys.add(normalizeSeriesKey(seriesName));
  // Always try EF map when title smells like it
  if (/expeditionary|columbus\s+day|skippy|alanson/i.test(blob) || /expeditionary/i.test(seriesName || "")) {
    keys.add("expeditionary force");
  }

  for (const key of keys) {
    const rules = KNOWN_SERIES_ORDERS[key];
    if (!rules) continue;
    for (const rule of rules) {
      if (rule.re.test(blob)) return rule.order;
    }
  }
  return null;
}

/**
 * Best local order for a book: stored value → explicit Book N → known series map.
 */
export function resolveLocalSeriesOrder(hints: BookOrderHints): number | null {
  if (hints.seriesOrder != null && Number.isFinite(hints.seriesOrder)) {
    return hints.seriesOrder;
  }
  const explicit = extractExplicitBookNumber(hints.title, hints.filename || "");
  if (explicit != null) return explicit;
  return lookupKnownSeriesOrder(hints.title, hints.filename || "", hints.seriesName);
}

/** @deprecated Prefer resolveLocalSeriesOrder — kept for older call sites. */
export function extractSeriesBookNumber(title: string, filename = ""): number | null {
  return resolveLocalSeriesOrder({ title, filename });
}

export function formatSeriesOrderLabel(order: number | null | undefined): string | null {
  if (order == null || !Number.isFinite(order)) return null;
  if (Number.isInteger(order)) return `Book ${order}`;
  return `Book ${order}`;
}

export type EditionMeta = {
  isbn?: string;
  publishedYear?: number;
  openLibraryWorkKey?: string;
};

const OL_SEARCH = "https://openlibrary.org/search.json";
const editionCache = new Map<string, EditionMeta | null>();

function editionCacheKey(title: string, author?: string): string {
  return `${title.toLowerCase().trim()}|${(author || "").toLowerCase().trim()}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "WhatAboutThisBook/0.1 (local library companion; edition lookup)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Look up ISBN + first publish year from Open Library (helps sort unknown series).
 */
export async function lookupEditionMetaFromOpenLibrary(
  title: string,
  author?: string
): Promise<EditionMeta | null> {
  const cleaned = simplifyTitleForLookup(title, author) || title;
  const key = editionCacheKey(cleaned, author);
  if (editionCache.has(key)) return editionCache.get(key) ?? null;

  const params = new URLSearchParams();
  params.set("title", cleaned);
  if (author?.trim()) params.set("author", author.trim());
  params.set("limit", "5");
  params.set("fields", "key,title,isbn,first_publish_year,author_name");

  const search = await fetchJson<{
    docs?: Array<{
      key?: string;
      title?: string;
      isbn?: string[];
      first_publish_year?: number;
    }>;
  }>(`${OL_SEARCH}?${params.toString()}`);

  const docs = search?.docs || [];
  if (!docs.length) {
    editionCache.set(key, null);
    return null;
  }

  const titleNorm = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const ranked = [...docs].sort((a, b) => {
    const score = (t: string) => {
      const n = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return n === titleNorm ? 0 : n.includes(titleNorm) || titleNorm.includes(n) ? 1 : 2;
    };
    return score(a.title || "") - score(b.title || "");
  });

  const best = ranked[0];
  const meta: EditionMeta = {
    isbn: best.isbn?.find((x) => x.replace(/\D/g, "").length >= 10),
    publishedYear: best.first_publish_year,
    openLibraryWorkKey: best.key,
  };
  editionCache.set(key, meta);
  return meta;
}

export function compareSeriesBooks(
  a: { order: number | null; year?: number | null; title: string },
  b: { order: number | null; year?: number | null; title: string }
): number {
  const ao = a.order ?? 9999;
  const bo = b.order ?? 9999;
  if (ao !== bo) return ao - bo;
  const ay = a.year ?? 9999;
  const by = b.year ?? 9999;
  if (ay !== by) return ay - by;
  return a.title.localeCompare(b.title);
}
