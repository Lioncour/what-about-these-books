"use client";

import type { FileJob } from "@/components/upload/extract";

function CheckIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Right of the file name: queued, working, done or failed. */
export function JobStatus({ job }: { job: FileJob }) {
  const text = "text-[10px]";
  return (
    <span className="ml-2 shrink-0">
      {job.status === "queued" && <span className={`${text} text-muted`}>Queued</span>}
      {job.status === "processing" && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      )}
      {job.status === "done" && <CheckIcon />}
      {job.status === "error" && (
        <span
          className={
            job.errorKind === "duplicate"
              ? `${text} text-amber-600 dark:text-amber-400`
              : `${text} text-red-500`
          }
        >
          {job.errorKind === "duplicate" ? "Have this book already" : "Failed"}
        </span>
      )}
    </span>
  );
}

/** Why a job failed (amber for "already have it"). */
export function JobError({ job }: { job: FileJob }) {
  if (job.status !== "error" || !job.error) return null;
  const text = "text-[11px]";
  return (
    <p
      className={
        job.errorKind === "duplicate"
          ? `mt-1 ${text} text-amber-600 dark:text-amber-400`
          : `mt-1 ${text} text-red-500`
      }
    >
      {job.error}
    </p>
  );
}
