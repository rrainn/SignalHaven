import { settingsDefaults, type Settings } from "@signalhaven/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	PreferencesProvider,
	usePreferences
} from "../../app/_preferences/PreferencesProvider";
import { ThemeProvider } from "../../app/_theme/ThemeProvider";

vi.mock("../../lib/ws-client", () => ({
	useWebSocketEvents: () => "closed"
}));

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		getSettings: vi.fn(),
		updateSettings: vi.fn()
	};
});

import { getSettings, updateSettings } from "../../lib/api-client";

const getSettingsMock = vi.mocked(getSettings);
const updateSettingsMock = vi.mocked(updateSettings);

const savedSettings: Settings = {
	...settingsDefaults,
	ui: {
		...settingsDefaults.ui,
		theme: "dark",
		density: "compact",
		animations: false,
		use24HourClock: true,
		epgHoursVisible: 8
	}
};

function Probe() {
	const preferences = usePreferences();
	return (
		<div>
			<span data-testid="status">{preferences.status}</span>
			<span data-testid="clock">
				{String(preferences.settings.ui.use24HourClock)}
			</span>
			{preferences.error ? (
				<span role="alert">{preferences.error.message}</span>
			) : null}
			<button
				type="button"
				onClick={() =>
					void preferences.saveSettings({
						channels: {
							favorites: ["00000000-0000-4000-8000-000000000001"],
							hidden: [],
							order: []
						}
					})
				}
			>
				Save first
			</button>
			<button
				type="button"
				onClick={() =>
					void preferences.saveSettings({
						channels: {
							favorites: ["00000000-0000-4000-8000-000000000002"],
							hidden: [],
							order: []
						}
					})
				}
			>
				Save second
			</button>
		</div>
	);
}

function renderProvider() {
	return render(
		<ThemeProvider>
			<PreferencesProvider>
				<Probe />
			</PreferencesProvider>
		</ThemeProvider>
	);
}

beforeEach(() => {
	getSettingsMock.mockReset();
	updateSettingsMock.mockReset();
	document.documentElement.removeAttribute("data-density");
	document.documentElement.removeAttribute("data-animations");
});

describe("PreferencesProvider", () => {
	it("loads settings once at the app boundary and applies appearance", async () => {
		getSettingsMock.mockResolvedValue(savedSettings);
		renderProvider();

		expect(screen.getByTestId("status")).toHaveTextContent("loading");
		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("ready")
		);
		expect(getSettingsMock).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("clock")).toHaveTextContent("true");
		// Appearance is applied by a follow-up effect after settings become ready.
		await waitFor(() => {
			expect(document.documentElement).toHaveAttribute(
				"data-density",
				"compact"
			);
			expect(document.documentElement).toHaveAttribute(
				"data-animations",
				"off"
			);
			expect(document.documentElement).toHaveClass("dark");
		});
	});

	it("falls back to schema defaults and exposes a diagnosable load error", async () => {
		getSettingsMock.mockRejectedValue(new Error("Malformed saved settings"));
		renderProvider();

		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("error")
		);
		expect(screen.getByTestId("clock")).toHaveTextContent("false");
		expect(screen.getByRole("alert")).toHaveTextContent(
			/malformed saved settings/i
		);
	});

	it("serializes saves so stale responses cannot overwrite newer preferences", async () => {
		const user = userEvent.setup();
		getSettingsMock.mockResolvedValue(savedSettings);
		let resolveFirst!: (settings: Settings) => void;
		updateSettingsMock
			.mockImplementationOnce(
				() =>
					new Promise<Settings>((resolve) => {
						resolveFirst = resolve;
					})
			)
			.mockResolvedValueOnce({
				...savedSettings,
				channels: {
					favorites: ["00000000-0000-4000-8000-000000000002"],
					hidden: [],
					order: []
				}
			});
		renderProvider();
		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("ready")
		);

		await user.click(screen.getByRole("button", { name: "Save first" }));
		await user.click(screen.getByRole("button", { name: "Save second" }));
		expect(updateSettingsMock).toHaveBeenCalledTimes(1);

		resolveFirst({
			...savedSettings,
			channels: {
				favorites: ["00000000-0000-4000-8000-000000000001"],
				hidden: [],
				order: []
			}
		});
		await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledTimes(2));
	});
});
