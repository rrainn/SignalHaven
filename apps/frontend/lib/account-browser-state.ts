import type { UserRole } from "@signalhaven/shared";

const ADVANCED_MODE_STORAGE_KEY = "signalhaven.advanced-mode.v1";
const THEME_STORAGE_KEY = "signalhaven:theme";
const DENSITY_STORAGE_KEY = "signalhaven:density";
const ANIMATIONS_STORAGE_KEY = "signalhaven:animations";

let authenticatedRole: UserRole | null = null;

/** Records the authenticated role in memory so diagnostics never trust storage alone. */
export function setAuthenticatedClientRole(role: UserRole): void {
	authenticatedRole = role;
}

/** Revokes diagnostic privilege while the server is resolving the active account. */
export function clearAuthenticatedClientRole(): void {
	authenticatedRole = null;
}

/** Allows detailed errors only for the currently authenticated administrator. */
export function mayShowAdvancedDiagnostics(): boolean {
	if (authenticatedRole !== "admin" || typeof window === "undefined") {
		return false;
	}
	try {
		return window.localStorage.getItem(ADVANCED_MODE_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

/** Removes browser-global account presentation and privilege state at teardown. */
export function clearAccountBrowserState(): void {
	authenticatedRole = null;
	if (typeof window !== "undefined") {
		try {
			window.localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "false");
			window.localStorage.setItem(THEME_STORAGE_KEY, "system");
			window.localStorage.setItem(DENSITY_STORAGE_KEY, "comfortable");
			window.localStorage.setItem(ANIMATIONS_STORAGE_KEY, "on");
		} catch {
			// DOM cleanup below still prevents account presentation from lingering.
		}
	}
	if (typeof document !== "undefined") {
		const root = document.documentElement;
		root.removeAttribute("data-density");
		root.removeAttribute("data-animations");
		const prefersDark =
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches;
		root.classList.toggle("dark", prefersDark);
		root.style.colorScheme = prefersDark ? "dark" : "light";
	}
}
