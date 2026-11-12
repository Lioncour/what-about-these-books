/** Series name heuristics + normalization for library grouping. */

const FORMAT_WORDS = /\b(epub|pdf|mobi|azw3?|txt|kindle|audiobook)\b/i;
const BOOK_NUM_TAIL =
  /\s*[,:\-–—]?\s*(?:book|volume|vol\.?|part|pt\.?|#)\s*#?\d+(?:\.\d+)?\s*$/i;
const BOOK_NUM_INLINE = /\b(?:book|volume|vol\.?|part|pt\.?)\s*#?\d+(?:\.\d+)?\b/gi;

export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

/**
 * Cut a truncated copy of `full` off the end of `t`: filenames are shortened by download
 * sites, so "Failure Mode (Expeditionary For" ends in a prefix of "Expeditionary Force".
 * The fragment must start at a word boundary and reach past the first word of `full`
 * (or follow an opening bracket), so "Children of Dune" keeps its "Dune" in a series
 * called "Dune Chronicles". An opening bracket before the fragment goes with it.
 */
function stripTruncatedTail(t: string, full: string): string {
  const name = full.replace(/\s+/g, " ").trim();
  const lowerName = name.toLowerCase();
  const lower = t.toLowerCase();
  const firstWord = lowerName.split(" ")[0].length;
  for (let len = name.length; len >= 3; len--) {
    const fragment = lowerName.slice(0, len);
    if (fragment.endsWith(" ") || !lower.endsWith(fragment)) continue;
    const at = t.length - len;
    const before = t.slice(0, at);
    const bracketed = /[(\[]\s*$/.test(before);
    if (at > 0 && !/[\s(\[]$/.test(before)) continue;
    if (!bracketed && len <= firstWord + 1) continue;
    return before.replace(/[(\[]\s*$/, "").trimEnd();
  }
  return t;
}

/**
 * Title shown in the library, built at ingest and by the library tidy. Prefers the
 * book's own metadata title; otherwise cleans the filename: format tags, "by" and the
 * author's name in any order, "(Series Book N)" / "Series #N" / "Series Book N" tails,
 * a leading series number ("9 Valkyrie"), tails cut off mid-word ("(Expeditionary For",
 * "Expeditionary Force Bo"), brackets left open, and lower-case-only names.
 */
export function cleanIngestTitle(opts: {
  filename: string;
  metadataTitle?: string | null;
  author?: string | null;
  seriesName?: string | null;
}): string {
  const meta = (opts.metadataTitle || "").replace(/\s+/g, " ").trim();
  if (meta && meta.length >= 2 && !/\.(epub|pdf|txt)$/i.test(meta)) return meta;

  const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
  let t = squeeze(titleFromFilename(opts.filename));
  t = squeeze(t.replace(/[\[(]\s*(?:epub|pdf|txt|mobi|azw3?|kindle|retail|ebook)\s*[\])]/gi, " "));

  // Author first: it usually comes last, and what it leaves at the end is the series tail.
  const author = squeeze((opts.author || "").replace(/,/g, " "));
  if (author) {
    const names = author.split(" ").filter((w) => w.length > 1);
    if (names.length) {
      // "by" + the author's names in any order, as a run ("Craig Alanson", "alanson craig", "Alanson, Craig")
      t = squeeze(
        t.replace(
          new RegExp(
            `(?:\\bby\\s+)?(?:\\b(?:${names.map(escapeRe).join("|")})\\b[\\s,]*){${Math.min(names.length, 2)},}`,
            "gi"
          ),
          " "
        )
      );
      if (names.length >= 2) {
        // A name cut off at the end: "… Craig Alans", "… Alanson Cr"
        for (const order of [names.join(" "), [...names].reverse().join(" ")]) {
          t = stripTruncatedTail(t, order);
        }
      }
      t = squeeze(t.replace(/\bby\s*$/i, " "));
    }
  }

  const series = squeeze(opts.seriesName || "");
  if (series) {
    const words = series.split(" ").map(escapeRe).join("\\s+");
    // "(Expeditionary Force Book 6)", "Expeditionary Force #10", "Expeditionary Force 6",
    // and a "Book" cut off at the end of the name: "Expeditionary Force Bo"
    const number = "(?:book|bk|vol(?:ume)?|#)?\\s*#?\\d+(?:\\.\\d+)?";
    const cutBook = "b(?:o(?:ok?)?)?\\s*#?\\s*[\\])]?\\s*$";
    const before = t;
    t = squeeze(
      t.replace(new RegExp(`[\\[(]?\\s*${words}(?:\\s*(?:,|-|:)?\\s*(?:${number}|${cutBook}))?\\s*[\\])]?`, "gi"), " ")
    );
    if (t === before) t = stripTruncatedTail(t, series);
    // "9 Valkyrie", "03 Paradise": the number in the series, put first by whoever named the file.
    const numbered = /^#?\d{1,2}(?:\.\d)?\s*[.)]?\s+(?=\p{L})/u.exec(t);
    if (numbered) t = t.slice(numbered[0].length);
  }

  t = t.replace(/\b(?:book|bk|vol(?:ume)?)\s*\d+(?:\.\d+)?\b/gi, " ");
  t = t.replace(/\(\s*\)|\[\s*\]/g, " ");
  // A bracket that never closes is a tag the filename lost the end of: "Title (Some Series Bo".
  for (const [open, close] of [["(", ")"], ["[", "]"]]) {
    const at = t.lastIndexOf(open);
    if (at > 0 && !t.includes(close, at) && squeeze(t.slice(0, at))) t = t.slice(0, at);
  }
  // …and a closing bracket whose opening went with the series name.
  if (!/[(\[]/.test(t)) t = t.replace(/[)\]]/g, " ");
  t = t.replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, "").replace(/\s+/g, " ").trim();
  if (t && t === t.toLowerCase()) {
    t = t.replace(/\b([a-z])(\w*)/g, (_m, a: string, rest: string) => a.toUpperCase() + rest);
  }
  return t || titleFromFilename(opts.filename);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTextId(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.(epub|pdf|txt|mobi|azw3?)$/i, "")
    .replace(/\b(book|volume|vol|part|#\d+)\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Canonical key for merging series names that differ only by Book N / punctuation. */
export function normalizeSeriesKey(name: string): string {
  let key = name
    .toLowerCase()
    .replace(/\.(epub|pdf|txt|mobi|azw3?)\b/g, " ")
    .replace(FORMAT_WORDS, " ")
    .replace(BOOK_NUM_INLINE, " ")
    .replace(/#\d+(?:\.\d+)?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  // Truncated "Expeditionary For…" → same bucket as Expeditionary Force
  if (/^expeditionary for\b/.test(key)) {
    key = "expeditionary force";
  }
  return key;
}

/** Human-facing series name: strip trailing Book/Vol numbers and format tags. */
export function cleanSeriesDisplayName(raw: string): string | null {
  let name = raw.trim();
  if (!name) return null;

  name = name.replace(/\.(epub|pdf|mobi|azw3?|txt)\b/gi, " ").trim();
  name = name.replace(/\s*\((?:epub|pdf|mobi|azw3?|txt)\)\s*$/i, "").trim();
  name = name.replace(BOOK_NUM_TAIL, "").trim();
  name = name.replace(/\s*#\d+(?:\.\d+)?\s*$/i, "").trim();
  name = name.replace(BOOK_NUM_INLINE, " ").replace(/\s+/g, " ").trim();

  // Truncation repair
  if (/^expeditionary for\b/i.test(name)) {
    name = "Expeditionary Force";
  }

  if (name.length < 3) return null;
  if (FORMAT_WORDS.test(name) && normalizeSeriesKey(name).length < 3) return null;
  if (/^(epub|pdf|mobi|txt|kindle)$/i.test(name)) return null;
  // Reject filename-like leftovers
  if (/\.(epub|pdf|mobi|txt)$/i.test(name)) return null;
  if (/craig alanson/i.test(name) && /expeditionary/i.test(name)) {
    return "Expeditionary Force";
  }

  return name;
}

function pickClean(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  return cleanSeriesDisplayName(candidate);
}

/**
 * Infer a series name from title/filename patterns.
 * Prefer patterns that survive Book-N stripping so EF Book 6 and EF Book 7 share a name.
 */
export function detectSeriesName(filename: string, title?: string, author?: string): string | null {
  const base = simplifyTitleForLookup(title || titleFromFilename(filename), author);
  const fromEmbedded = detectSeriesNameEmbedded(`${title || ""} ${filename}`);
  if (fromEmbedded) return fromEmbedded;

  // "Expeditionary Force Book 6" / "Expeditionary Force, Book 6 – Title"
  const seriesBookNum = base.match(
    /^(.+?)\s*[,:\-–—]?\s*(?:book|volume|vol\.?|part)\s*#?\d+(?:\.\d+)?\b/i
  );
  if (seriesBookNum?.[1]) {
    const cleaned = pickClean(seriesBookNum[1]);
    if (cleaned) return cleaned;
  }

  // "Title (Expeditionary Force Book 6)" or "Title (Expeditionary Force #6)"
  const paren = base.match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    const cleaned = pickClean(paren[1]);
    if (cleaned) return cleaned;
  }

  // "Series Name: Subtitle" where subtitle is short
  const colonSeries = base.match(/^([^:]+):\s*(.+)$/);
  if (colonSeries?.[1] && colonSeries[2]) {
    const head = pickClean(colonSeries[1]);
    const tail = colonSeries[2].trim();
    // Prefer head when it looks like a series (not a short chapter title)
    if (head && head.split(/\s+/).length >= 2 && head.split(/\s+/).length <= 8) {
      // "Paradise: Expeditionary Force" style — series may be after colon
      const tailAsSeries = pickClean(tail.replace(/#\d+.*$/i, ""));
      if (tailAsSeries && /\bforce|saga|chronicles|trilogy|cycle|series\b/i.test(tailAsSeries)) {
        return tailAsSeries;
      }
      if (!/\b(chapter|episode)\b/i.test(head)) return head;
    }
  }

  // "A - Series Name - B" or "Series - Book 3"
  const dashParts = base.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (dashParts.length >= 3) {
    const mid = pickClean(dashParts[1]);
    if (mid) return mid;
  }
  if (dashParts.length === 2) {
    const first = pickClean(dashParts[0]);
    const second = dashParts[1];
    if (first && /\d/.test(second)) return first;
    // "Expeditionary Force - Columbus Day"
    if (first && first.split(/\s+/).length >= 2 && second.length >= 3) {
      if (/\b(force|saga|chronicles|trilogy|cycle|wars|files)\b/i.test(first)) return first;
    }
  }

  // Subtitle after colon that's clearly a series label
  const subtitle = base.match(/:\s*([^:#]+?)(?:\s*#|\s*$)/);
  if (subtitle?.[1]) {
    const cleaned = pickClean(subtitle[1]);
    if (cleaned && /\b(force|saga|chronicles|trilogy|cycle|series)\b/i.test(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

/** Merge key of a stored series name (display clean-up, then `normalizeSeriesKey`). */
export function seriesKeyOf(name: string): string {
  return normalizeSeriesKey(cleanSeriesDisplayName(name) || name);
}

/**
 * Two series keys name the same series: equal, or one contains the other
 * ("expeditionary force" vs "expeditionary force saga"; both at least 8 characters).
 */
export function seriesKeysMatch(ka: string, kb: string): boolean {
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return ka.length >= 8 && kb.length >= 8 && (ka.includes(kb) || kb.includes(ka));
}

/** Prefer the cleaner / shorter display name when merging. */
export function preferSeriesDisplayName(a: string, b: string): string {
  const ca = cleanSeriesDisplayName(a) || a;
  const cb = cleanSeriesDisplayName(b) || b;
  if (ca.length === cb.length) return ca < cb ? ca : cb;
  return ca.length <= cb.length ? ca : cb;
}

/** Pull a usable book title out of messy filenames / "Author  Title (EPUB)" strings. */
export function simplifyTitleForLookup(title: string, author?: string): string {
  let t = title.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();

  if (author?.trim()) {
    const variants = [
      author.trim(),
      author.trim().replace(/,/g, " "),
      author
        .trim()
        .split(",")
        .map((p) => p.trim())
        .reverse()
        .join(" "),
    ];
    for (const variant of variants) {
      if (variant.length < 3) continue;
      const re = new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "ig");
      t = t.replace(re, " ");
    }
  }

  t = t.replace(/\((?:epub|pdf|mobi|txt)\)/gi, " ");
  t = t.replace(/\([^)]*(?:book|volume|vol\.?|#)\s*#?\d+[^)]*\)/gi, " ");
  t = t.replace(/\([^)]*expeditionary[^)]*\)/gi, " ");
  t = t.replace(/\bby\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * If the title/filename clearly contains a series phrase (even truncated), return it.
 */
function detectSeriesNameEmbedded(text: string): string | null {
  const blob = text.replace(/[_-]+/g, " ");

  // Explicit "Expeditionary Force" (allow truncated "Expeditionary For")
  if (/\bExpeditionary\s+For(ce)?\b/i.test(blob)) {
    return "Expeditionary Force";
  }

  // Generic: "... (Series Name Book N" even without closing paren
  const openParen = blob.match(
    /\(([A-Za-z][^)#\.]{3,50}?)(?:\s*(?:book|volume|vol\.?|#)\s*#?\d+)/i
  );
  if (openParen?.[1]) {
    const cleaned = pickClean(openParen[1]);
    if (cleaned && cleaned.split(/\s+/).length >= 2 && !/craig alanson/i.test(cleaned)) {
      return cleaned;
    }
  }

  return null;
}
