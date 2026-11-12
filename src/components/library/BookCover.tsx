"use client";

import { useState } from "react";
import { coverUrl, hashTitle } from "@/components/library/shelf";

const COVER_COLORS = [
  "bg-[#5a6f58]/22 text-[#3a4a38]",
  "bg-[#b08968]/25 text-[#6b4f38]",
  "bg-[#7a8f9a]/20 text-[#3d4f58]",
  "bg-[#a89070]/22 text-[#5c4a35]",
  "bg-[#8a9578]/20 text-[#454d3c]",
  "bg-[#958a9a]/18 text-[#4e4558]",
  "bg-[#a88878]/20 text-[#5c453c]",
  "bg-[#789a90]/20 text-[#3c524c]",
];

export function BookIcon({ title }: { title: string }) {
  const colorClass = COVER_COLORS[hashTitle(title) % COVER_COLORS.length];
  return (
    <div className={`flex h-full w-full items-center justify-center rounded-lg ${colorClass}`}>
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        <path d="M8 7h6" />
        <path d="M8 11h4" />
      </svg>
    </div>
  );
}

function CoverImage({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <BookIcon title={title} />;

  return (
    // Covers are local API blobs; next/image isn't useful here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`Cover of ${title}`}
      className="h-full w-full rounded-lg object-cover"
      onError={() => setFailed(true)}
    />
  );
}

/** A book's cover, or the tinted book icon when it has none (or it fails to load). */
export default function BookCover({
  bookId,
  title,
  hasCover,
  version,
}: {
  bookId: string;
  title: string;
  hasCover?: boolean;
  /** Bumped after a cover upload: changes the URL so the new image is fetched. */
  version?: number;
}) {
  if (!hasCover) return <BookIcon title={title} />;
  const src = coverUrl(bookId, version);
  // Keyed by URL so a failed load doesn't stick after a new upload.
  return <CoverImage key={src} src={src} title={title} />;
}
