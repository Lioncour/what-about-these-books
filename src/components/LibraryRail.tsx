"use client";

import type { MouseEvent, ReactNode } from "react";

/** The resizable "Shelves" side rail; its content (upload area, library) comes as children. */
export default function LibraryRail({
  width,
  onCollapse,
  onStartResize,
  children,
}: {
  width: number;
  onCollapse: () => void;
  onStartResize: (event: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <>
      <aside
        className="flex shrink-0 flex-col border-r border-border/30 bg-surface/55"
        style={{ width }}
      >
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted/90">
            Shelves
          </p>
          <button
            type="button"
            onClick={onCollapse}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            title="Hide library (])"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {children}
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        onMouseDown={onStartResize}
        title="Drag to resize"
        role="separator"
        aria-orientation="vertical"
      />
    </>
  );
}
