/** Max books consulted as specialists for library-wide questions. */
export const MAX_LIBRARY_SPECIALIST_BOOKS = 6;

/**
 * Open library questions ask this many of the closest books first; the rest of the
 * selection is only read when these come back thin.
 */
export const FIRST_WAVE_SPECIALIST_BOOKS = 3;

/** Max books consulted as specialists within a series. */
export const MAX_SERIES_SPECIALIST_BOOKS = 6;

/** Seed passages when ranking which books to consult. */
export const MAX_SPECIALIST_SEED_PASSAGES = 40;

/**
 * Most librarian (specialist) Claude calls one question may cost, second reads of empty
 * answers included. The orchestrator's call comes on top.
 */
export const MAX_SPECIALIST_CALLS_PER_REQUEST = 8;
