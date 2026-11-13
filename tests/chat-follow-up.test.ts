import { describe, expect, it } from "vitest";
import { extractWhoIsTarget, questionWithFollowUpContext } from "@/lib/chat/intent";
import { buildPersonalityInstructions } from "@/lib/chat/response-formatting";
import type { ChatMessage } from "@/lib/chat/types";

const earlier: ChatMessage[] = [
  { role: "user", content: "Who is Skippy?" },
  { role: "assistant", content: "Skippy is an ancient AI the size of a beer can." },
];

describe("questionWithFollowUpContext", () => {
  it("carries the previous question along when this one leans on it", () => {
    expect(questionWithFollowUpContext("What does he usually call Joe?", earlier)).toBe(
      'What does he usually call Joe?\n(A follow-up: the reader\'s previous question was "Who is Skippy?".)'
    );
  });

  it("leaves a question that stands on its own alone", () => {
    expect(questionWithFollowUpContext("What does Skippy call Joe?", earlier)).toBe("What does Skippy call Joe?");
  });

  it("has nothing to add to a first question, or to the same question asked again", () => {
    expect(questionWithFollowUpContext("Who are they fighting in Paradise?", [])).toBe("Who are they fighting in Paradise?");
    expect(questionWithFollowUpContext("Who is he?", [{ role: "user", content: "who is he?" }])).toBe("Who is he?");
  });
});

describe("extractWhoIsTarget, groups and past tense", () => {
  it.each([
    ["Who are the Kristang?", "Kristang"],
    ["Who were the Elders?", "Elders"],
    ["Who is the Mysterious Benefactor?", "Mysterious Benefactor"],
    ["Who was Hans Chotek?", "Hans Chotek"],
    ["Who is Skippy in Columbus Day?", "Skippy"],
  ])("%j looks up %j", (question, target) => {
    expect(extractWhoIsTarget(question)).toBe(target);
  });

  it.each([
    "Who are they fighting in Paradise?",
    "Who are you?",
    "Who are the bad guys?",
    "Who were the others on the ship?",
    "Who is Joe in love with?",
    "Who is the author?",
  ])("%j is not a lookup", (question) => {
    expect(extractWhoIsTarget(question)).toBeNull();
  });
});

describe("answer language", () => {
  it("follows the question when the language is Auto, and the setting otherwise", () => {
    expect(buildPersonalityInstructions({ language: "Auto" })).toContain("Answer in the language the question is written in");
    const norwegian = buildPersonalityInstructions({ language: "Norwegian" });
    expect(norwegian).toContain("You MUST respond entirely in Norwegian.");
    expect(norwegian).not.toContain("language the question is written in");
  });
});
