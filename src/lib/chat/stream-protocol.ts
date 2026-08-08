/** Encode a stream field so payloads may contain newlines safely. */
export function encodeStreamField(type: string, data: string): string {
  return `${type}:${JSON.stringify(data)}\n`;
}

/** Decode a stream line. Supports legacy `TYPE:raw` and new `TYPE:"json"`. */
export function decodeStreamLine(line: string): { type: string; data: string } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const type = line.slice(0, colonIdx);
  const raw = line.slice(colonIdx + 1);
  if (!type) return null;
  if (raw.startsWith('"') || raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "string") return { type, data: parsed };
      return { type, data: raw };
    } catch {
      return { type, data: raw };
    }
  }
  return { type, data: raw };
}
