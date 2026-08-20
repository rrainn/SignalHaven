import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
	userPreferencesDefaults,
	type UserPreferences
} from "@signalhaven/shared";

import { AppearanceSection } from "../../app/_settings/AppearanceSection";
import { ThemeProvider } from "../../app/_theme/ThemeProvider";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		updatePreferences: vi.fn()
	};
});

import { updatePreferences } from "../../lib/api-client";

const updatePreferencesMock = vi.mocked(updatePreferences);

beforeEach(() => {
	updatePreferencesMock.mockReset();
	// Reset DOM attributes the section toggles.
	document.documentElement.removeAttribute("data-density");
	document.documentElement.removeAttribute("data-animations");
	window.localStorage.clear();
});

const basePreferences: UserPreferences = userPreferencesDefaults;

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("AppearanceSection", () => {
	it("rejects an out-of-range guide hours value", async () => {
		const user = userEvent.setup();
		renderWithTheme(
			<AppearanceSection
				preferences={basePreferences.ui}
				onChanged={() => {}}
			/>
		);
		const hours = screen.getByLabelText(/guide hours visible/i);
		await user.clear(hours);
		await user.type(hours, "99");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/epgHoursVisible/
		);
		expect(updatePreferencesMock).not.toHaveBeenCalled();
	});

	it("toggling animations off applies data-animations='off' to <html>", async () => {
		const user = userEvent.setup();
		renderWithTheme(
			<AppearanceSection
				preferences={basePreferences.ui}
				onChanged={() => {}}
			/>
		);
		expect(document.documentElement.getAttribute("data-animations")).toBeNull();
		await user.click(screen.getByTestId("appearance-animations"));
		expect(document.documentElement.getAttribute("data-animations")).toBe(
			"off"
		);
	});

	it("PATCHes ui settings and persists density/animations to localStorage on save", async () => {
		const user = userEvent.setup();
		updatePreferencesMock.mockResolvedValue({
			...basePreferences,
			ui: {
				...basePreferences.ui,
				density: "compact",
				animations: false
			}
		});

		renderWithTheme(
			<AppearanceSection
				preferences={basePreferences.ui}
				onChanged={() => {}}
			/>
		);

		// Toggle animations off (Switch).
		await user.click(screen.getByTestId("appearance-animations"));

		// Switch the theme to dark — exercises useTheme().setMode integration.
		await user.click(screen.getByTestId("appearance-theme-dark"));

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => {
			expect(updatePreferencesMock).toHaveBeenCalledTimes(1);
		});
		const arg = updatePreferencesMock.mock.calls[0]?.[0] as
			| { ui?: { theme?: string; animations?: boolean } }
			| undefined;
		expect(arg?.ui?.theme).toBe("dark");
		expect(arg?.ui?.animations).toBe(false);
		expect(window.localStorage.getItem("signalhaven:animations")).toBe("off");
	});

	it("keeps the form usable and surfaces a failed settings save", async () => {
		const user = userEvent.setup();
		updatePreferencesMock.mockRejectedValue(
			new Error("Preferences service unavailable")
		);

		renderWithTheme(
			<AppearanceSection
				preferences={basePreferences.ui}
				onChanged={() => {}}
			/>
		);
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/preferences service unavailable/i
		);
		expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
	});

	it("hydrates a later account snapshot without overwriting a dirty edit", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		const view = renderWithTheme(
			<AppearanceSection
				preferences={basePreferences.ui}
				onChanged={onChanged}
			/>
		);
		view.rerender(
			<ThemeProvider>
				<AppearanceSection
					preferences={{
						...basePreferences.ui,
						epgHoursVisible: 8,
						use24HourClock: true,
						density: "compact"
					}}
					onChanged={onChanged}
				/>
			</ThemeProvider>
		);
		await waitFor(() =>
			expect(screen.getByLabelText(/guide hours visible/i)).toHaveValue(8)
		);
		expect(screen.getByLabelText("24-hour clock")).toBeChecked();

		await user.clear(screen.getByLabelText(/guide hours visible/i));
		await user.type(screen.getByLabelText(/guide hours visible/i), "6");
		view.rerender(
			<ThemeProvider>
				<AppearanceSection
					preferences={{ ...basePreferences.ui, epgHoursVisible: 12 }}
					onChanged={onChanged}
				/>
			</ThemeProvider>
		);
		expect(screen.getByLabelText(/guide hours visible/i)).toHaveValue(6);
	});
});
