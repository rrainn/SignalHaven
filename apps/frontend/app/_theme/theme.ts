/**
 * Theme system constants and helpers.
 *
 * Three modes are supported:
 *   - `"light"`  – force the light palette
 *   - `"dark"`   – force the dark palette
 *   - `"system"` – follow `prefers-color-scheme` (default)
 *
 * The user's choice is persisted in `localStorage` under
 * {@link THEME_STORAGE_KEY}. The actually-applied palette is reflected as
 * either an empty string or the `"dark"` class on the root `<html>` element.
 */

export const THEME_STORAGE_KEY = "signalhaven:theme";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_MODES: readonly ThemeMode[] = ["light", "system", "dark"];

export function isThemeMode(value: unknown): value is ThemeMode {
	return value === "light" || value === "dark" || value === "system";
}

/**
 * Inline script body executed *before* React hydrates so the correct
 * palette class is set on `<html>`. This eliminates the flash-of-wrong-theme
 * when the user has selected a non-`system` preference or when the OS
 * prefers dark mode.
 *
 * Kept tiny and dependency-free — it runs synchronously in `<head>`.
 */
export const themeBootstrapScript = `(() => {
  try {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var stored = localStorage.getItem(key);
    var mode = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
    var resolved = mode;
    if (mode === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var root = document.documentElement;
    if (resolved === 'dark') root.classList.add('dark'); else root.classList.remove('dark');
    root.style.colorScheme = resolved;
  } catch (_) {
    /* localStorage / matchMedia may be unavailable; fall back to default. */
  }
})();`;
