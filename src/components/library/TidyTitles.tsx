"use client";

import { useCallback, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { formatLabelSummary } from "@/components/chat/format";

interface TidyPlan {
  titles: Array<{ id: string; from: string; to: string }>;
  labels: Array<{ id: string; title: string; changed: number }>;
}

type TidyState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "preview" | "applying"; plan: TidyPlan }
  | { phase: "notice"; title: string; text: string };

async function requestTidy(dryRun: boolean): Promise<TidyPlan> {
  const res = await fetch("/api/library/tidy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error ||
        (res.status === 403
          ? "Tidying is turned off while the library is shared read-only."
          : `The library could not be tidied (${res.status}).`)
    );
  }
  return {
    titles: Array.isArray(data.titles) ? data.titles : [],
    labels: Array.isArray(data.labels) ? data.labels : [],
  };
}

/**
 * "Tidy titles & chapters" in the library's Manage area: preview what would
 * change (dry run), confirm in a dialog, apply, then let the library reload.
 */
export default function TidyTitles({
  className,
  onTidied,
}: {
  className: string;
  onTidied: () => void | Promise<void>;
}) {
  const [state, setState] = useState<TidyState>({ phase: "idle" });
  const close = useCallback(() => setState({ phase: "idle" }), []);

  const fail = (err: unknown) =>
    setState({
      phase: "notice",
      title: "Couldn’t tidy the library",
      text: err instanceof Error ? err.message : "Something went wrong.",
    });

  const preview = async () => {
    setState({ phase: "checking" });
    try {
      const plan = await requestTidy(true);
      if (!plan.titles.length && !formatLabelSummary(plan.labels)) {
        setState({
          phase: "notice",
          title: "Nothing to tidy",
          text: "Titles and chapter labels already look clean.",
        });
        return;
      }
      setState({ phase: "preview", plan });
    } catch (err) {
      fail(err);
    }
  };

  const apply = async (plan: TidyPlan) => {
    setState({ phase: "applying", plan });
    try {
      await requestTidy(false);
      setState({ phase: "idle" });
      await onTidied();
    } catch (err) {
      fail(err);
    }
  };

  const plan = state.phase === "preview" || state.phase === "applying" ? state.plan : null;
  const labelSummary = plan ? formatLabelSummary(plan.labels) : "";

  return (
    <>
      <button
        type="button"
        onClick={() => void preview()}
        disabled={state.phase === "checking"}
        className={className}
        title="Clean up book titles and chapter labels left over from filenames"
      >
        {state.phase === "checking" ? "Checking…" : "Tidy titles & chapters"}
      </button>

      <ConfirmDialog
        open={plan !== null}
        title="Tidy titles & chapters"
        confirmLabel={state.phase === "applying" ? "Tidying…" : "Tidy up"}
        busy={state.phase === "applying"}
        onConfirm={plan ? () => void apply(plan) : undefined}
        onClose={close}
      >
        {plan && (
          <div className="space-y-3">
            {plan.titles.length > 0 && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted/90">
                  {plan.titles.length} title{plan.titles.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-1.5 space-y-1.5 text-[13px]">
                  {plan.titles.map((t) => (
                    <li key={t.id} className="break-words">
                      <span className="text-muted line-through decoration-muted/40">{t.from}</span>
                      <span className="mx-1.5 text-accent">→</span>
                      <span className="text-foreground">{t.to}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {labelSummary && <p className="text-[13px] text-foreground">{labelSummary}</p>}
            <p className="text-[12px] text-muted">A backup is made first.</p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={state.phase === "notice"}
        title={state.phase === "notice" ? state.title : ""}
        onClose={close}
      >
        {state.phase === "notice" ? state.text : null}
      </ConfirmDialog>
    </>
  );
}
