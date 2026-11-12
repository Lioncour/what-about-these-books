"use client";

import { CheckIcon, JobError, JobStatus } from "@/components/upload/JobBits";
import type { FileJob, UploadResult } from "@/components/upload/extract";

/** The upload queue on the full-page upload view: every progress step per file. */
export default function FullJobs({
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
    <div className="mt-6 text-left">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-muted">Processing Queue</h3>
        {hasFinished && (
          <button
            onClick={onClearDone}
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            Clear finished
          </button>
        )}
      </div>
      <div className="space-y-3">
        {jobs.map((job) => (
          <div key={job.id} className="rounded-xl border border-border bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="truncate text-sm font-medium">{job.name}</p>
              <JobStatus job={job} />
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
                          <CheckIcon size={12} />
                        )}
                      </span>
                      <span>{step}</span>
                    </div>
                  );
                })}
                <button
                  onClick={() => onSkip(job.id)}
                  className="mt-1 text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
                >
                  Skip this book
                </button>
              </div>
            )}

            <JobError job={job} />

            {job.status === "done" && job.result && (
              <button
                onClick={() => onOpen(job.result!)}
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                Open chat →
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
