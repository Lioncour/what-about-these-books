"use client";

import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";

export interface ComposerHandle {
  focus: () => void;
}

/** Alt+S, by physical key: with Alt held some layouts type another character for S. */
export function isScopeShortcut(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  code?: string;
  key: string;
}): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey) return false;
  return e.code ? e.code === "KeyS" : e.key.toLowerCase() === "s";
}

/** The question field with its Send button, which is Stop while an answer is coming. */
export default function Composer({
  ref,
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  placeholder,
  above,
  onOpenScope,
}: {
  ref?: Ref<ComposerHandle>;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isLoading: boolean;
  placeholder: string;
  /** Sits right above the field (the scope chip). */
  above?: ReactNode;
  /** Alt+S in the field: open the scope picker. */
  onOpenScope?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  // Grow with the text, up to a few lines. Also re-measure when the field's width
  // changes: measured while the column is still narrow (first paint, rail resize) the
  // placeholder wraps and the empty field would stay at its maximum height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    };
    fit();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div className="composer-shell relative z-20 shrink-0 px-7 pb-7 pt-5 sm:px-12 lg:px-16">
      {above && <div className="mx-auto w-full max-w-3xl">{above}</div>}
      <div className="mx-auto flex w-full max-w-3xl items-end gap-4">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            } else if (isScopeShortcut(e) && onOpenScope) {
              e.preventDefault();
              onOpenScope();
            }
          }}
          placeholder={placeholder}
          rows={2}
          className="composer-field flex-1 resize-none rounded-none border-0 border-b border-border/50 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-muted/80"
        />
        {isLoading ? (
          <button
            type="button"
            onClick={onStop}
            className="mb-1 shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            title="Stop"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!value.trim()}
            className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-[var(--on-primary)] transition-all hover:bg-primary-hover disabled:opacity-35 disabled:hover:bg-primary"
            title="Send"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
