import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Settings } from "@signalhaven/shared";

import { StorageSection } from "../../app/_settings/StorageSection";

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

const baseSettings: Settings = {
	storage: { path: "/var/lib/signalhaven/recordings", quotaGb: null },
	transcoding: {
		enabled: false,
		preset: "balanced",
		videoBitrateKbps: 4000,
		audioBitrateKbps: 192,
		defaultProfile: "direct",
		hwaccel: "auto",
		availableHwaccels: [],
		captionsEnabled: true
	},
	ui: {
		theme: "system",
		epgHoursVisible: 4,
		use24HourClock: false,
		density: "comfortable",
		animations: true
	},
	recordings: { paddingBeforeSec: 15, paddingAfterSec: 30 },
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

describe("StorageSection", () => {
	it("loads both existing recording padding values", () => {
		render(<StorageSection settings={baseSettings} onChanged={() => {}} />);

		expect(screen.getByLabelText(/pre-record padding/i)).toHaveValue(15);
		expect(screen.getByLabelText(/post-record padding/i)).toHaveValue(30);
		expect(
			screen.queryByLabelText(/comskip executable path/i)
		).not.toBeInTheDocument();
	});

	it("rejects an empty path with an inline error", async () => {
		const user = userEvent.setup();
		const settings: Settings = {
			...baseSettings,
			storage: { path: null, quotaGb: null }
		};
		render(<StorageSection settings={settings} onChanged={() => {}} />);

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(/required/i);
		expect(updateSettingsMock).not.toHaveBeenCalled();
	});

	it("rejects a non-positive quota", async () => {
		const user = userEvent.setup();
		render(<StorageSection settings={baseSettings} onChanged={() => {}} />);
		await user.clear(screen.getByPlaceholderText("e.g. 500"));
		await user.type(screen.getByPlaceholderText("e.g. 500"), "0");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/quotaGb/);
		expect(updateSettingsMock).not.toHaveBeenCalled();
	});

	it("PATCHes both storage and recordings padding on submit", async () => {
		const user = userEvent.setup();
		updateSettingsMock.mockResolvedValue({
			...baseSettings,
			storage: { path: "/srv/recordings", quotaGb: 500 },
			recordings: { paddingBeforeSec: 45, paddingAfterSec: 60 }
		});

		const onChanged = vi.fn();
		render(<StorageSection settings={baseSettings} onChanged={onChanged} />);

		await user.clear(
			screen.getByPlaceholderText("/var/lib/signalhaven/recordings")
		);
		await user.type(
			screen.getByPlaceholderText("/var/lib/signalhaven/recordings"),
			"/srv/recordings"
		);
		await user.type(screen.getByPlaceholderText("e.g. 500"), "500");
		const prePadding = screen.getByLabelText(/pre-record padding/i);
		await user.clear(prePadding);
		await user.type(prePadding, "45");
		const postPadding = screen.getByLabelText(/post-record padding/i);
		await user.clear(postPadding);
		await user.type(postPadding, "60");

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => {
			expect(updateSettingsMock).toHaveBeenCalledWith({
				storage: { path: "/srv/recordings", quotaGb: 500 },
				recordings: { paddingBeforeSec: 45, paddingAfterSec: 60 }
			});
		});
		expect(onChanged).toHaveBeenCalledWith({
			...baseSettings,
			storage: { path: "/srv/recordings", quotaGb: 500 },
			recordings: { paddingBeforeSec: 45, paddingAfterSec: 60 }
		});
		expect(await screen.findByText(/saved\./i)).toBeInTheDocument();
	});

	it("enables bundled commercial detection without an executable path", async () => {
		const user = userEvent.setup();
		const nextSettings: Settings = {
			...baseSettings,
			recordings: {
				...baseSettings.recordings,
				commercialDetection: {
					enabled: true,
					detectorVersion: "comskip-edl-v1"
				}
			}
		};
		updateSettingsMock.mockResolvedValue(nextSettings);
		render(<StorageSection settings={baseSettings} onChanged={() => {}} />);

		await user.click(
			screen.getByRole("switch", { name: /enable commercial detection/i })
		);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => {
			expect(updateSettingsMock).toHaveBeenCalledWith({
				storage: baseSettings.storage,
				recordings: {
					paddingBeforeSec: 15,
					paddingAfterSec: 30,
					commercialDetection: {
						enabled: true,
						detectorVersion: "comskip-edl-v1"
					}
				}
			});
		});
	});

	it.each([
		["negative", "-1"],
		["fractional", "1.5"],
		["excessively large", "3601"]
	])("rejects %s padding", async (_description, value) => {
		const user = userEvent.setup();
		render(<StorageSection settings={baseSettings} onChanged={() => {}} />);

		const prePadding = screen.getByLabelText(/pre-record padding/i);
		await user.clear(prePadding);
		await user.type(prePadding, value);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/paddingBeforeSec/i
		);
		expect(updateSettingsMock).not.toHaveBeenCalled();
	});

	it("keeps the saved settings unchanged when saving fails", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		updateSettingsMock.mockRejectedValue(
			new Error("The recordings volume is read-only")
		);
		render(<StorageSection settings={baseSettings} onChanged={onChanged} />);

		const prePadding = screen.getByLabelText(/pre-record padding/i);
		await user.clear(prePadding);
		await user.type(prePadding, "45");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The recordings volume is read-only"
		);
		expect(onChanged).not.toHaveBeenCalled();
		// Keep the attempted value visible so the user can correct or retry it.
		expect(prePadding).toHaveValue(45);
	});
});
