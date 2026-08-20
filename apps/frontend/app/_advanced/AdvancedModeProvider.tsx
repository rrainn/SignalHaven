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

/** Owns administrator diagnostics and synchronizes the local preference safely. */
export function AdvancedModeProvider({
	children,
	isAdministrator = true
}: {
	children: ReactNode;
	/** Isolated previews default to admin; the app always supplies the account role. */
	isAdministrator?: boolean;
}) {
	const [enabled, setEnabledState] = useState(false);

	useEffect(() => {
		if (!isAdministrator) {
			// A browser can be shared by accounts, so revoke the browser-wide flag
			// before standard-user components or API errors can observe it.
			setEnabledState(false);
			try {
				window.localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "false");
			} catch {
				// The in-memory permission boundary still keeps diagnostics hidden.
			}
			return;
		}
		setEnabledState(readAdvancedMode());
		const onStorage = (event: StorageEvent) => {
			if (event.key === ADVANCED_MODE_STORAGE_KEY) {
				setEnabledState(event.newValue === "true");
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [isAdministrator]);

	const setEnabled = useCallback(
		(next: boolean) => {
			if (!isAdministrator) return;
			setEnabledState(next);
			try {
				window.localStorage.setItem(
					ADVANCED_MODE_STORAGE_KEY,
					next ? "true" : "false"
				);
			} catch {
				// The in-memory choice remains useful for the current tab.
			}
		},
		[isAdministrator]
	);

	const value = useMemo(
		() => ({ enabled: isAdministrator && enabled, setEnabled }),
		[enabled, isAdministrator, setEnabled]
	);
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
