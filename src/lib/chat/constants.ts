/** Max books consulted as specialists for library-wide questions. */
export const MAX_LIBRARY_SPECIALIST_BOOKS = 6;

/** Max books consulted as specialists within a series. */
export const MAX_SERIES_SPECIALIST_BOOKS = 6;

/** Seed passages when ranking which books to consult. */
export const MAX_SPECIALIST_SEED_PASSAGES = 40;

export const FAMOUS_LIBRARIANS = [
  "Hypatia",
  "Borges",
  "Dewey",
  "Brewster",
  "Shirley",
  "Panizzi",
  "Ranganathan",
  "Aurelia",
] as const;

export function getLibrarianName(seed: string, idx = 0): string {
  const sum = seed.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) + idx;
  return FAMOUS_LIBRARIANS[sum % FAMOUS_LIBRARIANS.length];
}
