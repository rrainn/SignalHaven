"use client";

import {
	userPreferencesDefaults,
	type UserPreferences,
	type UserPreferencesPatch
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

import { getPreferences, updatePreferences } from "../../lib/api-client";
import type { AccountPreferencesBootstrap } from "../_auth/AuthProvider";
import { applyAppearance, persistAppearance } from "../_settings/appearance";
import { useTheme } from "../_theme/ThemeProvider";

export type PreferencesStatus = "loading" | "ready" | "error";

export type PreferencesContextValue = {
	/** Defaults are inert until status is ready; mutation surfaces fail closed. */
	preferences: UserPreferences;
	status: PreferencesStatus;
	error: Error | null;
	/** Retries a failed account snapshot before protected surfaces remount. */
	retry: () => Promise<void>;
	/** Serializes writes so an older response cannot replace a newer choice. */
	savePreferences: (patch: UserPreferencesPatch) => Promise<UserPreferences>;
	/** Adopts an already-validated response returned by another preference form. */
	replacePreferences: (preferences: UserPreferences) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

type PreferencesState = Pick<
	PreferencesContextValue,
	"preferences" | "status" | "error"
>;

/**
 * Owns the signed-in account's single preference snapshot.
 *
 * Screens subscribe here instead of issuing their own preference GETs.
 * Successful serialized PATCH responses replace the snapshot so open routes
 * react immediately and queued writes cannot commit out of order.
 */
export function PreferencesProvider(props: {
	accountId: string;
	authGeneration: number;
	bootstrap: AccountPreferencesBootstrap | null;
	children: ReactNode;
}) {
	// The key gives every authenticated generation an isolated provider lifecycle.
	return (
		<AccountPreferencesProvider
			key={`${props.accountId}:${props.authGeneration}`}
			{...props}
		/>
	);
}

/** Owns one identity-bound preference lifecycle after bootstrap validation. */
function AccountPreferencesProvider({
	accountId,
	authGeneration,
	bootstrap,
	children
}: {
	accountId: string;
	authGeneration: number;
	bootstrap: AccountPreferencesBootstrap | null;
	children: ReactNode;
}) {
	const { setMode } = useTheme();
	const matchingBootstrap =
		bootstrap?.userId === accountId && bootstrap.generation === authGeneration
			? bootstrap
			: null;
	const [state, setState] = useState<PreferencesState>(() =>
		initialPreferencesState(matchingBootstrap)
	);
	const loadOnMount = matchingBootstrap === null;
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
	const generationRef = useRef(0);
	const activeRef = useRef(false);

	const replacePreferences = useCallback((preferences: UserPreferences) => {
		setState({ preferences, status: "ready", error: null });
	}, []);

	const retry = useCallback(async () => {
		const generation = ++generationRef.current;
		setState({
			preferences: userPreferencesDefaults,
			status: "loading",
			error: null
		});
		try {
			const preferences = await getPreferences();
			if (!activeRef.current || generation !== generationRef.current) return;
			replacePreferences(preferences);
		} catch (failure) {
			if (!activeRef.current || generation !== generationRef.current) return;
			const error = normalizeError(
				failure,
				"Saved preferences could not be loaded"
			);
			// Preserve the validation/network cause for production diagnostics.
			console.error("[preferences] failed to load saved settings", failure);
			setState({
				preferences: userPreferencesDefaults,
				status: "error",
				error
			});
		}
	}, [replacePreferences]);

	useEffect(() => {
		activeRef.current = true;
		if (loadOnMount) void retry();
		return () => {
			// Invalidate every queued callback before a different account can mount.
			activeRef.current = false;
			generationRef.current += 1;
			setMode("system");
			applyAppearance(userPreferencesDefaults.ui);
			persistAppearance(userPreferencesDefaults.ui);
		};
	}, [loadOnMount, retry, setMode]);

	useEffect(() => {
		if (state.status === "loading") return;
		const { ui } = state.preferences;
		setMode(ui.theme);
		applyAppearance(ui);
		persistAppearance(ui);
	}, [setMode, state.preferences, state.status]);

	const savePreferences = useCallback(
		(patch: UserPreferencesPatch): Promise<UserPreferences> => {
			if (state.status !== "ready") {
				return Promise.reject(
					new Error(
						"Preferences must finish loading before they can be changed"
					)
				);
			}
			const generation = generationRef.current;
			const committed = saveQueueRef.current
				.catch(() => undefined)
				.then(() => {
					if (!activeRef.current || generation !== generationRef.current) {
						throw new PreferencesOperationCancelled();
					}
					return updatePreferences(patch);
				})
				.then((preferences) => {
					if (!activeRef.current || generation !== generationRef.current) {
						throw new PreferencesOperationCancelled();
					}
					replacePreferences(preferences);
					return preferences;
				})
				.catch((failure: unknown) => {
					if (
						!(failure instanceof PreferencesOperationCancelled) &&
						activeRef.current &&
						generation === generationRef.current
					) {
						const error = normalizeError(
							failure,
							"Preferences could not be saved"
						);
						setState((current) => ({ ...current, error }));
					}
					throw failure;
				});

			saveQueueRef.current = committed.then(
				() => undefined,
				() => undefined
			);
			return committed;
		},
		[replacePreferences, state.status]
	);

	const value = useMemo<PreferencesContextValue>(
		() => ({ ...state, retry, savePreferences, replacePreferences }),
		[state, retry, savePreferences, replacePreferences]
	);

	return (
		<PreferencesContext.Provider value={value}>
			{children}
		</PreferencesContext.Provider>
	);
}

/** Converts a matching speculative result into the provider's fail-closed state. */
function initialPreferencesState(
	bootstrap: AccountPreferencesBootstrap | null
): PreferencesState {
	if (!bootstrap) {
		return {
			preferences: userPreferencesDefaults,
			status: "loading",
			error: null
		};
	}
	if (bootstrap.status === "ready") {
		return {
			preferences: bootstrap.preferences,
			status: "ready",
			error: null
		};
	}
	return {
		preferences: userPreferencesDefaults,
		status: "error",
		error: bootstrap.error
	};
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
	return override ?? preferences?.preferences.ui.use24HourClock ?? false;
}

function normalizeError(failure: unknown, fallback: string): Error {
	if (failure instanceof Error) return failure;
	return new Error(fallback);
}

/** Marks work intentionally dropped because its owning account unmounted. */
class PreferencesOperationCancelled extends Error {
	constructor() {
		super("Preference operation cancelled because the account changed");
		this.name = "PreferencesOperationCancelled";
	}
}
