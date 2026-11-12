/** Upload plumbing without React: the job shape, file checks and the `/api/extract` stream. */

export interface UploadResult {
  id: string;
  title: string;
  wordCount: number;
}

export interface FileJob {
  id: number;
  name: string;
  status: "queued" | "processing" | "done" | "error";
  steps: string[];
  error?: string;
  errorKind?: "duplicate" | "other";
  result?: UploadResult;
  abortController?: AbortController;
}

const DUPLICATE_ERROR_PREFIX = "DUPLICATE:";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class DuplicateBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateBookError";
  }
}

/** Why a file is skipped ("" when it can be added): PDF, EPUB or TXT, 50 MB at most. */
export function uploadProblem(file: { name: string; size: number }): string {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "epub", "txt"].includes(ext || "")) {
    return `Skipped "${file.name}" — unsupported format.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return `Skipped "${file.name}" — too large (50MB max).`;
  return "";
}

/** Whether a failed upload failed because the book is already on the shelves. */
export function isDuplicateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err instanceof DuplicateBookError ||
    err.name === "DuplicateBookError" ||
    /have this book already/i.test(err.message)
  );
}

/** Send one file to `/api/extract` and follow its PROGRESS / DONE / ERROR lines. */
export async function processOneFile(
  file: File,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/extract", {
    method: "POST",
    body: formData,
    signal,
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  if (!reader) throw new Error("No response stream");

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new Error("Skipped by user");
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const type = line.slice(0, colonIdx);
      const data = line.slice(colonIdx + 1).replace(/\r$/, "").trimStart();

      if (type === "PROGRESS") {
        onProgress(data);
      } else if (type === "DONE") {
        return JSON.parse(data);
      } else if (type === "ERROR") {
        if (data.startsWith(DUPLICATE_ERROR_PREFIX)) {
          throw new DuplicateBookError(data.slice(DUPLICATE_ERROR_PREFIX.length));
        }
        throw new Error(data);
      }
    }
  }

  throw new Error("Unexpected end of stream");
}
