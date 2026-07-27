"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode
} from "react";

/** Versioned key leaves room for future preference migrations. */
export const ADVANCED_MODE_STORAGE_KEY = "signalhaven.advanced-mode.v1";

interface AdvancedModeContextValue {
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
}

const AdvancedModeContext = createContext<AdvancedModeContextValue | null>(
	null
);

/** Reads the browser-only preference without making server rendering unsafe. */
export function readAdvancedMode(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(ADVANCED_MODE_STORAGE_KEY) === "true";
	} catch {
		// Privacy modes may deny storage access; advanced mode safely stays off.
		return false;
	}
}

/** Owns the local-only diagnostics preference and synchronizes browser tabs. */
export function AdvancedModeProvider({ children }: { children: ReactNode }) {
	const [enabled, setEnabledState] = useState(false);

	useEffect(() => {
		setEnabledState(readAdvancedMode());
		const onStorage = (event: StorageEvent) => {
			if (event.key === ADVANCED_MODE_STORAGE_KEY) {
				setEnabledState(event.newValue === "true");
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const setEnabled = useCallback((next: boolean) => {
		setEnabledState(next);
		try {
			window.localStorage.setItem(
				ADVANCED_MODE_STORAGE_KEY,
				next ? "true" : "false"
			);
		} catch {
			// The in-memory choice remains useful for the current tab.
		}
	}, []);

	const value = useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
	return (
		<AdvancedModeContext.Provider value={value}>
			{children}
		</AdvancedModeContext.Provider>
	);
}

/** Returns the app-owned advanced-mode preference. */
export function useAdvancedMode(): AdvancedModeContextValue {
	const value = useContext(AdvancedModeContext);
	if (!value) {
		throw new Error(
			"useAdvancedMode must be used inside <AdvancedModeProvider>"
		);
	}
	return value;
}

/** Supports isolated component tests that intentionally omit the app shell. */
export function useAdvancedModeOptional(): AdvancedModeContextValue | null {
	return useContext(AdvancedModeContext);
}
