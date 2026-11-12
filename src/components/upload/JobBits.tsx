"use client";

import type { FileJob } from "@/components/upload/extract";

export function CheckIcon({ size }: { size: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Right of the file name: queued, working, done or failed. */
export function JobStatus({ job, compact }: { job: FileJob; compact?: boolean }) {
  const text = compact ? "text-[10px]" : "text-xs";
  return (
    <span className="ml-2 shrink-0">
      {job.status === "queued" && <span className={`${text} text-muted`}>Queued</span>}
      {job.status === "processing" && (
        <span
          className={`inline-block animate-pulse rounded-full bg-primary ${compact ? "h-1.5 w-1.5" : "h-2 w-2"}`}
        />
      )}
      {job.status === "done" && <CheckIcon size={compact ? 12 : 16} />}
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
export function JobError({ job, compact }: { job: FileJob; compact?: boolean }) {
  if (job.status !== "error" || !job.error) return null;
  const text = compact ? "text-[11px]" : "text-xs";
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
