"use client";

import { useCallback, useRef, useState } from "react";
import CompactJobs from "@/components/upload/CompactJobs";
import FullJobs from "@/components/upload/FullJobs";
import type { UploadResult } from "@/components/upload/extract";
import { useUploadQueue } from "@/hooks/useUploadQueue";

interface UploadAreaProps {
  onBookLoaded: (id: string, title: string, wordCount: number) => void;
  onBooksChanged?: () => void;
  compact?: boolean;
}

/** Drag/drop (or click) to add books; the queue below shows each file being read. */
export default function UploadArea({ onBookLoaded, onBooksChanged, compact }: UploadAreaProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { error, activeJobs, hasFinished, addFiles, skipJob, clearDone } =
    useUploadQueue(onBooksChanged);

  const openChat = useCallback(
    (result: UploadResult) => onBookLoaded(result.id, result.title, result.wordCount),
    [onBookLoaded]
  );

  const dropZone = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
    onClick: () => fileInputRef.current?.click(),
  };

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".pdf,.epub,.txt"
      multiple
      onChange={(e) => {
        if (e.target.files?.length) addFiles(e.target.files);
        e.target.value = "";
      }}
      className="hidden"
    />
  );

  const queue = {
    jobs: activeJobs,
    hasFinished,
    onClearDone: clearDone,
    onSkip: skipJob,
    onOpen: openChat,
  };

  if (compact) {
    return (
      <div>
        <div
          {...dropZone}
          className={`
            cursor-pointer rounded-2xl border border-dashed px-4 py-5 text-center transition-all
            ${isDragging
              ? "border-primary bg-primary/8"
              : "border-border/45 hover:border-primary/40 hover:bg-surface-hover/70"
            }
          `}
        >
          {fileInput}
          <div className="flex items-center justify-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span className="text-sm font-medium">Add books</span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Drop or click — PDF, EPUB, TXT</p>
        </div>

        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

        <CompactJobs {...queue} />
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
        {...dropZone}
        className={`
          relative cursor-pointer rounded-2xl border-2 border-dashed p-10 transition-all duration-200
          ${isDragging
            ? "border-primary bg-primary/5 scale-[1.02]"
            : "border-border hover:border-primary/50 hover:bg-surface-hover"
          }
        `}
      >
        {fileInput}

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

      <FullJobs {...queue} />
    </div>
  );
}
