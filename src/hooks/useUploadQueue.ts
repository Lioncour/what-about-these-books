"use client";

import { useCallback, useRef, useState } from "react";
import {
  isDuplicateError,
  processOneFile,
  uploadProblem,
  type FileJob,
} from "@/components/upload/extract";

type QueuedJob = FileJob & { file: File };

let jobIdCounter = 0;

/** The upload queue: files are read one at a time, each with its progress steps. */
export function useUploadQueue(onBooksChanged?: () => void) {
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [error, setError] = useState("");
  const processingRef = useRef(false);
  const queueRef = useRef<QueuedJob[]>([]);

  const updateJob = useCallback((id: number, update: Partial<FileJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...update } : j)));
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
          next.file,
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
        next.status = "error";
        next.error = msg;
        next.errorKind = isDuplicateError(err) ? "duplicate" : "other";
        updateJob(next.id, { status: "error", error: msg, errorKind: next.errorKind });
      }
    }

    processingRef.current = false;
  }, [updateJob, onBooksChanged]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setError("");
      const newJobs: QueuedJob[] = [];

      for (const file of Array.from(files)) {
        const problem = uploadProblem(file);
        if (problem) {
          setError(problem);
          continue;
        }
        newJobs.push({ id: ++jobIdCounter, name: file.name, status: "queued", steps: [], file });
      }

      if (newJobs.length === 0) return;

      queueRef.current = [...queueRef.current, ...newJobs];
      setJobs((prev) => [...prev, ...newJobs]);
      processQueue();
    },
    [processQueue]
  );

  const skipJob = useCallback((jobId: number) => {
    queueRef.current.find((j) => j.id === jobId)?.abortController?.abort();
  }, []);

  const clearDone = useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status !== "done" && j.status !== "error"));
    queueRef.current = queueRef.current.filter((j) => j.status !== "done" && j.status !== "error");
  }, []);

  return {
    error,
    /** Jobs worth listing (finished ones stay until cleared). */
    activeJobs: jobs.filter((j) => j.status !== "done" || j.result),
    hasFinished: jobs.some((j) => j.status === "done" || j.status === "error"),
    addFiles,
    skipJob,
    clearDone,
  };
}
