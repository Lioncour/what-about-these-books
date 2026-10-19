"use client";

import { useState, useRef, useCallback } from "react";

interface UploadAreaProps {
  onBookLoaded: (id: string, title: string, wordCount: number) => void;
  onBooksChanged?: () => void;
  compact?: boolean;
}

interface FileJob {
  id: number;
  name: string;
  status: "queued" | "processing" | "done" | "error";
  steps: string[];
  error?: string;
  errorKind?: "duplicate" | "other";
  result?: { id: string; title: string; wordCount: number };
  abortController?: AbortController;
}

const DUPLICATE_ERROR_PREFIX = "DUPLICATE:";

class DuplicateBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateBookError";
  }
}

let jobIdCounter = 0;

async function processOneFile(
  file: File,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<{ id: string; title: string; wordCount: number }> {
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

export default function UploadArea({ onBookLoaded, onBooksChanged, compact }: UploadAreaProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const queueRef = useRef<FileJob[]>([]);

  const updateJob = useCallback((id: number, update: Partial<FileJob>) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, ...update } : j))
    );
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (true) {
      const next = queueRef.current.find((j) => j.status === "queued");
      if (!next) break;

      next.status = "processing";
      const abortController = new AbortController();
      next.abortController = abortController;
      updateJob(next.id, { status: "processing", steps: ["Starting..."], abortController });

      try {
        const result = await processOneFile(
          (next as FileJob & { file: File }).file,
          (step) => {
            next.steps = [...next.steps, step];
            updateJob(next.id, { steps: [...next.steps] });
          },
          abortController.signal
        );

        next.status = "done";
        next.result = result;
        updateJob(next.id, { status: "done", result });
        onBooksChanged?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        const isDuplicate =
          err instanceof DuplicateBookError ||
          (err instanceof Error && err.name === "DuplicateBookError") ||
          /have this book already/i.test(msg);
        next.status = "error";
        next.error = msg;
        next.errorKind = isDuplicate ? "duplicate" : "other";
        updateJob(next.id, {
          status: "error",
          error: msg,
          errorKind: next.errorKind,
        });
      }
    }

    processingRef.current = false;
  }, [updateJob, onBooksChanged]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setError("");
      const newJobs: (FileJob & { file: File })[] = [];

      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (!["pdf", "epub", "txt"].includes(ext || "")) {
          setError(`Skipped "${file.name}" — unsupported format.`);
          continue;
        }
        if (file.size > 50 * 1024 * 1024) {
          setError(`Skipped "${file.name}" — too large (50MB max).`);
          continue;
        }

        const job: FileJob & { file: File } = {
          id: ++jobIdCounter,
          name: file.name,
          status: "queued",
          steps: [],
          file,
        };
        newJobs.push(job);
      }

      if (newJobs.length === 0) return;

      queueRef.current = [...queueRef.current, ...newJobs];
      setJobs((prev) => [...prev, ...newJobs]);
      processQueue();
    },
    [processQueue]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) addFiles(e.target.files);
      e.target.value = "";
    },
    [addFiles]
  );

  const handleOpenChat = useCallback(
    (result: { id: string; title: string; wordCount: number }) => {
      onBookLoaded(result.id, result.title, result.wordCount);
    },
    [onBookLoaded]
  );

  const skipJob = useCallback((jobId: number) => {
    const job = queueRef.current.find((j) => j.id === jobId);
    if (job?.abortController) {
      job.abortController.abort();
    }
  }, []);

  const clearDone = useCallback(() => {
    const remaining = jobs.filter((j) => j.status !== "done" && j.status !== "error");
    setJobs(remaining);
    queueRef.current = queueRef.current.filter(
      (j) => j.status !== "done" && j.status !== "error"
    );
  }, [jobs]);

  const activeJobs = jobs.filter((j) => j.status !== "done" || j.result);
  const hasFinished = jobs.some((j) => j.status === "done" || j.status === "error");

  if (compact) {
    return (
      <div>
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`
            cursor-pointer rounded-2xl border border-dashed px-4 py-5 text-center transition-all
            ${isDragging
              ? "border-primary bg-primary/8"
              : "border-border/45 hover:border-primary/40 hover:bg-surface-hover/70"
            }
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.epub,.txt"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="flex items-center justify-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span className="text-sm font-medium">Add books</span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Drop or click — PDF, EPUB, TXT</p>
        </div>

        {error && (
          <p className="mt-2 text-xs text-red-500">{error}</p>
        )}

        {activeJobs.length > 0 && (
          <div className="mt-3 space-y-2">
            {hasFinished && (
              <button
                onClick={clearDone}
                className="text-[11px] text-muted hover:text-foreground transition-colors"
              >
                Clear finished
              </button>
            )}
            {activeJobs.map((job) => (
              <div key={job.id} className="rounded-lg border border-border bg-background px-3 py-2">
                <div className="flex items-center justify-between">
                  <p className="truncate text-xs font-medium">{job.name}</p>
                  <span className="ml-2 shrink-0">
                    {job.status === "queued" && (
                      <span className="text-[10px] text-muted">Queued</span>
                    )}
                    {job.status === "processing" && (
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    )}
                    {job.status === "done" && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {job.status === "error" && (
                      <span
                        className={
                          job.errorKind === "duplicate"
                            ? "text-[10px] text-amber-600 dark:text-amber-400"
                            : "text-[10px] text-red-500"
                        }
                      >
                        {job.errorKind === "duplicate"
                          ? "Have this book already"
                          : "Failed"}
                      </span>
                    )}
                  </span>
                </div>
                {job.status === "processing" && job.steps.length > 0 && (
                  <div className="mt-1 flex items-center gap-2">
                    <p className="flex-1 truncate text-[11px] text-muted">
                      {job.steps[job.steps.length - 1]}
                    </p>
                    <button
                      onClick={(e) => { e.stopPropagation(); skipJob(job.id); }}
                      className="shrink-0 text-[10px] font-medium text-red-400 hover:text-red-300 transition-colors"
                    >
                      Skip
                    </button>
                  </div>
                )}
                {job.status === "error" && job.error && (
                  <p
                    className={
                      job.errorKind === "duplicate"
                        ? "mt-1 text-[11px] text-amber-600 dark:text-amber-400"
                        : "mt-1 text-[11px] text-red-500"
                    }
                  >
                    {job.error}
                  </p>
                )}
                {job.status === "done" && job.result && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenChat(job.result!);
                    }}
                    className="mt-1.5 text-[11px] font-medium text-primary hover:underline"
                  >
                    Ask about this book →
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="mb-3 text-4xl font-bold tracking-tight sm:text-5xl">
        What About This Book?
      </h1>
      <p className="mb-10 text-lg text-muted">
        Upload books and ask AI anything about them
      </p>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`
          relative cursor-pointer rounded-2xl border-2 border-dashed p-10 transition-all duration-200
          ${isDragging
            ? "border-primary bg-primary/5 scale-[1.02]"
            : "border-border hover:border-primary/50 hover:bg-surface-hover"
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.epub,.txt"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        <div className="flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
              <path d="M12 13V7" />
              <path d="m9 10 3-3 3 3" />
            </svg>
          </div>
          <div>
            <p className="text-base font-medium">
              Drop books here or <span className="text-primary">browse</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              PDF, EPUB, or TXT — multiple files supported
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 animate-fade-in rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}

      {activeJobs.length > 0 && (
        <div className="mt-6 text-left">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-muted">Processing Queue</h3>
            {hasFinished && (
              <button
                onClick={clearDone}
                className="text-xs text-muted hover:text-foreground transition-colors"
              >
                Clear finished
              </button>
            )}
          </div>
          <div className="space-y-3">
            {activeJobs.map((job) => (
              <div
                key={job.id}
                className="rounded-xl border border-border bg-surface px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <p className="truncate text-sm font-medium">{job.name}</p>
                  <span className="ml-2 shrink-0">
                    {job.status === "queued" && (
                      <span className="text-xs text-muted">Queued</span>
                    )}
                    {job.status === "processing" && (
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                    )}
                    {job.status === "done" && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {job.status === "error" && (
                      <span
                        className={
                          job.errorKind === "duplicate"
                            ? "text-xs text-amber-600 dark:text-amber-400"
                            : "text-xs text-red-500"
                        }
                      >
                        {job.errorKind === "duplicate"
                          ? "Have this book already"
                          : "Failed"}
                      </span>
                    )}
                  </span>
                </div>

                {job.status === "processing" && job.steps.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {job.steps.map((step, i) => {
                      const isLatest = i === job.steps.length - 1;
                      return (
                        <div
                          key={i}
                          className={`flex items-start gap-2 text-xs transition-opacity ${
                            isLatest ? "text-foreground" : "text-muted opacity-50"
                          }`}
                        >
                          <span className="mt-0.5 shrink-0">
                            {isLatest ? (
                              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                            ) : (
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </span>
                          <span>{step}</span>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => skipJob(job.id)}
                      className="mt-1 text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
                    >
                      Skip this book
                    </button>
                  </div>
                )}

                {job.status === "error" && job.error && (
                  <p
                    className={
                      job.errorKind === "duplicate"
                        ? "mt-1 text-xs text-amber-600 dark:text-amber-400"
                        : "mt-1 text-xs text-red-500"
                    }
                  >
                    {job.error}
                  </p>
                )}

                {job.status === "done" && job.result && (
                  <button
                    onClick={() => handleOpenChat(job.result!)}
                    className="mt-2 text-xs font-medium text-primary hover:underline"
                  >
                    Open chat →
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
