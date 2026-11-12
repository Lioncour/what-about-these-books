"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

const LIBRARY_WIDTH_KEY = "wab-library-width";
const LIBRARY_COLLAPSED_KEY = "wab-library-collapsed";
const LEGACY_SIDEBAR_WIDTH_KEY = "wab-sidebar-width";
const LEGACY_SIDEBAR_COLLAPSED_KEY = "wab-sidebar-collapsed";
const LEGACY_COMPANION_COLLAPSED_KEY = "wab-companion-collapsed";
const LIBRARY_MIN = 260;
const LIBRARY_MAX = 420;
const LIBRARY_DEFAULT = 340;

function clampLibraryWidth(width: number): number {
  return Math.min(LIBRARY_MAX, Math.max(LIBRARY_MIN, width));
}

interface RailPrefs {
  width: number;
  collapsed: boolean;
}

// The rail's preferences live in localStorage; React reads them through
// useSyncExternalStore, so the server render uses the defaults and the stored
// values arrive on hydration without setting state from an effect.
let prefs: RailPrefs | null = null;
const listeners = new Set<() => void>();

function loadPrefs(): RailPrefs {
  if (prefs) return prefs;
  let width = LIBRARY_DEFAULT;
  let collapsed = false;
  try {
    const storedWidth =
      localStorage.getItem(LIBRARY_WIDTH_KEY) || localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY);
    const parsed = Number(storedWidth);
    if (storedWidth && Number.isFinite(parsed)) width = clampLibraryWidth(parsed);
    const stored =
      localStorage.getItem(LIBRARY_COLLAPSED_KEY) ??
      localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY) ??
      localStorage.getItem(LEGACY_COMPANION_COLLAPSED_KEY);
    collapsed = stored === "1";
  } catch {
    /* ignore */
  }
  prefs = { width, collapsed };
  return prefs;
}

function savePrefs(next: Partial<RailPrefs>) {
  prefs = { ...loadPrefs(), ...next };
  try {
    localStorage.setItem(LIBRARY_WIDTH_KEY, String(prefs.width));
    localStorage.setItem(LIBRARY_COLLAPSED_KEY, prefs.collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Width and collapsed state of the library rail: remembered, drag to resize, `]` / `[` keys. */
export function useLibraryRail() {
  const width = useSyncExternalStore(subscribe, () => loadPrefs().width, () => LIBRARY_DEFAULT);
  const collapsed = useSyncExternalStore(subscribe, () => loadPrefs().collapsed, () => false);
  const resizingRef = useRef(false);

  const setCollapsed = useCallback((next: boolean) => savePrefs({ collapsed: next }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "input" || target?.isContentEditable === true) return;

      if (event.key === "]") {
        event.preventDefault();
        savePrefs({ collapsed: !loadPrefs().collapsed });
      } else if (event.key === "[") {
        event.preventDefault();
        savePrefs({ collapsed: false });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!resizingRef.current || loadPrefs().collapsed) return;
      savePrefs({ width: clampLibraryWidth(event.clientX) });
    };
    const onMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return { width, collapsed, setCollapsed, startResize };
}
