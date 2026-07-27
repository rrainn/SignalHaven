import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeProvider } from "../app/_theme/ThemeProvider";
import { ThemeToggle } from "../app/_theme/ThemeToggle";
import { THEME_STORAGE_KEY } from "../app/_theme/theme";

function renderToggle() {
	return render(
		<ThemeProvider>
			<ThemeToggle />
		</ThemeProvider>
	);
}

describe("ThemeToggle", () => {
	it("renders compact icon controls in light, system, dark order", async () => {
		renderToggle();
		const group = await screen.findByRole("group", { name: /theme/i });
		const buttons = within(group).getAllByRole("button");

		// Accessible labels preserve meaning while visible text stays out of the compact control.
		expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
			"Light theme",
			"System theme",
			"Dark theme"
		]);
		expect(buttons.every((button) => button.textContent === "")).toBe(true);
	});

	it("defaults to system mode and resolves via prefers-color-scheme", async () => {
		(
			window as unknown as { __setPrefersDark: (v: boolean) => void }
		).__setPrefersDark(true);
		renderToggle();
		// Provider mounts and applies the resolved palette in an effect.
		await screen.findByRole("group", { name: /theme/i });
		expect(screen.getByTestId("theme-toggle-system")).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(document.documentElement.classList.contains("dark")).toBe(true);
	});

	it("switches to dark when the dark button is clicked and persists the choice", async () => {
		const user = userEvent.setup();
		renderToggle();
		await user.click(screen.getByTestId("theme-toggle-dark"));
		expect(screen.getByTestId("theme-toggle-dark")).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
	});

	it("switches to light when the light button is clicked", async () => {
		const user = userEvent.setup();
		renderToggle();
		await user.click(screen.getByTestId("theme-toggle-light"));
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
	});

	it("re-resolves when the OS theme changes while in system mode", async () => {
		const user = userEvent.setup();
		renderToggle();
		await user.click(screen.getByTestId("theme-toggle-system"));
		expect(document.documentElement.classList.contains("dark")).toBe(false);

		await act(async () => {
			(
				window as unknown as { __setPrefersDark: (v: boolean) => void }
			).__setPrefersDark(true);
		});

		expect(document.documentElement.classList.contains("dark")).toBe(true);
	});

	it("hydrates from a previously stored preference", async () => {
		window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
		renderToggle();
		// Wait for the mount effect.
		await screen.findByRole("group", { name: /theme/i });
		expect(screen.getByTestId("theme-toggle-dark")).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(document.documentElement.classList.contains("dark")).toBe(true);
	});
});
