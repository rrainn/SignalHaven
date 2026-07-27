"use client";

/**
 * Steps of the first-run onboarding wizard, in display order.
 *
 * The order is the source of truth used by the wizard navigation and by
 * the persisted resume state. Adding a step is a single-edit change; the
 * shell renders the matching step component from the steps map.
 */
export const ONBOARDING_STEPS = [
	"welcome",
	"tuners",
	"epg",
	"storage",
	"mapping",
	"done"
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
	welcome: "Welcome",
	tuners: "Tuners",
	epg: "Guide data",
	storage: "Recordings",
	mapping: "Channel mapping",
	done: "Done"
};

/** localStorage key used to persist resume state + dismissal. */
export const ONBOARDING_STORAGE_KEY = "signalhaven:onboarding";

export type OnboardingPersistedState = {
	/** Step to resume on next mount; cleared after wizard completes. */
	step?: OnboardingStep | undefined;
	/**
	 * `true` once the user has completed or explicitly dismissed the wizard.
	 * Re-shown when the backend `firstRun` flag flips back to `true` (e.g.
	 * after the user resets all configuration), because the provider clears
	 * the flag whenever it observes a fresh first-run state.
	 */
	dismissed?: boolean | undefined;
};

export function readPersistedState(): OnboardingPersistedState {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const state = parsed as OnboardingPersistedState;
		const result: OnboardingPersistedState = {};
		if (
			typeof state.step === "string" &&
			(ONBOARDING_STEPS as readonly string[]).includes(state.step)
		) {
			result.step = state.step;
		}
		if (typeof state.dismissed === "boolean") {
			result.dismissed = state.dismissed;
		}
		return result;
	} catch {
		return {};
	}
}

export function writePersistedState(state: OnboardingPersistedState): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Storage may be disabled (private mode); the wizard still works,
		// it just won't be resumable across reloads.
	}
}

export function clearPersistedState(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
	} catch {
		// Ignore; see writePersistedState for rationale.
	}
}

export function nextStep(step: OnboardingStep): OnboardingStep {
	const idx = ONBOARDING_STEPS.indexOf(step);
	return ONBOARDING_STEPS[Math.min(idx + 1, ONBOARDING_STEPS.length - 1)]!;
}

export function prevStep(step: OnboardingStep): OnboardingStep {
	const idx = ONBOARDING_STEPS.indexOf(step);
	return ONBOARDING_STEPS[Math.max(idx - 1, 0)]!;
}
