"use client";

import { JobError, JobStatus } from "@/components/upload/JobBits";
import type { FileJob, UploadResult } from "@/components/upload/extract";

/** The upload queue as the library rail shows it: one line of progress per file. */
export default function CompactJobs({
  jobs,
  hasFinished,
  onClearDone,
  onSkip,
  onOpen,
}: {
  jobs: FileJob[];
  hasFinished: boolean;
  onClearDone: () => void;
  onSkip: (jobId: number) => void;
  onOpen: (result: UploadResult) => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {hasFinished && (
        <button
          onClick={onClearDone}
          className="text-[11px] text-muted hover:text-foreground transition-colors"
        >
          Clear finished
        </button>
      )}
      {jobs.map((job) => (
        <div key={job.id} className="rounded-lg border border-border bg-background px-3 py-2">
          <div className="flex items-center justify-between">
            <p className="truncate text-xs font-medium">{job.name}</p>
            <JobStatus job={job} />
          </div>
          {job.status === "processing" && job.steps.length > 0 && (
            <div className="mt-1 flex items-center gap-2">
              <p className="flex-1 truncate text-[11px] text-muted">
                {job.steps[job.steps.length - 1]}
              </p>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSkip(job.id);
                }}
                className="shrink-0 text-[10px] font-medium text-red-400 hover:text-red-300 transition-colors"
              >
                Skip
              </button>
            </div>
          )}
          <JobError job={job} />
          {job.status === "done" && job.result && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(job.result!);
              }}
              className="mt-1.5 text-[11px] font-medium text-primary hover:underline"
            >
              Ask about this book →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
