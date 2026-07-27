import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StorageStep } from "../../app/_onboarding/steps/StorageStep";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		updateSettings: vi.fn()
	};
});

import { updateSettings } from "../../lib/api-client";

const updateSettingsMock = vi.mocked(updateSettings);

beforeEach(() => {
	updateSettingsMock.mockReset();
});

const baseSettings = {
	storage: { path: "/var/lib/signalhaven/recordings", quotaGb: null },
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

describe("StorageStep", () => {
	it("prefills the container default when no path is configured", () => {
		render(
			<StorageStep
				currentPath={null}
				onPathSaved={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);
		expect(
			screen.getByRole("textbox", { name: /^recordings folder$/i })
		).toHaveValue("/var/lib/signalhaven/recordings");
		expect(
			screen.getByRole("button", { name: /save and continue/i })
		).toBeEnabled();
	});

	it("PATCHes settings.storage.path on submit and notifies the parent", async () => {
		const user = userEvent.setup();
		const onPathSaved = vi.fn();
		updateSettingsMock.mockResolvedValue(baseSettings);

		render(
			<StorageStep
				currentPath={null}
				onPathSaved={onPathSaved}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.click(
			screen.getByRole("button", { name: /save and continue/i })
		);

		await waitFor(() => {
			expect(updateSettingsMock).toHaveBeenCalledWith({
				storage: { path: "/var/lib/signalhaven/recordings", quotaGb: null }
			});
			expect(onPathSaved).toHaveBeenCalledWith(
				"/var/lib/signalhaven/recordings"
			);
		});
	});

	it("explains that recordings stay unavailable when setup is deferred", async () => {
		const user = userEvent.setup();
		const onSkip = vi.fn();
		render(
			<StorageStep
				currentPath={null}
				onPathSaved={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={onSkip}
			/>
		);
		expect(
			screen.getByText(/recording requires a writable folder/i)
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /set up later/i }));
		expect(onSkip).toHaveBeenCalledOnce();
		expect(updateSettingsMock).not.toHaveBeenCalled();
	});
});
