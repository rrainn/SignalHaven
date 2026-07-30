import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OnboardingWizard } from "../../app/_onboarding/OnboardingWizard";
import {
	listEpgSources,
	refreshEpgSource,
	syncTunerChannels
} from "../../lib/api-client";

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
		listEpgSources: vi.fn().mockResolvedValue({ items: [] }),
		refreshEpgSource: vi.fn().mockResolvedValue({
			channelsSeen: 0,
			programsSeen: 0,
			channelsUpserted: 0,
			programsUpserted: 0,
			programsInserted: 0,
			programsChanged: 0,
			programsUnchanged: 0,
			programsPruned: 0,
			durationMs: 0
		}),
		updateSettings: vi.fn()
	};
});

const enabledEpgSource = {
	id: "11111111-1111-4111-8111-111111111111",
	kind: "xmltv" as const,
	name: "Primary guide",
	url: "https://example.com/guide.xml",
	filePath: null,
	tunerId: null,
	refreshIntervalMinutes: 720,
	timezone: null,
	enabled: true,
	lastRefreshAt: null,
	lastRefreshStatus: null,
	lastRefreshError: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z"
};

const configuredTuner = {
	id: "22222222-2222-4222-8222-222222222222",
	kind: "hdhomerun" as const,
	name: "Living room tuner",
	config: { host: "http://192.168.1.50" },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z"
};

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
	vi.mocked(listEpgSources).mockReset().mockResolvedValue({ items: [] });
	vi.mocked(refreshEpgSource).mockClear();
	vi.mocked(syncTunerChannels).mockReset();
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
		const guideInvalidated = vi.fn();
		window.addEventListener("signalhaven:guide-invalidate", guideInvalidated);
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
		expect(guideInvalidated).toHaveBeenCalledOnce();
		window.removeEventListener(
			"signalhaven:guide-invalidate",
			guideInvalidated
		);
	});

	it("refreshes sources that finish loading after setup reaches Done", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		let resolveSources!: (value: { items: [typeof enabledEpgSource] }) => void;
		vi.mocked(listEpgSources).mockReturnValue(
			new Promise((resolve) => {
				resolveSources = resolve;
			})
		);
		render(
			<OnboardingWizard
				open
				initialStep="epg"
				initialTuners={[]}
				initialEpgSources={[]}
				initialSettings={baseSettings}
				onClose={onClose}
			/>
		);

		// Complete setup before the server-provisioned HDHomeRun source is returned.
		await user.click(screen.getByRole("button", { name: /^continue$/i }));
		await user.click(screen.getByRole("button", { name: /set up later/i }));
		await user.click(screen.getByRole("button", { name: /looks good/i }));
		expect(screen.getByTestId("onboarding-step-done")).toBeInTheDocument();
		expect(refreshEpgSource).not.toHaveBeenCalled();

		await act(async () => {
			resolveSources({ items: [enabledEpgSource] });
		});

		await waitFor(() => {
			expect(refreshEpgSource).toHaveBeenCalledOnce();
			expect(refreshEpgSource).toHaveBeenCalledWith(enabledEpgSource.id);
		});
		expect(onClose).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /open signalhaven/i }));
		expect(onClose).toHaveBeenCalledWith("completed");
	});

	it("syncs configured tuner channels before refreshing guide sources", async () => {
		let resolveSync!: () => void;
		vi.mocked(syncTunerChannels).mockReturnValue(
			new Promise((resolve) => {
				resolveSync = () =>
					resolve({
						added: 102,
						updated: 0,
						removed: 0,
						unavailable: 0,
						missing: 0,
						total: 102
					});
			})
		);
		vi.mocked(listEpgSources).mockResolvedValue({ items: [enabledEpgSource] });

		render(
			<OnboardingWizard
				open
				initialStep="done"
				initialTuners={[configuredTuner]}
				initialEpgSources={[enabledEpgSource]}
				initialSettings={baseSettings}
				onClose={() => {}}
			/>
		);

		await waitFor(() => expect(syncTunerChannels).toHaveBeenCalledOnce());
		expect(syncTunerChannels).toHaveBeenCalledWith(configuredTuner.id);
		expect(refreshEpgSource).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: /preparing guide/i })
		).toBeDisabled();

		await act(async () => resolveSync());

		await waitFor(() => {
			expect(refreshEpgSource).toHaveBeenCalledWith(enabledEpgSource.id);
			expect(
				screen.getByRole("button", { name: /open signalhaven/i })
			).toBeEnabled();
		});
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
