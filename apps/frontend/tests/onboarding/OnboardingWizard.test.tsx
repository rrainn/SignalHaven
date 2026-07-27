import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OnboardingWizard } from "../../app/_onboarding/OnboardingWizard";

vi.mock("../../lib/ws-client", () => ({
	useWebSocketEvents: () => "open"
}));

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		discoverTuners: vi.fn().mockResolvedValue({ results: [] }),
		createTuner: vi.fn(),
		syncTunerChannels: vi.fn(),
		createEpgSource: vi.fn(),
		updateSettings: vi.fn()
	};
});

const baseSettings = {
	storage: { path: null, quotaGb: null },
	transcoding: {
		enabled: false,
		preset: "balanced" as const,
		videoBitrateKbps: 4000,
		audioBitrateKbps: 192,
		defaultProfile: "direct" as const,
		hwaccel: "auto" as const,
		availableHwaccels: [],
		captionsEnabled: true
	},
	ui: {
		theme: "system" as const,
		epgHoursVisible: 4,
		use24HourClock: false,
		density: "comfortable" as const,
		animations: true
	},
	recordings: { paddingBeforeSec: 0, paddingAfterSec: 0 },
	channels: { favorites: [], hidden: [], order: [] },
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {}
	},
	timeShift: {
		enabled: true,
		bufferPath: null,
		durationMinutes: 60,
		maxDiskGb: 10,
		idleGraceSeconds: 30
	},
	observability: { debugBundleEnabled: false }
};

beforeEach(() => {
	window.localStorage.clear();
});

describe("OnboardingWizard", () => {
	it("starts on the Welcome step and renders the progress rail", () => {
		render(
			<OnboardingWizard
				open
				initialTuners={[]}
				initialEpgSources={[]}
				initialSettings={baseSettings}
				onClose={() => {}}
			/>
		);

		expect(screen.getByRole("dialog")).toHaveAccessibleName(
			/welcome to signalhaven/i
		);
		expect(screen.getByText(/step 1 of 6/i)).toBeInTheDocument();
		expect(screen.getByTestId("onboarding-step-welcome")).toBeInTheDocument();
	});

	it("can be resumed from a non-welcome step", () => {
		render(
			<OnboardingWizard
				open
				initialStep="storage"
				initialTuners={[]}
				initialEpgSources={[]}
				initialSettings={baseSettings}
				onClose={() => {}}
			/>
		);
		expect(screen.getByTestId("onboarding-step-storage")).toBeInTheDocument();
		expect(screen.getByText(/step 4 of 6/i)).toBeInTheDocument();
	});

	it("navigates forward through every step using the next/skip controls", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(
			<OnboardingWizard
				open
				initialTuners={[]}
				initialEpgSources={[]}
				initialSettings={baseSettings}
				onClose={onClose}
			/>
		);

		// welcome -> tuners
		await user.click(screen.getByRole("button", { name: /get started/i }));
		expect(screen.getByTestId("onboarding-step-tuners")).toBeInTheDocument();

		// tuners -> epg (defer tuner setup)
		await user.click(screen.getByRole("button", { name: /set up later/i }));
		expect(screen.getByTestId("onboarding-step-epg")).toBeInTheDocument();

		// epg -> storage
		await user.click(screen.getByRole("button", { name: /^continue$/i }));
		expect(screen.getByTestId("onboarding-step-storage")).toBeInTheDocument();

		// storage -> mapping (defer recording storage setup)
		await user.click(screen.getByRole("button", { name: /set up later/i }));
		expect(screen.getByTestId("onboarding-step-mapping")).toBeInTheDocument();

		// mapping -> done
		await user.click(screen.getByRole("button", { name: /looks good/i }));
		expect(screen.getByTestId("onboarding-step-done")).toBeInTheDocument();

		// done -> close as completed
		await user.click(screen.getByRole("button", { name: /open signalhaven/i }));
		expect(onClose).toHaveBeenCalledWith("completed");
	});

	it("persists the current step to localStorage so closing mid-flow resumes there", async () => {
		const user = userEvent.setup();
		render(
			<OnboardingWizard
				open
				initialTuners={[]}
				initialEpgSources={[]}
				initialSettings={baseSettings}
				onClose={() => {}}
			/>
		);

		await user.click(screen.getByRole("button", { name: /get started/i }));

		await waitFor(() => {
			const raw = window.localStorage.getItem("signalhaven:onboarding");
			expect(raw).not.toBeNull();
			expect(JSON.parse(raw as string)).toMatchObject({ step: "tuners" });
		});
	});

	it("dismissing via Escape closes with reason='dismissed'", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(
			<OnboardingWizard
				open
				initialTuners={[]}
				initialEpgSources={[]}
				initialSettings={baseSettings}
				onClose={onClose}
			/>
		);

		await user.keyboard("{Escape}");
		await waitFor(() => expect(onClose).toHaveBeenCalledWith("dismissed"));
	});
});
