// utils/theme.ts — system colour scheme detection.

/** Returns true when the OS is currently using a dark colour scheme. */
export function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
