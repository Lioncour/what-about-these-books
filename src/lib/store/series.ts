/** Series grouping: manual edits, the reconcile pass, and duplicate-book merging. */
import { InvalidIdError, isValidSeriesId } from "@/lib/runtime-config";
import {
  cleanSeriesDisplayName,
  normalizeSeriesKey,
  preferSeriesDisplayName,
  seriesKeyOf,
  seriesKeysMatch,
} from "@/lib/series-detection";
import { resolveSeriesName } from "@/lib/series-lookup";
import {
  compareSeriesBooks,
  lookupEditionMetaFromOpenLibrary,
  resolveLocalSeriesOrder,
} from "@/lib/series-order";
import {
  getBookById,
  getSeriesForBook,
  listSeries,
  loadCatalog,
  normalizeAuthorKey,
  normalizeIdentity,
  saveCatalog,
  type BookEntry,
  type SeriesEntry,
} from "./catalog";
import { deleteBook } from "./vector-index";

export function saveSeries(entry: { id?: string; name: string; bookIds: string[] }): SeriesEntry {
  const catalog = loadCatalog();
  const normalizedBookIds = [...new Set(entry.bookIds)];
  const requestedName = cleanSeriesDisplayName(entry.name.trim()) || entry.name.trim();
  const requestedKey = normalizeSeriesKey(requestedName);
  const sameNameExisting = catalog.series.find((s) => {
    if (s.id === entry.id) return false;
    const key = seriesKeyOf(s.name);
    return key === requestedKey || seriesKeysMatch(key, requestedKey);
  });

  if (!entry.id && sameNameExisting) {
    sameNameExisting.name = preferSeriesDisplayName(sameNameExisting.name, requestedName);
    sameNameExisting.bookIds = [...new Set([...sameNameExisting.bookIds, ...normalizedBookIds])];
    for (const book of catalog.books) {
      if (sameNameExisting.bookIds.includes(book.id)) {
        book.seriesId = sameNameExisting.id;
      }
    }
    saveCatalog(catalog);
    return sameNameExisting;
  }

  if (entry.id) {
    const existing = catalog.series.find((s) => s.id === entry.id);
    if (existing) {
      existing.name = requestedName;
      existing.bookIds = normalizedBookIds;
      for (const book of catalog.books) {
        if (normalizedBookIds.includes(book.id)) {
          book.seriesId = existing.id;
        } else if (book.seriesId === existing.id) {
          book.seriesId = undefined;
        }
      }
      saveCatalog(catalog);
      return existing;
    }
  }

  const created: SeriesEntry = {
    id: `series-${Date.now()}`,
    name: requestedName,
    bookIds: normalizedBookIds,
    createdAt: new Date().toISOString(),
  };
  catalog.series.push(created);
  for (const book of catalog.books) {
    if (normalizedBookIds.includes(book.id)) {
      book.seriesId = created.id;
    }
  }
  saveCatalog(catalog);
  return created;
}

/**
 * The existing series a detected name belongs to: same normalized key, or one key
 * containing the other ("Expeditionary Force" vs "Expeditionary Force Saga").
 */
export function findSeriesByName(name: string): SeriesEntry | null {
  const key = seriesKeyOf(name);
  return listSeries().find((s) => {
    const sk = seriesKeyOf(s.name);
    return sk === key || seriesKeysMatch(sk, key);
  }) ?? null;
}

/**
 * Series that already holds at least two books by this author (the one with the most),
 * for uploads whose name gives no series hint. One pass over the catalog.
 */
export function inferSeriesIdFromAuthor(author?: string): string | undefined {
  const authorKey = normalizeAuthorKey(author || "");
  if (!authorKey) return undefined;
  const catalog = loadCatalog();
  const byAuthor = new Set(
    catalog.books.filter((b) => normalizeAuthorKey(b.author || "") === authorKey).map((b) => b.id)
  );
  let best: { id: string; count: number } | null = null;
  for (const s of catalog.series) {
    const count = s.bookIds.reduce((n, id) => n + (byAuthor.has(id) ? 1 : 0), 0);
    if (count > (best?.count ?? 0)) best = { id: s.id, count };
  }
  return best && best.count >= 2 ? best.id : undefined;
}

export function deleteSeries(seriesId: string): void {
  if (!isValidSeriesId(seriesId)) throw new InvalidIdError("series", seriesId);
  const catalog = loadCatalog();
  catalog.series = catalog.series.filter((s) => s.id !== seriesId);
  for (const book of catalog.books) {
    if (book.seriesId === seriesId) {
      book.seriesId = undefined;
    }
  }
  saveCatalog(catalog);
}

