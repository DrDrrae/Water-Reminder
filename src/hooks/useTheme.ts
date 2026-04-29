// hooks/useTheme.ts — resolves the effective UI theme and applies it to the DOM.

import { useState, useEffect } from "react";
import type { EffectiveTheme, ThemePreference } from "../types";
import { getSystemPrefersDark } from "../utils/theme";

/** Resolves the effective theme, syncs to the DOM, and tracks system preference changes. */
export function useTheme(themePreference: ThemePreference): EffectiveTheme {
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    setSystemPrefersDark(mq.matches);

    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handleChange);
      return () => mq.removeEventListener("change", handleChange);
    }
    // Fallback for older browsers.
    mq.addListener(handleChange);
    return () => mq.removeListener(handleChange);
  }, []);

  const effectiveTheme: EffectiveTheme =
    themePreference === "AlwaysDark"
      ? "dark"
      : themePreference === "AlwaysLight"
        ? "light"
        : systemPrefersDark
          ? "dark"
          : "light";

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    document.documentElement.style.colorScheme = effectiveTheme;
  }, [effectiveTheme]);

  return effectiveTheme;
}
