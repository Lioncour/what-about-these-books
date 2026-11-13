import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyEntity, entityFinder, extractBookEntities, settleEntityTypes } from "@/lib/knowledge-extract";
import { freshDataDir, removeDataDir } from "./store-env";

const repeat = (text: string, n: number) => Array.from({ length: n }, () => text).join(" ");

/** Synthetic text with the cases the first extraction got wrong. */
const pages = [
  {
    text: repeat(
      'I grew up in Thomson Corners, a small town. Nothing ever happened in Thomson Corners. My folks still live near Thomson Corners. ' +
        '"We have a problem," Skippy said. Mr. Thomson nodded. Then Thomson said nothing, and Thomson sighed. ' +
        "The Kristang attacked at dawn. Two Kristangs died. We hated the Kristang, and the Kristangs hated us. " +
        'The Colonel was late. "Colonel?" I asked. The Sergeant shrugged. Colonel Chang asked for coffee. "Sure," Chang said. ' +
        "Giraud spoke French to the French team, and the American team spoke English. An American joined us. " +
        "UNEF ordered us home. The orders from UNEF were clear, and we hated UNEF for it. " +
        'WHAT THE HELL was that? We made an FTL jump, then another FTL jump, and an FTL drive failed. ' +
        '"Ugh," I said. Hmmm. Wow, that was close. "Ugh, Hmmm, Wow," I said again. ' +
        "We met at Club Skippy after work. The bar in Club Skippy was full. Nobody left Club Skippy early.",
      6
    ),
  },
  // A nickname used a handful of times next to hundreds of plain mentions.
  { text: repeat('"No," Skippy said. Then Skippy laughed.', 170) + repeat(" Skippy Claus laughed.", 3) },
  {
    text: repeat(
      "Reed's Condor waited on the pad. \"Ready,\" Reed said. Captain Reed grinned. " +
        "The Sentinel woke up. A second Sentinel followed, and the Sentinels turned toward us. Those Sentinels were old.",
      6
    ),
  },
];

describe("extractBookEntities, second pass", () => {
  const entities = extractBookEntities(pages);
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("keeps a town a place even though part of its name is a person", () => {
    expect(byName.get("Thomson Corners")?.type).toBe("place");
    expect(byName.get("Thomson Corners")?.aliases).toEqual([]);
    // Mr. Thomson is still a person, on his own.
    expect(byName.get("Thomson")?.type).toBe("character");
  });

  it("folds a plural into the group it belongs to", () => {
    const kristang = byName.get("Kristang");
    expect(kristang?.type).toBe("faction");
    expect(kristang?.aliases).toContain("Kristangs");
    expect(byName.has("Kristangs")).toBe(false);
    expect(kristang!.mentions).toBeGreaterThanOrEqual(24);
    const sentinel = byName.get("Sentinel");
    expect(sentinel?.type).toBe("faction");
    expect(sentinel?.aliases).toContain("Sentinels");
  });

  it("never takes a rank alone for a name", () => {
    for (const rank of ["Colonel", "Sergeant", "Captain"]) expect(byName.has(rank), rank).toBe(false);
    // …but the rank still says who is a person.
    expect(byName.get("Chang")?.type).toBe("character");
    expect(byName.get("Reed")?.type).toBe("character");
  });

  it("files nationalities and languages as peoples, not people", () => {
    for (const name of ["French", "American", "English"]) {
      expect(byName.get(name)?.type ?? "faction", name).toBe("faction");
    }
    expect([...byName.values()].filter((e) => /^(French|American|English)$/.test(e.name) && e.type === "character")).toEqual([]);
  });

  it("captures an ALL-CAPS abbreviation used as a name as a group", () => {
    expect(byName.get("UNEF")?.type).toBe("faction");
    expect(byName.get("UNEF")?.mentions).toBe(18);
  });

  it("does not take shouting or a thing for a group", () => {
    for (const word of ["WHAT", "THE", "HELL", "FTL"]) expect(byName.has(word), word).toBe(false);
  });

  it("drops interjections of any length", () => {
    for (const word of ["Ugh", "Hmmm", "Wow"]) expect(byName.has(word), word).toBe(false);
  });

  it("does not fold a name into a place or a joke that contains it", () => {
    expect(byName.get("Skippy")?.type).toBe("character");
    expect(byName.get("Skippy")?.aliases).toEqual([]);
    expect(byName.get("Club Skippy")?.type).toBe("place");
  });

  it("ends a name at a possessive", () => {
    expect(byName.has("Reed’s Condor")).toBe(false);
    expect(byName.has("Reed's Condor")).toBe(false);
  });

  it("returns the evidence each type was decided on", () => {
    const town = byName.get("Thomson Corners")!;
    expect(town.evidence).toMatchObject({ total: 18, loc: 18, speech: 0, title: 0 });
  });
});

