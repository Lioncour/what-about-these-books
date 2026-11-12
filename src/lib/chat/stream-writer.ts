import { encodeStreamField } from "@/lib/chat/stream-protocol";

/** Writes protocol lines to the response stream; silent once the stream is closed or cancelled. */
export interface StreamWriter {
  /** `TYPE:payload` — the payload must not contain a newline (JSON or a short status). */
  line(type: string, payload: string): void;
  /** `TYPE:"json-encoded string"` — safe for any text. */
  field(type: string, data: string): void;
  close(): void;
  /** The consumer went away: drop everything from here on. */
  markClosed(): void;
  readonly closed: boolean;
}

/** A writer that keeps the lines instead of streaming them (in-process runs: the eval). */
export function createCollectingWriter(): StreamWriter & { lines: string[] } {
  const lines: string[] = [];
  let closed = false;
  return {
    lines,
    line: (type, payload) => {
      if (!closed) lines.push(`${type}:${payload}`);
    },
    field: (type, data) => {
      if (!closed) lines.push(encodeStreamField(type, data).replace(/\n$/, ""));
    },
    close() {
      closed = true;
    },
    markClosed() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

export function createStreamWriter(controller: ReadableStreamDefaultController<Uint8Array>): StreamWriter {
  const encoder = new TextEncoder();
  let closed = false;
  // After close/cancel every write is a no-op (never throw inside an error handler).
  const enqueue = (line: string) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(line));
    } catch {
      closed = true;
    }
  };
  return {
    line: (type, payload) => enqueue(`${type}:${payload}\n`),
    field: (type, data) => enqueue(encodeStreamField(type, data)),
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    markClosed() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}
