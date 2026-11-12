"use client";

/** A series' row above its books: click to ask the series, collapse, rename/delete when managing. */
export default function SeriesHeader({
  name,
  count,
  active,
  collapsed,
  managing,
  onSelect,
  onToggleCollapsed,
  onRename,
  onDelete,
}: {
  name: string;
  count: number;
  active: boolean;
  collapsed: boolean;
  managing: boolean;
  onSelect: () => void;
  onToggleCollapsed: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`mb-2 flex cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 ${
        active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-surface-hover/70"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed();
          }}
          className="rounded p-0.5 hover:bg-black/5"
          title={collapsed ? "Expand" : "Collapse"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`${collapsed ? "" : "rotate-90"} transition-transform`}>
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
        <span className="text-xs font-semibold">{name}</span>
        <span className="text-[10px] text-muted">({count})</span>
      </div>
      {managing && (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onRename}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground"
          >
            Rename
          </button>
          <button
            onClick={onDelete}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-400"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
