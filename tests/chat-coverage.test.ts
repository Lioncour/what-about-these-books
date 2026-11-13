import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bedrock-claude", () => ({ callClaudeText: vi.fn(), callClaudeStream: vi.fn() }));
vi.mock("@/lib/chat/specialist", () => ({ summarizeSpecialistDisagreement: () => [] }));
vi.mock("@/lib/chat/library-commands", () => ({ isLibraryManagementInput: () => false }));

import { coverageNote } from "@/lib/chat/orchestrator";

describe("coverageNote (what the answer may claim to have read)", () => {
  it("an open library question: the closest books were chosen for the reader, not by them", () => {
    const note = coverageNote({ reason: "semantic", read: ["Zero Hour", "Breakaway", "Critical Mass"], total: 18 });
    expect(note).toContain("asked their whole library (18 books) and named no book");
    expect(note).toContain("the 3 books closest to the question: Zero Hour, Breakaway, Critical Mass");
    expect(note).toContain("The other 15 were not read");
    expect(note).toContain('never write "the books you\'re asking about"');
    expect(note).toContain("offering to check the other books");
  });

  it("a named book: nothing to hedge", () => {
    const note = coverageNote({ reason: "named", read: ["Columbus Day"], total: 18 });
    expect(note).toBe(
      "What was read: the reader named Columbus Day in the question, and the notes come from that book only."
    );
  });

  it("a series read in part says so and offers the rest", () => {
    const note = coverageNote({ reason: "series", read: ["A", "B"], total: 6, seriesName: "Star Run" });
    expect(note).toContain("the series Star Run open (6 books)");
    expect(note).toContain("2 of them: A, B");
    expect(note).toContain("The other 4 were not read");
    expect(coverageNote({ reason: "series", read: ["A", "B"], total: 2, seriesName: "Star Run" })).toContain(
      "all of them: A, B."
    );
  });

  it("picked books and a focus book", () => {
    expect(coverageNote({ reason: "picked", read: ["A", "B"], total: 2 })).toBe(
      "What was read: the reader picked 2 books for this question. The notes come from all of them: A, B."
    );
    expect(coverageNote({ reason: "picked", read: ["A"], total: 8 })).toContain("The other 7 were not read");
    expect(coverageNote({ reason: "focus", read: ["Paradise"], total: 1 })).toContain("has Paradise open");
  });

  it("a whole library that was read whole has no caveat", () => {
    const note = coverageNote({ reason: "semantic", read: ["A", "B"], total: 2 });
    expect(note).not.toContain("not read");
  });
});
