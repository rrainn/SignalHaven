import {
	userPreferencesDefaults,
	type UserPreferences
} from "@signalhaven/shared";
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
		getPreferences: vi.fn(),
		updatePreferences: vi.fn()
	};
});

import { getPreferences, updatePreferences } from "../../lib/api-client";

const getPreferencesMock = vi.mocked(getPreferences);
const updatePreferencesMock = vi.mocked(updatePreferences);

const savedPreferences: UserPreferences = {
	...userPreferencesDefaults,
	ui: {
		...userPreferencesDefaults.ui,
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
				{String(preferences.preferences.ui.use24HourClock)}
			</span>
			{preferences.error ? (
				<span role="alert">{preferences.error.message}</span>
			) : null}
			<button type="button" onClick={() => void preferences.retry()}>
				Retry
			</button>
			<button
				type="button"
				onClick={() =>
					void preferences
						.savePreferences({
							channels: {
								favorites: ["00000000-0000-4000-8000-000000000001"],
								hidden: [],
								order: []
							}
						})
						.catch(() => undefined)
				}
			>
				Save first
			</button>
			<button
				type="button"
				onClick={() =>
					void preferences
						.savePreferences({
							channels: {
								favorites: ["00000000-0000-4000-8000-000000000002"],
								hidden: [],
								order: []
							}
						})
						.catch(() => undefined)
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
	getPreferencesMock.mockReset();
	updatePreferencesMock.mockReset();
	document.documentElement.removeAttribute("data-density");
	document.documentElement.removeAttribute("data-animations");
});

describe("PreferencesProvider", () => {
	it("loads preferences once at the account boundary and applies appearance", async () => {
		getPreferencesMock.mockResolvedValue(savedPreferences);
		renderProvider();

		expect(screen.getByTestId("status")).toHaveTextContent("loading");
		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("ready")
		);
		expect(getPreferencesMock).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("clock")).toHaveTextContent("true");
		// Appearance is applied by a follow-up effect after preferences become ready.
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

	it("fails closed after load errors and retries the complete snapshot", async () => {
		const user = userEvent.setup();
		getPreferencesMock
			.mockRejectedValueOnce(new Error("Malformed saved settings"))
			.mockResolvedValueOnce(savedPreferences);
		renderProvider();

		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("error")
		);
		expect(screen.getByTestId("clock")).toHaveTextContent("false");
		expect(screen.getByRole("alert")).toHaveTextContent(
			/malformed saved settings/i
		);
		await user.click(screen.getByRole("button", { name: "Save first" }));
		expect(updatePreferencesMock).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("ready")
		);
		expect(screen.getByTestId("clock")).toHaveTextContent("true");
	});

	it("serializes saves so stale responses cannot overwrite newer preferences", async () => {
		const user = userEvent.setup();
		getPreferencesMock.mockResolvedValue(savedPreferences);
		let resolveFirst!: (preferences: UserPreferences) => void;
		updatePreferencesMock
			.mockImplementationOnce(
				() =>
					new Promise<UserPreferences>((resolve) => {
						resolveFirst = resolve;
					})
			)
			.mockResolvedValueOnce({
				...savedPreferences,
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
		expect(updatePreferencesMock).toHaveBeenCalledTimes(1);

		resolveFirst({
			...savedPreferences,
			channels: {
				favorites: ["00000000-0000-4000-8000-000000000001"],
				hidden: [],
				order: []
			}
		});
		await waitFor(() => expect(updatePreferencesMock).toHaveBeenCalledTimes(2));
	});

	it("drops queued saves when the owning account provider unmounts", async () => {
		const user = userEvent.setup();
		getPreferencesMock.mockResolvedValue(savedPreferences);
		let resolveFirst!: (preferences: UserPreferences) => void;
		updatePreferencesMock.mockImplementation(
			() =>
				new Promise<UserPreferences>((resolve) => {
					resolveFirst = resolve;
				})
		);
		const mounted = renderProvider();
		await waitFor(() =>
			expect(screen.getByTestId("status")).toHaveTextContent("ready")
		);

		await user.click(screen.getByRole("button", { name: "Save first" }));
		await user.click(screen.getByRole("button", { name: "Save second" }));
		expect(updatePreferencesMock).toHaveBeenCalledTimes(1);
		mounted.unmount();
		resolveFirst(savedPreferences);

		await waitFor(() => expect(updatePreferencesMock).toHaveBeenCalledTimes(1));
		expect(localStorage.getItem("signalhaven:theme")).toBe("system");
		expect(localStorage.getItem("signalhaven:density")).toBe("comfortable");
		expect(localStorage.getItem("signalhaven:animations")).toBe("on");
	});
});