describe("classifyEntity", () => {
  const none = { total: 10, speech: 0, title: 0, article: 0, place: 0, loc: 0 };
  it("prefers a place over a person when it is somewhere more often than it speaks", () => {
    expect(classifyEntity("Avalon", { ...none, loc: 4, speech: 1 })).toBe("place");
    expect(classifyEntity("Bishop", { ...none, loc: 1, speech: 4, title: 3 })).toBe("character");
  });
  it("lets the article win for a species that is also spoken 'in'", () => {
    expect(classifyEntity("Kristang", { ...none, total: 100, article: 60, loc: 5 })).toBe("faction");
  });
  it("types by the name where the name says it", () => {
    expect(classifyEntity("French", none)).toBe("faction");
    expect(classifyEntity("UNEF", none)).toBe("faction");
    expect(classifyEntity("Thomson Corners", none)).toBe("place");
  });
});

describe("settleEntityTypes", () => {
  it("gives a name one type across books: the one most of its mentions agree on", () => {
    const nodes = [
      { name: "Kristang", type: "faction", mentions: 800 },
      { name: "Kristang", type: "unknown", mentions: 7 },
      { name: "Kristang", type: "place", mentions: 20 },
      { name: "Joe", type: "character", mentions: 5 },
    ];
    settleEntityTypes(nodes);
    expect(nodes.map((n) => n.type)).toEqual(["faction", "faction", "faction", "character"]);
  });

  it("classifies a name no single book could place on the evidence of all of them", () => {
    const ev = { total: 6, speech: 1, title: 0, article: 1, place: 0, loc: 0 };
    const nodes = [
      { name: "Fabron", type: "unknown", mentions: 6, evidence: ev },
      { name: "Fabron", type: "unknown", mentions: 6, evidence: { ...ev, speech: 2, article: 0 } },
    ];
    settleEntityTypes(nodes);
    expect(nodes.every((n) => n.type === "character")).toBe(true);
  });

  it("types a plural by its singular's group, and leaves the rest unknown", () => {
    const nodes = [
      { name: "Sentinel", type: "faction", mentions: 300 },
      { name: "Sentinels", type: "unknown", mentions: 12 },
      { name: "Opie", type: "unknown", mentions: 30 },
    ];
    settleEntityTypes(nodes);
    expect(nodes.map((n) => n.type)).toEqual(["faction", "faction", "unknown"]);
  });
});

describe("entityFinder with abbreviations", () => {
  const find = entityFinder([
    { name: "UNEF", type: "faction", mentions: 9, aliases: [] },
    { name: "Kristang", type: "faction", mentions: 9, aliases: ["Kristangs"] },
  ]);
  it("matches an abbreviation only as written", () => {
    expect(find("UNEF sent the Kristangs away.")).toEqual(["UNEF", "Kristang"]);
    expect(find("the unef of it all")).toEqual([]);
  });
});

describe("the stored graph", () => {
  let dir: string;
  let store: typeof import("@/lib/knowledge-store");

  beforeEach(async () => {
    dir = freshDataDir();
    store = await import("@/lib/knowledge-store");
    const joe = repeat('"Fine," Joe Bishop said. Colonel Bishop sighed. Then Joe laughed, and Joe asked Bishop why. Bishop nodded.', 6);
    store.rebuildKnowledgeForBooks(
      [
        { bookId: "book-1", bookTitle: "One", pages: [{ label: "Chapter 1", text: pages[0].text + " " + joe }] },
        {
          bookId: "book-2",
          bookTitle: "Two",
          pages: [{ label: "Chapter 1", text: repeat("We saw a Kristang. Then Bishop said no. Colonel Bishop frowned. Bishop asked why.", 4) }],
        },
      ],
      { replaceAll: true }
    );
  });
  afterEach(() => {
    try {
      removeDataDir(dir);
    } catch {
      // Windows can hold a just-written file for a moment; a leftover temp folder is harmless.
    }
  });

  it("is stamped with the extraction version that built it", () => {
    expect(store.KNOWLEDGE_VERSION).toBe(3);
    expect(store.getEntityGraph().version).toBe(3);
    expect(store.isKnowledgeCurrent()).toBe(true);
  });

  it("settles a name's type across books", () => {
    const kristang = store.getEntityGraph().nodes.filter((n) => n.name === "Kristang");
    expect(kristang).toHaveLength(2);
    expect(kristang.every((n) => n.type === "faction")).toBe(true);
  });

  it("looks a name up by any of its forms", () => {
    expect(store.lookupEntity("Bishop")).toMatchObject({ name: "Joe Bishop", type: "character", books: 2 });
    expect(store.lookupEntity("Bishop")?.aliases.sort()).toEqual(["Bishop", "Joe"]);
    expect(store.lookupEntity("joe bishop")?.name).toBe("Joe Bishop");
    expect(store.lookupEntity("the Kristangs")).toMatchObject({ name: "Kristang", type: "faction", books: 2 });
    expect(store.lookupEntity("Thomson Corners")?.type).toBe("place");
    expect(store.lookupEntity("Nobody Atall")).toBeNull();
  });

  it("narrows a lookup to the books in scope", () => {
    expect(store.lookupEntity("Kristang", ["book-2"])).toMatchObject({ books: 1 });
    expect(store.lookupEntity("UNEF", ["book-2"])).toBeNull();
  });

  it("lists the characters the router may ask about, by name and alias", () => {
    const names = store.knownCharacterNames();
    for (const name of ["joe bishop", "joe", "bishop", "skippy"]) expect(names.has(name), name).toBe(true);
    for (const name of ["kristang", "unef", "thomson corners", "colonel"]) expect(names.has(name), name).toBe(false);
  });
});
