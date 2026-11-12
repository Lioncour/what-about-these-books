import { describe, expect, it } from "vitest";
import { decodeStreamLine, encodeStreamField } from "../src/lib/chat/stream-protocol";

describe("stream protocol", () => {
  it("round-trips a multi-line payload through one line", () => {
    const text = "Here's what I found…\n\n## Evidence\n- line one\r\n- \"quoted\" line\ttab";
    const encoded = encodeStreamField("TEXT", text);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.slice(0, -1)).not.toContain("\n");
    const decoded = decodeStreamLine(encoded.slice(0, -1));
    expect(decoded).toEqual({ type: "TEXT", data: text });
  });

  it("still reads legacy raw lines", () => {
    expect(decodeStreamLine("STATUS:Flipping through")).toEqual({
      type: "STATUS",
      data: "Flipping through",
    });
    expect(decodeStreamLine("no-colon")).toBeNull();
  });
});
