"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The console theme.
 *
 * Dark is the default — the console is a tool people keep open all day — and
 * the light palette is the same system with the surfaces inverted. The choice
 * is stored, applied as `data-theme` on the document, and follows the system
 * preference until the person says otherwise.
 */

const STORAGE_KEY = "mc-theme";
export type Theme = "dark" | "light";

function read(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* a private window without storage still gets the theme */
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");

  // The stored theme is applied before the first paint of the body, so the
  // page never flashes the wrong surfaces.
  useEffect(() => {
    const initial = read();
    setTheme(initial);
    apply(initial);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      apply(next);
      return next;
    });
  }, []);

  return [theme, toggle];
}
