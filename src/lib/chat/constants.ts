/** Max books consulted as specialists for library-wide questions. */
export const MAX_LIBRARY_SPECIALIST_BOOKS = 6;

/** Max books consulted as specialists within a series. */
export const MAX_SERIES_SPECIALIST_BOOKS = 6;

/** Seed passages when ranking which books to consult. */
export const MAX_SPECIALIST_SEED_PASSAGES = 40;

const FAMOUS_LIBRARIANS = [
  "Hypatia",
  "Borges",
  "Dewey",
  "Brewster",
  "Shirley",
  "Panizzi",
  "Ranganathan",
  "Aurelia",
] as const;

function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * One librarian per book, deterministic from the book id, no repeats within the set
 * (linear probing over the roster; past 8 books a numeric suffix keeps them distinct).
 */
export function assignLibrarianNames(bookIds: string[]): Map<string, string> {
  const taken = new Set<number>();
  const out = new Map<string, string>();
  const n = FAMOUS_LIBRARIANS.length;
  for (const id of bookIds) {
    if (out.has(id)) continue;
    let slot = hashSeed(id) % n;
    let probes = 0;
    while (taken.has(slot) && probes < n) {
      slot = (slot + 1) % n;
      probes++;
    }
    const base = FAMOUS_LIBRARIANS[slot];
    if (probes >= n) {
      out.set(id, `${base} ${Math.floor(out.size / n) + 1}`);
    } else {
      taken.add(slot);
      out.set(id, base);
    }
  }
  return out;
}
