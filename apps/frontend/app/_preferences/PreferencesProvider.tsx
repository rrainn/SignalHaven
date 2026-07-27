"use client";

import {
	settingsDefaults,
	settingsSchema,
	type EventMessage,
	type Settings,
	type SettingsPatch
} from "@signalhaven/shared";
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

import { getSettings, updateSettings } from "../../lib/api-client";
import { useWebSocketEvents } from "../../lib/ws-client";
import { applyAppearance, persistAppearance } from "../_settings/appearance";
import { useTheme } from "../_theme/ThemeProvider";

export type PreferencesStatus = "loading" | "ready" | "error";

export type PreferencesContextValue = {
	/** Defaults remain usable during loading and after a failed read. */
	settings: Settings;
	status: PreferencesStatus;
	error: Error | null;
	/** Serializes writes so an older response cannot replace a newer choice. */
	saveSettings: (patch: SettingsPatch) => Promise<Settings>;
	/** Adopts an already-validated full response from a legacy settings form. */
	replaceSettings: (settings: Settings) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

type PreferencesState = Pick<
	PreferencesContextValue,
	"settings" | "status" | "error"
>;

/**
 * Owns the single application settings snapshot.
 *
 * Screens subscribe to this provider instead of issuing their own settings
 * GETs. Successful PATCH responses and settings WebSocket events replace the
 * snapshot, which makes open routes react immediately without a hard reload.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
	const { setMode } = useTheme();
	const [state, setState] = useState<PreferencesState>({
		settings: settingsDefaults,
		status: "loading",
		error: null
	});
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

	const replaceSettings = useCallback((settings: Settings) => {
		setState({ settings, status: "ready", error: null });
	}, []);

	useEffect(() => {
		let cancelled = false;
		getSettings()
			.then((settings) => {
				if (!cancelled) replaceSettings(settings);
			})
			.catch((failure: unknown) => {
				if (cancelled) return;
				const error = normalizeError(
					failure,
					"Saved preferences could not be loaded"
				);
				// Preserve the validation/network cause for production diagnostics.
				console.error("[preferences] failed to load saved settings", failure);
				setState({ settings: settingsDefaults, status: "error", error });
			});
		return () => {
			cancelled = true;
		};
	}, [replaceSettings]);

	useEffect(() => {
		if (state.status === "loading") return;
		const { ui } = state.settings;
		setMode(ui.theme);
		applyAppearance(ui);
		persistAppearance(ui);
	}, [setMode, state.settings, state.status]);

	const handleSettingsEvent = useCallback(
		(event: EventMessage) => {
			if (event.topic !== "settings" || event.event !== "updated") return;
			const payload = event.data as { settings?: unknown };
			const parsed = settingsSchema.safeParse(payload.settings);
			if (parsed.success) {
				replaceSettings(parsed.data);
				return;
			}
			console.error(
				"[preferences] ignored invalid settings event",
				parsed.error
			);
		},
		[replaceSettings]
	);

	useWebSocketEvents({
		topics: ["settings"],
		onEvent: handleSettingsEvent
	});

	const saveSettings = useCallback(
		(patch: SettingsPatch): Promise<Settings> => {
			const committed = saveQueueRef.current
				.catch(() => undefined)
				.then(() => updateSettings(patch))
				.then((settings) => {
					replaceSettings(settings);
					return settings;
				})
				.catch((failure: unknown) => {
					const error = normalizeError(
						failure,
						"Preferences could not be saved"
					);
					setState((current) => ({ ...current, error }));
					throw failure;
				});

			saveQueueRef.current = committed.then(
				() => undefined,
				() => undefined
			);
			return committed;
		},
		[replaceSettings]
	);

	const value = useMemo<PreferencesContextValue>(
		() => ({ ...state, saveSettings, replaceSettings }),
		[state, saveSettings, replaceSettings]
	);

	return (
		<PreferencesContext.Provider value={value}>
			{children}
		</PreferencesContext.Provider>
	);
}

/** Returns null for isolated component tests that intentionally omit the app boundary. */
export function usePreferencesOptional(): PreferencesContextValue | null {
	return useContext(PreferencesContext);
}

/** Returns the application preference state and requires the root provider. */
export function usePreferences(): PreferencesContextValue {
	const preferences = usePreferencesOptional();
	if (!preferences) {
		throw new Error("usePreferences must be used inside <PreferencesProvider>");
	}
	return preferences;
}

/** Resolves an explicit test/fixture override before the app preference. */
export function use24HourClock(override?: boolean): boolean {
	const preferences = usePreferencesOptional();
	return override ?? preferences?.settings.ui.use24HourClock ?? false;
}

function normalizeError(failure: unknown, fallback: string): Error {
	if (failure instanceof Error) return failure;
	return new Error(fallback);
}
