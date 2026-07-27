import type { Density } from "@signalhaven/shared";

/**
 * localStorage keys for the appearance preferences. The theme key lives
 * in `_theme/theme.ts` because it predates this module and the inline
 * bootstrap script depends on its exact name.
 */
export const DENSITY_STORAGE_KEY = "signalhaven:density";
export const ANIMATIONS_STORAGE_KEY = "signalhaven:animations";

export type AppearancePrefs = {
	density: Density;
	animations: boolean;
};

/**
 * Apply the appearance choices to `<html>` so styles can react via
 * Tailwind's `data-*` selectors and the global motion-disable hook
 * picks them up immediately.
 *
 * `data-density="compact"` is interpreted by component variants;
 * `data-animations="off"` collapses CSS transitions to `none` (see
 * `globals.css`). Both attributes are removed when the value is the
 * default so unstyled pages still look correct in tests.
 */
export function applyAppearance(prefs: AppearancePrefs): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (prefs.density === "compact") {
		root.setAttribute("data-density", "compact");
	} else {
		root.removeAttribute("data-density");
	}
	if (!prefs.animations) {
		root.setAttribute("data-animations", "off");
	} else {
		root.removeAttribute("data-animations");
	}
}

/**
 * Mirror appearance prefs to `localStorage` so the inline bootstrap
 * script in `<head>` can apply them on next paint with no flash.
 */
export function persistAppearance(prefs: AppearancePrefs): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(DENSITY_STORAGE_KEY, prefs.density);
		window.localStorage.setItem(
			ANIMATIONS_STORAGE_KEY,
			prefs.animations ? "on" : "off"
		);
	} catch {
		/* private mode / disabled storage — preference simply won't persist. */
	}
}

/**
 * Tiny inline script that runs in `<head>` (alongside the theme bootstrap)
 * so density / animations are applied before React hydrates. Mirrors
 * {@link applyAppearance} but in plain ES5 to avoid any runtime deps.
 */
export const appearanceBootstrapScript = `(() => {
  try {
    var root = document.documentElement;
    var density = localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
    if (density === 'compact') root.setAttribute('data-density', 'compact');
    else root.removeAttribute('data-density');
    var anim = localStorage.getItem(${JSON.stringify(ANIMATIONS_STORAGE_KEY)});
    if (anim === 'off') root.setAttribute('data-animations', 'off');
    else root.removeAttribute('data-animations');
  } catch (_) {
    /* localStorage may be unavailable; fall back to defaults. */
  }
})();`;
