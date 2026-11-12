"use client";

import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";

export interface ComposerHandle {
  focus: () => void;
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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [value]);

  return (
    <div className="composer-shell relative z-20 shrink-0 px-6 pb-5 pt-3 sm:px-10 lg:px-14">
      {above && <div className="mx-auto w-full max-w-3xl">{above}</div>}
      <div className="mx-auto flex w-full max-w-3xl items-end gap-3">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          rows={2}
          className="composer-field flex-1 resize-none rounded-none border-0 border-b border-border/50 bg-transparent px-0 py-2.5 text-base outline-none transition-colors placeholder:text-muted/80"
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
