"use client";

import {
	settingsDefaults,
	type EpgSource,
	type Settings,
	type Tuner
} from "@signalhaven/shared";
import { useEffect, useRef, useState } from "react";

import {
	getSystemStatus,
	listEpgSources,
	listTuners
} from "../../lib/api-client";
import { usePreferencesOptional } from "../_preferences/PreferencesProvider";
import { OnboardingWizard } from "./OnboardingWizard";
import {
	clearPersistedState,
	readPersistedState,
	writePersistedState,
	type OnboardingStep
} from "./state";

type ProviderState =
	| { kind: "idle" }
	| { kind: "loading" }
	| {
			kind: "ready";
			open: boolean;
			step: OnboardingStep | undefined;
			tuners: Tuner[];
			epgSources: EpgSource[];
			settings: Settings;
	  };

export type OnboardingProviderProps = {
	children: React.ReactNode;
};

/**
 * Boots the first-run wizard.
 *
 * Behaviour:
 *   - On mount, fetch `system/status`. When `firstRun === true` and the
 *     user has not previously dismissed the wizard, fetch the existing
 *     tuners / EPG sources / settings (used to pre-populate steps and
 *     suppress duplicate work) and open the wizard.
 *   - Persist the current step to localStorage (the wizard handles this
 *     itself) so closing and reopening the app resumes mid-flow.
 *   - When the user finishes or explicitly dismisses, store a flag so the
 *     wizard does not reappear on subsequent loads — unless the backend
 *     observes a fresh `firstRun === true` (e.g. after a reset), in which
 *     case the dismissal is cleared and the wizard runs again.
 *
 * Network failures are swallowed (the wizard is a UX nicety, not a hard
 * dependency); the underlying screens still load normally.
 */
export function OnboardingProvider({ children }: OnboardingProviderProps) {
	const preferences = usePreferencesOptional();
	const [state, setState] = useState<ProviderState>({ kind: "idle" });
	const bootStartedRef = useRef(false);

	useEffect(() => {
		// Production waits for the app-owned settings snapshot. The fallback
		// keeps this provider usable in isolated component tests.
		if (preferences?.status === "loading" || bootStartedRef.current) return;
		bootStartedRef.current = true;
		let cancelled = false;
		setState({ kind: "loading" });

		async function boot() {
			const persisted = readPersistedState();

			let status;
			try {
				status = await getSystemStatus();
			} catch {
				// Backend unreachable — bail quietly; we'll re-attempt on next
				// mount. The rest of the app handles its own offline UX.
				if (!cancelled) setState({ kind: "idle" });
				return;
			}

			// Reset the dismissal flag whenever the backend reports a fresh
			// first-run state. This is the "user resets" affordance from the
			// acceptance criteria — clearing all tuners/EPG/storage flips the
			// gate back, and the wizard reappears.
			if (status.firstRun && persisted.dismissed) {
				clearPersistedState();
				persisted.dismissed = false;
				persisted.step = undefined;
			}

			if (!status.firstRun || persisted.dismissed) {
				if (!cancelled) setState({ kind: "idle" });
				return;
			}

			const [tunersResult, epgResult, settingsResult] = await Promise.all([
				safe(() => listTuners()),
				safe(() => listEpgSources()),
				Promise.resolve(preferences?.settings ?? settingsDefaults)
			]);

			if (cancelled) return;
			if (!settingsResult) {
				// Settings are required to render the storage step; bail rather
				// than booting a half-broken wizard.
				setState({ kind: "idle" });
				return;
			}
			setState({
				kind: "ready",
				open: true,
				step: persisted.step,
				tuners: tunersResult?.items ?? [],
				epgSources: epgResult?.items ?? [],
				settings: settingsResult
			});
		}

		void boot();
		return () => {
			cancelled = true;
		};
	}, [preferences]);

	return (
		<>
			{children}
			{state.kind === "ready" && state.open ? (
				<OnboardingWizard
					open={state.open}
					initialStep={state.step}
					initialTuners={state.tuners}
					initialEpgSources={state.epgSources}
					initialSettings={state.settings}
					onClose={(reason) => {
						writePersistedState({ dismissed: true });
						setState((prev) =>
							prev.kind === "ready" ? { ...prev, open: false } : prev
						);
						// `reason` is part of the contract for callers/tests even
						// though we treat completion + dismissal identically here.
						void reason;
					}}
				/>
			) : null}
		</>
	);
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
	try {
		return await fn();
	} catch {
		return undefined;
	}
}
