"use client";

import { useCallback, useEffect, useState } from "react";

type AwsStatus = "checking" | "connected" | "disconnected" | "logging-in";

export default function AwsStatusBadge() {
  const [status, setStatus] = useState<AwsStatus>("checking");
  const [detail, setDetail] = useState("");

  const refresh = useCallback(async (opts?: { silent?: boolean; forceLogin?: boolean }) => {
    if (!opts?.silent) setStatus(opts?.forceLogin ? "logging-in" : "checking");
    try {
      const res = await fetch(
        opts?.forceLogin ? "/api/aws-status" : "/api/aws-status",
        opts?.forceLogin
          ? { method: "POST" }
          : { method: "GET", cache: "no-store" }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        profile?: string;
        identity?: string;
        error?: string;
      };
      if (data.ok) {
        setStatus("connected");
        setDetail(
          data.identity
            ? `Signed in · ${data.profile || "AWS"}`
            : data.profile
              ? `Profile: ${data.profile}`
              : "AWS ready"
        );
      } else {
        setStatus("disconnected");
        setDetail(data.error || "Not logged in — click to sign in");
      }
    } catch {
      setStatus("disconnected");
      setDetail("Could not reach AWS status endpoint");
    }
  }, []);

  useEffect(() => {
    // Warm credentials as soon as the UI loads
    const initial = window.setTimeout(() => void refresh({ silent: true }), 0);
    // Keepalive: every 10 minutes, re-check and auto SSO-login if expired
    const id = window.setInterval(() => void refresh({ silent: true }), 10 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(id);
    };
  }, [refresh]);

  const styles =
    status === "connected"
      ? "border-success/40 bg-success/10 text-success"
      : status === "checking" || status === "logging-in"
        ? "border-border/70 bg-background/50 text-muted"
        : "border-warning/40 bg-warning/10 text-warning";

  const label =
    status === "checking"
      ? "…"
      : status === "logging-in"
        ? "signing in…"
        : status === "connected"
          ? "OK"
          : "login";

  return (
    <button
      type="button"
      onClick={() => void refresh({ forceLogin: status !== "connected" })}
      title={
        status === "connected"
          ? detail || "AWS connected"
          : "Click to sign in with AWS SSO (browser)"
      }
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide transition-opacity hover:opacity-80 ${styles}`}
    >
      AWS {label}
    </button>
  );
}
