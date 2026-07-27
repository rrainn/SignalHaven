import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Settings } from "@signalhaven/shared";

import { TranscodingSection } from "../../app/_settings/TranscodingSection";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		updateSettings: vi.fn(),
		listChannels: vi.fn().mockResolvedValue({ items: [] })
	};
});

import { updateSettings } from "../../lib/api-client";

const updateSettingsMock = vi.mocked(updateSettings);

beforeEach(() => {
	updateSettingsMock.mockReset();
});

const baseSettings: Settings = {
	storage: { path: "/srv/recordings", quotaGb: null },
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

describe("TranscodingSection", () => {
	it("rejects an out-of-range video bitrate", async () => {
		const user = userEvent.setup();
		render(<TranscodingSection settings={baseSettings} onChanged={() => {}} />);
		const video = screen.getByLabelText(/video bitrate/i);
		await user.clear(video);
		await user.type(video, "999999");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/videoBitrateKbps/
		);
		expect(updateSettingsMock).not.toHaveBeenCalled();
	});

	it("PATCHes the transcoding settings on submit", async () => {
		const user = userEvent.setup();
		updateSettingsMock.mockResolvedValue(baseSettings);
		render(<TranscodingSection settings={baseSettings} onChanged={() => {}} />);

		const video = screen.getByLabelText(/video bitrate/i);
		await user.clear(video);
		await user.type(video, "8000");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => {
			expect(updateSettingsMock).toHaveBeenCalledTimes(1);
		});
		const arg = updateSettingsMock.mock.calls[0]?.[0] as
			| { transcoding?: { videoBitrateKbps?: number } }
			| undefined;
		expect(arg?.transcoding?.videoBitrateKbps).toBe(8000);
	});
});
