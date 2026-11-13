"use client";

import TidyTitles from "@/components/library/TidyTitles";
import type { DuplicateGroup } from "@/components/library/types";

const BUTTON =
  "rounded border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground";

/** The Manage tools above the shelves: series, tidy, duplicates. */
export default function ManageBar({
  duplicateGroups,
  onNewSeries,
  onFixSeries,
  onTidied,
  onFindDuplicates,
  onMerge,
}: {
  duplicateGroups: DuplicateGroup[];
  onNewSeries: () => void;
  onFixSeries: () => void;
  onTidied: () => void | Promise<void>;
  onFindDuplicates: () => void;
  onMerge: (group: DuplicateGroup) => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap gap-2.5">
        <button onClick={onNewSeries} className={BUTTON}>
          + New series
        </button>
        <button
          onClick={onFixSeries}
          className={BUTTON}
          title="Merge Book N folders and look up series on Open Library"
        >
          Fix series grouping
        </button>
        <TidyTitles className={`${BUTTON} disabled:opacity-60`} onTidied={onTidied} />
        <button onClick={onFindDuplicates} className={BUTTON}>
          Find duplicates
        </button>
      </div>
      {duplicateGroups.length > 0 && (
        <div className="mt-2 space-y-1 rounded border border-border bg-background p-2">
          {duplicateGroups.map((group) => (
            <div key={group.key} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-muted">
                {group.books[0]?.title} ({group.books.length})
              </span>
              <button
                onClick={() => onMerge(group)}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground"
              >
                Merge
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
