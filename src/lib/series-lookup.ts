import {
  cleanSeriesDisplayName,
  detectSeriesName,
  preferSeriesDisplayName,
  simplifyTitleForLookup,
} from "@/lib/series-detection";

const OL_SEARCH = "https://openlibrary.org/search.json";
const OL_BASE = "https://openlibrary.org";

type OlSearchDoc = {
  key?: string;
  title?: string;
  author_name?: string[];
};

type OlWork = {
  title?: string;
  subjects?: string[];
};

const lookupCache = new Map<string, string | null>();

function cacheKey(title: string, author?: string): string {
  return `${title.toLowerCase().trim()}|${(author || "").toLowerCase().trim()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seriesFromSubjects(subjects: string[] | undefined): string | null {
  if (!subjects?.length) return null;
  for (const subject of subjects) {
    const m = subject.match(/^series:\s*(.+)$/i);
    if (m?.[1]) {
      const cleaned = cleanSeriesDisplayName(m[1].trim());
      if (cleaned) return cleaned;
    }
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "WhatAboutThisBook/0.1 (local library companion; series lookup)",
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
 * Look up series via Open Library (subjects often include `series:Name`).
 */
export async function lookupSeriesFromOpenLibrary(
  title: string,
  author?: string
): Promise<string | null> {
  const cleanedTitle = simplifyTitleForLookup(title, author);
  const key = cacheKey(cleanedTitle || title, author);
  if (lookupCache.has(key)) return lookupCache.get(key) ?? null;

  const queries: Array<{ title?: string; author?: string; q?: string }> = [];
  if (cleanedTitle) {
    queries.push({ title: cleanedTitle, author: author?.trim() || undefined });
    queries.push({ q: [cleanedTitle, author].filter(Boolean).join(" ") });
  }
  queries.push({ q: [title, author].filter(Boolean).join(" ") });

  for (const query of queries) {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.title) params.set("title", query.title);
    if (query.author) params.set("author", query.author);
    params.set("limit", "5");

    const search = await fetchJson<{ docs?: OlSearchDoc[] }>(`${OL_SEARCH}?${params.toString()}`);
    const docs = search?.docs || [];
    if (!docs.length) continue;

    const titleNorm = (cleanedTitle || title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const ranked = [...docs].sort((a, b) => {
      const at = (a.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const bt = (b.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const score = (t: string) =>
        t === titleNorm ? 0 : t.includes(titleNorm) || titleNorm.includes(t) ? 1 : 2;
      return score(at) - score(bt);
    });

    for (const doc of ranked.slice(0, 3)) {
      if (!doc.key) continue;
      const work = await fetchJson<OlWork>(`${OL_BASE}${doc.key}.json`);
      const series = seriesFromSubjects(work?.subjects);
      if (series) {
        lookupCache.set(key, series);
        return series;
      }
      await sleep(100);
    }
  }

  lookupCache.set(key, null);
  return null;
}

export type SeriesHint = {
  name: string;
  source: "local" | "openlibrary" | "merged";
};

/**
 * Best-effort series name: local heuristics first, then Open Library.
 */
export async function resolveSeriesName(params: {
  filename: string;
  title: string;
  author?: string;
  allowRemote?: boolean;
}): Promise<SeriesHint | null> {
  const local = detectSeriesName(params.filename, params.title, params.author);
  let remote: string | null = null;
  if (params.allowRemote !== false) {
    remote = await lookupSeriesFromOpenLibrary(params.title, params.author);
  }

  if (local && remote) {
    const name = preferSeriesDisplayName(local, remote);
    return { name, source: "merged" };
  }
  if (remote) return { name: remote, source: "openlibrary" };
  if (local) return { name: local, source: "local" };
  return null;
}