export async function reconcileLibrarySeries(opts?: {
  allowRemote?: boolean;
}): Promise<{
  updatedBooks: number;
  createdSeries: number;
  mergedSeries: number;
  removedSeries: number;
  lookedUp: number;
  touchedSeries: number;
  orderedBooks: number;
}> {
  const allowRemote = opts?.allowRemote !== false;
  const catalog = loadCatalog();

  // 1) Resolve a series name per book (local heuristics + optional Open Library).
  const hints = new Map<string, string>(); // bookId -> series display name
  let lookedUp = 0;
  for (const book of catalog.books) {
    const hint = await resolveSeriesName({
      filename: book.filename,
      title: book.title,
      author: book.author,
      allowRemote,
    });
    if (hint) {
      hints.set(book.id, hint.name);
      if (hint.source === "openlibrary" || hint.source === "merged") lookedUp++;
    }
    if (allowRemote) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // 2) Also fold existing series names that are just "Series Book N" / "EPUB" into cleaned keys.
  const groups = new Map<string, { displayName: string; bookIds: Set<string> }>();

  const addToGroup = (name: string, bookId: string) => {
    const cleaned = cleanSeriesDisplayName(name) || name;
    const key = normalizeSeriesKey(cleaned);
    if (!key || key.length < 3) return;
    const existing = groups.get(key);
    if (existing) {
      existing.displayName = preferSeriesDisplayName(existing.displayName, cleaned);
      existing.bookIds.add(bookId);
    } else {
      groups.set(key, { displayName: cleaned, bookIds: new Set([bookId]) });
    }
  };

  for (const book of catalog.books) {
    const fromHint = hints.get(book.id);
    if (fromHint) {
      addToGroup(fromHint, book.id);
      continue;
    }
    // Fall back: if already in a series, try cleaning that series name
    if (book.seriesId) {
      const s = catalog.series.find((x) => x.id === book.seriesId);
      if (s) {
        const cleaned = cleanSeriesDisplayName(s.name);
        if (cleaned) addToGroup(cleaned, book.id);
      }
    }
  }

  // Attach stragglers whose title/filename contains an existing series key
  // (e.g. "Fallout Expeditionary Force Bo..." → Expeditionary Force).
  for (const book of catalog.books) {
    if (hints.has(book.id)) continue;
    const blob = normalizeSeriesKey(`${book.title} ${book.filename}`);
    if (!blob) continue;
    for (const [key, group] of groups) {
      if (key.length < 8) continue;
      if (blob.includes(key) || key.includes(blob.slice(0, Math.min(blob.length, key.length)))) {
        // Prefer real containment of the series key inside the book blob
        if (blob.includes(key)) {
          group.bookIds.add(book.id);
          hints.set(book.id, group.displayName);
          break;
        }
      }
    }
  }

  // Only keep groups with 2+ books as series (solo "series" folders are noise)
  // Exception: if we already had a multi-book series key, keep membership even for growth.
  // Actually user wants all EF books together — even if only 1 matched remote, merge into EF group.
  // Keep groups with >= 1 book if key looks like a real series; drop format garbage.
  for (const [key, group] of [...groups.entries()]) {
    if (/^(epub|pdf|mobi|txt|kindle)$/i.test(group.displayName)) {
      groups.delete(key);
    }
  }

  let updatedBooks = 0;
  let createdSeries = 0;
  let mergedSeries = 0;
  const touchedSeries = new Set<string>();
  const usedSeriesIds = new Set<string>();

  // 3) For each group, find or create a target series (merge by normalized key).
  for (const [, group] of groups) {
    if (group.bookIds.size < 1) continue;

    const groupKey = normalizeSeriesKey(group.displayName);
    const matching = catalog.series.filter((s) => seriesKeyOf(s.name) === groupKey);

    let target: SeriesEntry | undefined = matching.sort((a, b) => b.bookIds.length - a.bookIds.length)[0];
    if (!target) {
      // Also match if any existing series key contains / is contained
      target = catalog.series.find((s) => seriesKeysMatch(seriesKeyOf(s.name), groupKey));
    }

    if (!target) {
      target = {
        id: `series-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: group.displayName,
        bookIds: [],
        createdAt: new Date().toISOString(),
      };
      catalog.series.push(target);
      createdSeries++;
    } else {
      const preferred = preferSeriesDisplayName(target.name, group.displayName);
      if (target.name !== preferred) target.name = preferred;
      if (matching.length > 1) mergedSeries += matching.length - 1;
    }

    touchedSeries.add(target.id);
    usedSeriesIds.add(target.id);

    for (const bookId of group.bookIds) {
      const book = catalog.books.find((b) => b.id === bookId);
      if (!book) continue;
      if (book.seriesId !== target.id) updatedBooks++;
      book.seriesId = target.id;
      if (!target.bookIds.includes(book.id)) target.bookIds.push(book.id);
    }

    // Absorb other matching series into target
    for (const extra of matching) {
      if (extra.id === target.id) continue;
      for (const bookId of extra.bookIds) {
        const book = catalog.books.find((b) => b.id === bookId);
        if (!book) continue;
        book.seriesId = target.id;
        if (!target.bookIds.includes(bookId)) target.bookIds.push(bookId);
      }
      extra.bookIds = [];
    }
  }

  // 4b) Author majority vote: if most of an author's books already sit in one series,
  // pull remaining ungrouped titles by that author into it (covers OL gaps like Gateway).
  const authorSeriesVotes = new Map<string, Map<string, number>>();
  for (const book of catalog.books) {
    const authorKey = normalizeAuthorKey(book.author || "");
    if (!authorKey || !book.seriesId) continue;
    if (!authorSeriesVotes.has(authorKey)) authorSeriesVotes.set(authorKey, new Map());
    const votes = authorSeriesVotes.get(authorKey)!;
    votes.set(book.seriesId, (votes.get(book.seriesId) || 0) + 1);
  }
  for (const book of catalog.books) {
    if (book.seriesId) continue;
    const authorKey = normalizeAuthorKey(book.author || "");
    if (!authorKey) continue;
    const votes = authorSeriesVotes.get(authorKey);
    if (!votes || votes.size === 0) continue;
    const authorBookCount = catalog.books.filter(
      (b) => normalizeAuthorKey(b.author || "") === authorKey
    ).length;
    const [bestSeriesId, bestCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (bestCount >= 3 && bestCount / authorBookCount >= 0.5) {
      book.seriesId = bestSeriesId;
      updatedBooks++;
      const target = catalog.series.find((s) => s.id === bestSeriesId);
      if (target && !target.bookIds.includes(book.id)) target.bookIds.push(book.id);
      touchedSeries.add(bestSeriesId);
    }
  }

  // 5) Rebuild membership lists; resolve series order / ISBN; drop empty / garbage series.
  let orderedBooks = 0;
  for (const book of catalog.books) {
    const series = book.seriesId
      ? catalog.series.find((s) => s.id === book.seriesId)
      : undefined;
    const localOrder = resolveLocalSeriesOrder({
      title: book.title,
      filename: book.filename,
      author: book.author,
      seriesName: series?.name,
      seriesOrder: undefined, // recompute from title/known maps
    });
    if (localOrder != null && book.seriesOrder !== localOrder) {
      book.seriesOrder = localOrder;
      orderedBooks++;
    }

    if (allowRemote && (!book.isbn || !book.publishedYear)) {
      const meta = await lookupEditionMetaFromOpenLibrary(book.title, book.author);
      if (meta) {
        if (meta.isbn && !book.isbn) book.isbn = meta.isbn;
        if (meta.publishedYear && !book.publishedYear) {
          book.publishedYear = meta.publishedYear;
        }
        // If we still have no series order, fall back to publish year as a soft order
        if (book.seriesOrder == null && meta.publishedYear) {
          book.seriesOrder = meta.publishedYear;
          orderedBooks++;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  for (const series of catalog.series) {
    const members = catalog.books.filter((b) => b.seriesId === series.id);
    members.sort((a, b) =>
      compareSeriesBooks(
        { order: a.seriesOrder ?? null, year: a.publishedYear ?? null, title: a.title },
        { order: b.seriesOrder ?? null, year: b.publishedYear ?? null, title: b.title }
      )
    );
    series.bookIds = members.map((b) => b.id);
    const cleaned = cleanSeriesDisplayName(series.name);
    if (cleaned) series.name = cleaned;
  }

  const before = catalog.series.length;
  catalog.series = catalog.series.filter((s) => {
    if (s.bookIds.length === 0) return false;
    if (/^(epub|pdf|mobi|txt|kindle)$/i.test(s.name)) return false;
    return true;
  });
  const removedSeries = before - catalog.series.length;

  // Clear seriesId on books pointing at removed series
  const liveIds = new Set(catalog.series.map((s) => s.id));
  for (const book of catalog.books) {
    if (book.seriesId && !liveIds.has(book.seriesId)) {
      book.seriesId = undefined;
      updatedBooks++;
    }
  }

  // The Open Library calls above can take minutes; books may have been added or removed
  // meanwhile. Re-load and merge only what this pass computed (series membership/order
  // and edition metadata) onto the fresh catalog, never replacing its book list.
  const fresh = loadCatalog();
  const computedBooks = new Map(catalog.books.map((b) => [b.id, b]));
  const freshIds = new Set(fresh.books.map((b) => b.id));
  for (const book of fresh.books) {
    const computed = computedBooks.get(book.id);
    if (!computed) continue; // added meanwhile: keep as is
    book.seriesId = computed.seriesId;
    book.seriesOrder = computed.seriesOrder;
    if (computed.isbn) book.isbn = computed.isbn;
    if (computed.publishedYear) book.publishedYear = computed.publishedYear;
  }
  const mergedSeriesList: SeriesEntry[] = catalog.series.map((s) => ({
    ...s,
    bookIds: s.bookIds.filter((id) => freshIds.has(id)),
  }));
  const mergedIds = new Set(mergedSeriesList.map((s) => s.id));
  for (const s of fresh.series) {
    if (mergedIds.has(s.id)) continue;
    // A series created meanwhile (e.g. by an upload): keep it for the books still pointing at it.
    const members = fresh.books.filter((b) => b.seriesId === s.id).map((b) => b.id);
    if (members.length) mergedSeriesList.push({ ...s, bookIds: members });
  }
  // Books added meanwhile that point at a series this pass absorbed/removed: attach them to
  // the live series with that id if it exists, else leave them unassigned.
  const liveMerged = new Set(mergedSeriesList.map((s) => s.id));
  for (const book of fresh.books) {
    if (computedBooks.has(book.id)) continue;
    if (!book.seriesId) continue;
    if (!liveMerged.has(book.seriesId)) {
      book.seriesId = undefined;
      continue;
    }
    const target = mergedSeriesList.find((s) => s.id === book.seriesId);
    if (target && !target.bookIds.includes(book.id)) target.bookIds.push(book.id);
  }
  fresh.series = mergedSeriesList.filter((s) => s.bookIds.length > 0);

  saveCatalog(fresh);
  return {
    updatedBooks,
    createdSeries,
    mergedSeries,
    removedSeries,
    lookedUp,
    touchedSeries: touchedSeries.size,
    orderedBooks,
  };
}

/** @deprecated Use reconcileLibrarySeries — kept for older callers. */
export async function autoFixSeriesByAuthor(): Promise<{
  updatedBooks: number;
  createdSeries: number;
  touchedSeries: number;
}> {
  const result = await reconcileLibrarySeries({ allowRemote: true });
  return {
    updatedBooks: result.updatedBooks,
    createdSeries: result.createdSeries,
    touchedSeries: result.touchedSeries,
  };
}

export interface DuplicateGroup {
  key: string;
  books: BookEntry[];
}

export function listDuplicateBookGroups(): DuplicateGroup[] {
  const catalog = loadCatalog();
  const groups = new Map<string, BookEntry[]>();
  for (const book of catalog.books) {
    const key = `${normalizeIdentity(book.title)}::${normalizeIdentity(book.author || "")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(book);
  }
  return [...groups.entries()]
    .map(([key, books]) => ({ key, books }))
    .filter((g) => g.books.length > 1);
}

export async function mergeDuplicateBooks(
  primaryBookId: string,
  duplicateBookId: string
): Promise<{ kept: string; removed: string }> {
  if (primaryBookId === duplicateBookId) {
    throw new Error("Cannot merge the same book.");
  }

  const primary = getBookById(primaryBookId);
  const duplicate = getBookById(duplicateBookId);
  if (!primary || !duplicate) {
    throw new Error("Both books must exist to merge.");
  }

  const duplicateSeries = getSeriesForBook(duplicateBookId);
  if (duplicateSeries) {
    saveSeries({
      id: duplicateSeries.id,
      name: duplicateSeries.name,
      bookIds: [...new Set(duplicateSeries.bookIds.map((id) => (id === duplicateBookId ? primaryBookId : id)))],
    });
  }

  await deleteBook(duplicateBookId);
  return { kept: primaryBookId, removed: duplicateBookId };
}
