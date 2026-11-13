"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AwsStatusBadge from "@/components/AwsStatusBadge";
import BrandMark from "@/components/BrandMark";

interface BuildInfo {
  version: string;
  buildId: string;
  latestLabel: string;
  startedAt: string;
}

function buildTooltip(info: BuildInfo | null): string {
  if (!info) return "Settings";
  const label = info.latestLabel || `v${info.version} · ${info.buildId}`;
  return info.startedAt
    ? `Settings · ${label}\nStarted: ${new Date(info.startedAt).toLocaleString()}`
    : `Settings · ${label}`;
}

/** Window header: brand, Bedrock status, "Library" when the rail is hidden, settings. */
export default function AppHeader({
  libraryCollapsed,
  onShowLibrary,
}: {
  libraryCollapsed: boolean;
  onShowLibrary: () => void;
}) {
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    fetch("/api/build-info")
      .then((r) => r.json())
      .then((data) =>
        setBuildInfo({
          version: data.version || "0.0.0",
          buildId: data.buildId || "v0.0.0-b0000000000",
          latestLabel: data.latestLabel || "",
          startedAt: data.startedAt || "",
        })
      )
      .catch(() => {});
  }, []);

  return (
    <header className="app-chrome-header flex shrink-0 items-center gap-4 border-b border-border/30 px-7 pb-4 pt-2 sm:gap-5 sm:px-10">
      <BrandMark className="h-11 w-11 shrink-0 sm:h-12 sm:w-12" />
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-xl font-semibold tracking-tight sm:text-[1.65rem]">
          What About This Book?
        </h1>
        <p className="mt-0.5 text-[13px] text-muted">A reading room for the books you keep</p>
      </div>
      <AwsStatusBadge />
      {libraryCollapsed && (
        <button
          type="button"
          onClick={onShowLibrary}
          className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          title="Show library (])"
        >
          Library
        </button>
      )}
      <Link
        href="/settings"
        className="settings-orb inline-flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-primary"
        title={buildTooltip(buildInfo)}
        aria-label="Settings"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="3.25" />
          <path d="M12 2.75v2.1" />
          <path d="M12 19.15v2.1" />
          <path d="m19.45 7.2-1.82 1.05" />
          <path d="m6.37 15.75-1.82 1.05" />
          <path d="m19.45 16.8-1.82-1.05" />
          <path d="m6.37 8.25-1.82-1.05" />
          <circle cx="12" cy="12" r="8.5" opacity="0.35" />
        </svg>
      </Link>
    </header>
  );
}
