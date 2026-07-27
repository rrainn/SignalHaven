import { describe, expect, it, beforeEach } from "vitest";

import {
	ONBOARDING_STEPS,
	clearPersistedState,
	nextStep,
	prevStep,
	readPersistedState,
	writePersistedState
} from "../../app/_onboarding/state";

beforeEach(() => {
	window.localStorage.clear();
});

describe("onboarding state helpers", () => {
	it("returns an empty object when nothing is persisted", () => {
		expect(readPersistedState()).toEqual({});
	});

	it("round-trips persisted state through localStorage", () => {
		writePersistedState({ step: "epg", dismissed: false });
		expect(readPersistedState()).toEqual({ step: "epg", dismissed: false });
	});

	it("ignores unknown step values", () => {
		window.localStorage.setItem(
			"signalhaven:onboarding",
			JSON.stringify({ step: "not-a-real-step" })
		);
		expect(readPersistedState()).toEqual({});
	});

	it("ignores corrupt JSON without throwing", () => {
		window.localStorage.setItem("signalhaven:onboarding", "not json{");
		expect(readPersistedState()).toEqual({});
	});

	it("clears persisted state", () => {
		writePersistedState({ dismissed: true });
		clearPersistedState();
		expect(readPersistedState()).toEqual({});
	});

	it("nextStep advances and stops at 'done'", () => {
		expect(nextStep("welcome")).toBe("tuners");
		expect(nextStep("mapping")).toBe("done");
		expect(nextStep("done")).toBe("done");
	});

	it("prevStep retreats and stops at 'welcome'", () => {
		expect(prevStep("tuners")).toBe("welcome");
		expect(prevStep("welcome")).toBe("welcome");
	});

	it("ONBOARDING_STEPS contains the canonical step order", () => {
		expect(ONBOARDING_STEPS).toEqual([
			"welcome",
			"tuners",
			"epg",
			"storage",
			"mapping",
			"done"
		]);
	});
});
