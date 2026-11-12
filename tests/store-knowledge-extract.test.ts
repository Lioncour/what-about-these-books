import { describe, expect, it } from "vitest";
import { entityFinder, extractBookEntities } from "@/lib/knowledge-extract";

const repeat = (text: string, n: number) => Array.from({ length: n }, () => text).join(" ");

const pages = [
  {
    text: repeat(
      'The morning was quiet. That was unusual. You could hear the wind. "I think we have a problem," Skippy said. ' +
        "Colonel Bishop nodded at the beer can. Then Joe asked what the problem was. " +
        '"The Kristang are coming," Skippy replied. Nobody trusted the Kristang, and the Ruhar were no better. ' +
        "We had landed on Paradise two days earlier. Life on Paradise was hard. " +
        'Joe Bishop sighed. "Holy Crap," he said. I hope we survive, he thought. ' +
        "The Flying Dutchman waited in orbit, and the Flying Dutchman was patient.",
      6
    ),
  },
  {
    text: repeat(
      "Later, Adams told Bishop that Hope was not a plan. Sergeant Adams grinned. " +
        "They flew from Paradise to Earth. On Earth, the United Nations Expeditionary Force waited. " +
        "What did Skippy want? Nothing good. But the hope remained, and hope is cheap.",
      6
    ),
  },
];

describe("extractBookEntities", () => {
  const entities = extractBookEntities(pages);
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("ignores words that are capitalised only because they open a sentence", () => {
    for (const word of ["The", "That", "You", "Then", "We", "Nobody", "Later", "They", "What", "Nothing", "But", "Life"]) {
      expect(byName.has(word), word).toBe(false);
    }
  });

  it("ignores capitalised phrases of ordinary words and words mostly written in lower case", () => {
    expect(byName.has("Holy Crap")).toBe(false);
    expect(byName.has("Hope")).toBe(false);
  });

  it("recognises people by speech and titles", () => {
    expect(byName.get("Skippy")?.type).toBe("character");
    expect(byName.get("Adams")?.type).toBe("character");
  });

  it("folds first and last name into the full name", () => {
    const joe = byName.get("Joe Bishop");
    expect(joe?.type).toBe("character");
    expect(joe?.aliases.sort()).toEqual(["Bishop", "Joe"]);
    expect(byName.has("Joe")).toBe(false);
    expect(byName.has("Bishop")).toBe(false);
    // "Colonel Bishop" is Bishop with a title, not a separate person.
    expect(byName.has("Colonel Bishop")).toBe(false);
    expect(joe!.mentions).toBeGreaterThanOrEqual(24);
  });

  it("does not call species, ships and places people", () => {
    expect(byName.get("Kristang")?.type).toBe("faction");
    expect(byName.get("Ruhar")?.type).not.toBe("character");
    expect(byName.get("Flying Dutchman")?.type).toBe("faction");
    expect(byName.get("Paradise")?.type).toBe("place");
    expect(byName.get("Earth")?.type).toBe("place");
  });

  it("sorts by mentions", () => {
    const counts = entities.map((e) => e.mentions);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});

describe("entityFinder", () => {
  const find = entityFinder([
    { name: "Joe Bishop", type: "character", mentions: 10, aliases: ["Joe", "Bishop"] },
    { name: "Skippy", type: "character", mentions: 9, aliases: [] },
  ]);

  it("finds entities by name or alias, once each, in order of appearance", () => {
    expect(find("Skippy laughed at Bishop. Joe ignored Skippy.")).toEqual(["Skippy", "Joe Bishop"]);
    expect(find("nothing here")).toEqual([]);
  });

  it("matches whole words only", () => {
    expect(find("The bishopric of Joeville")).toEqual([]);
  });
});
