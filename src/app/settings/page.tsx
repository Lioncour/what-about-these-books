"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import AdvancedSection from "@/components/settings/AdvancedSection";
import HowITalkSection from "@/components/settings/HowITalkSection";
import LibraryToolsSection from "@/components/settings/LibraryToolsSection";
import PersonalitySection from "@/components/settings/PersonalitySection";
import TokenUsageSection from "@/components/settings/TokenUsageSection";
import { DEFAULT_SETTINGS, type AISettings, type ModelRoutingStatus } from "@/components/settings/types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS);
  const [routing, setRouting] = useState<ModelRoutingStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(({ modelRoutingStatus, ...data }) => {
        setSettings({
          ...DEFAULT_SETTINGS,
          ...data,
          companionMode: data.companionMode !== false,
          modelRouting: data.modelRouting || {},
        });
        setRouting(modelRoutingStatus || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const post = useCallback(async (body: unknown) => {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { modelRoutingStatus?: ModelRoutingStatus } | null;
    if (res.ok && data?.modelRoutingStatus) setRouting(data.modelRoutingStatus);
    return res.ok;
  }, []);

  const save = useCallback(async () => {
    if (!(await post(settings))) return;
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }, [post, settings]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="app-chrome-header border-b border-border/50 bg-surface/90 px-6 pb-4 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link
            href="/"
            className="rounded-xl border border-border/60 px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
          >
            ← Back
          </Link>
          <BrandMark className="h-8 w-8 shrink-0" />
          <h1 className="font-display text-xl font-semibold tracking-tight">Settings</h1>
          {saved && <span className="text-xs text-primary">Saved</span>}
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-10 px-8 py-12">
        <HowITalkSection settings={settings} update={setSettings} />
        <TokenUsageSection />
        <PersonalitySection settings={settings} update={setSettings} />
        <AdvancedSection
          settings={settings}
          update={setSettings}
          routing={routing}
          onRecheck={() => post({ recheckModels: true })}
        />
        <LibraryToolsSection />

        <div className="flex justify-end gap-2 pb-10">
          <Link
            href="/"
            className="rounded-xl border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </Link>
          <button
            type="button"
            onClick={() => void save()}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-[#e8ddd0] hover:bg-primary-hover"
          >
            Save settings
          </button>
        </div>
      </main>
    </div>
  );
}
