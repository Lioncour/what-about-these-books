"use client";

import { useCallback, useRef, useState } from "react";
import CompactJobs from "@/components/upload/CompactJobs";
import type { UploadResult } from "@/components/upload/extract";
import { useUploadQueue } from "@/hooks/useUploadQueue";

interface UploadAreaProps {
  onBookLoaded: (id: string, title: string, wordCount: number) => void;
  onBooksChanged?: () => void;
}

/** Drag/drop (or click) to add books; the queue below shows each file being read. */
export default function UploadArea({ onBookLoaded, onBooksChanged }: UploadAreaProps) {
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
