"use client";

/** Playful open-book brand mark (oat / sage / apricot) */
export default function BrandMark({
  className = "h-10 w-10",
  title = "What About This Book?",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      fill="none"
      className={className}
      role="img"
      aria-label={title}
    >
      <rect width="128" height="128" rx="28" fill="#C9B79F" />
      <path
        d="M20 40c18-2 30 4 44 16 14-12 26-18 44-16v54c-18-4-30 2-44 14-14-12-26-18-44-14V40Z"
        fill="#B08968"
      />
      <path
        d="M26 42c16-1 26 5 38 15V98c-12-9-22-14-38-12V42Z"
        fill="#E8DDD0"
        stroke="#4F644D"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M102 42c-16-1-26 5-38 15V98c12-9 22-14 38-12V42Z"
        fill="#E8DDD0"
        stroke="#4F644D"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M34 56h18M34 66h16M34 76h14M34 86h12"
        stroke="#4F644D"
        strokeWidth="3.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M76 56h18M78 66h16M80 76h14M82 86h12"
        stroke="#4F644D"
        strokeWidth="3.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path d="M40 48l1.2 3.2 3.2 1.2-3.2 1.2-1.2 3.2-1.2-3.2-3.2-1.2 3.2-1.2z" fill="#B08968" />
      <path d="M90 88l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" fill="#5A6F58" />
      <circle cx="54" cy="22" r="4.5" fill="#B08968" />
      <circle cx="68" cy="18" r="3.2" fill="#E8DDD0" stroke="#4F644D" strokeWidth="2" />
      <circle cx="80" cy="24" r="3.8" fill="#7A9A90" />
      <path d="M42 26h4M44 24v4" stroke="#4F644D" strokeWidth="2" strokeLinecap="round" />
      <path d="M88 20h4M90 18v4" stroke="#B08968" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
