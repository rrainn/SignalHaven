import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Settings } from "@signalhaven/shared";

import { AppearanceSection } from "../../app/_settings/AppearanceSection";
import { ThemeProvider } from "../../app/_theme/ThemeProvider";

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
	// Reset DOM attributes the section toggles.
	document.documentElement.removeAttribute("data-density");
	document.documentElement.removeAttribute("data-animations");
	window.localStorage.clear();
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

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("AppearanceSection", () => {
	it("rejects an out-of-range guide hours value", async () => {
		const user = userEvent.setup();
		renderWithTheme(
			<AppearanceSection settings={baseSettings} onChanged={() => {}} />
		);
		const hours = screen.getByLabelText(/guide hours visible/i);
		await user.clear(hours);
		await user.type(hours, "99");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/epgHoursVisible/
		);
		expect(updateSettingsMock).not.toHaveBeenCalled();
	});

	it("toggling animations off applies data-animations='off' to <html>", async () => {
		const user = userEvent.setup();
		renderWithTheme(
			<AppearanceSection settings={baseSettings} onChanged={() => {}} />
		);
		expect(document.documentElement.getAttribute("data-animations")).toBeNull();
		await user.click(screen.getByTestId("appearance-animations"));
		expect(document.documentElement.getAttribute("data-animations")).toBe(
			"off"
		);
	});

	it("PATCHes ui settings and persists density/animations to localStorage on save", async () => {
		const user = userEvent.setup();
		updateSettingsMock.mockResolvedValue({
			...baseSettings,
			ui: { ...baseSettings.ui, density: "compact", animations: false }
		});

		renderWithTheme(
			<AppearanceSection settings={baseSettings} onChanged={() => {}} />
		);

		// Toggle animations off (Switch).
		await user.click(screen.getByTestId("appearance-animations"));

		// Switch the theme to dark — exercises useTheme().setMode integration.
		await user.click(screen.getByTestId("appearance-theme-dark"));

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => {
			expect(updateSettingsMock).toHaveBeenCalledTimes(1);
		});
		const arg = updateSettingsMock.mock.calls[0]?.[0] as
			| { ui?: { theme?: string; animations?: boolean } }
			| undefined;
		expect(arg?.ui?.theme).toBe("dark");
		expect(arg?.ui?.animations).toBe(false);
		expect(window.localStorage.getItem("signalhaven:animations")).toBe("off");
	});

	it("keeps the form usable and surfaces a failed settings save", async () => {
		const user = userEvent.setup();
		updateSettingsMock.mockRejectedValue(
			new Error("Settings service unavailable")
		);

		renderWithTheme(
			<AppearanceSection settings={baseSettings} onChanged={() => {}} />
		);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/settings service unavailable/i
		);
		expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
	});
});
