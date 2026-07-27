"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode
} from "react";

import {
	isThemeMode,
	THEME_STORAGE_KEY,
	type ResolvedTheme,
	type ThemeMode
} from "./theme";

type ThemeContextValue = {
	/** User-selected mode (`light`, `dark`, or `system`). */
	mode: ThemeMode;
	/** Palette currently applied to `<html>` (resolves `system`). */
	resolved: ResolvedTheme;
	setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
	if (typeof window === "undefined") return "system";
	try {
		const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
		return isThemeMode(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

function systemPrefersDark(): boolean {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(mode: ThemeMode): ResolvedTheme {
	if (mode === "system") return systemPrefersDark() ? "dark" : "light";
	return mode;
}

function applyResolved(resolved: ResolvedTheme): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.classList.toggle("dark", resolved === "dark");
	root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	// SSR renders with the default; the inline bootstrap script sets the
	// correct class on <html> before hydration so users never see a flash.
	const [mode, setModeState] = useState<ThemeMode>("system");
	const [resolved, setResolved] = useState<ResolvedTheme>("light");
	// Avoid writing to localStorage on the very first effect run, which would
	// otherwise overwrite a value written by another tab.
	const initialised = useRef(false);

	useEffect(() => {
		const stored = readStoredMode();
		setModeState(stored);
		const next = resolve(stored);
		setResolved(next);
		applyResolved(next);
		initialised.current = true;
	}, []);

	// React to OS preference changes when in `system` mode.
	useEffect(() => {
		if (
			typeof window === "undefined" ||
			typeof window.matchMedia !== "function"
		) {
			return;
		}
		const mql = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (event: MediaQueryListEvent) => {
			if (mode !== "system") return;
			const next: ResolvedTheme = event.matches ? "dark" : "light";
			setResolved(next);
			applyResolved(next);
		};
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, [mode]);

	const setMode = useCallback((next: ThemeMode) => {
		setModeState(next);
		const r = resolve(next);
		setResolved(r);
		applyResolved(r);
		if (typeof window !== "undefined") {
			try {
				window.localStorage.setItem(THEME_STORAGE_KEY, next);
			} catch {
				/* private mode / storage disabled — preference simply won't persist. */
			}
		}
	}, []);

	const value = useMemo<ThemeContextValue>(
		() => ({ mode, resolved, setMode }),
		[mode, resolved, setMode]
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error("useTheme must be used inside <ThemeProvider>");
	}
	return ctx;
}
