import { test, expect, type Page } from "./fixtures";

/**
 * E2E for rrainn/SignalHaven#U11-settings: change theme to dark from the
 * Settings → Appearance section, reload the page, and verify the dark
 * theme survives without a flash of the wrong theme.
 *
 * "No flash" is verified by reading `<html data-theme>` (or
 * `documentElement.classList`) immediately on `load` and asserting it
 * is already in the dark state — the theme bootstrap script in `<head>`
 * must have applied it before paint.
 */

const sampleSettings = {
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
	observability: { debugBundleEnabled: false }
};

async function mockBackend(page: Page) {
	await page.route("**/api/v1/system/status", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				firstRun: false,
				hasTuners: true,
				hasEpg: true,
				hasStorage: true
			})
		})
	);

	await page.route("**/api/v1/tuners", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] })
		})
	);
	await page.route("**/api/v1/epg/sources", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] })
		})
	);
	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] })
		})
	);

	let current = {
		ui: { ...sampleSettings.ui },
		channels: { ...sampleSettings.channels },
		player: { ...sampleSettings.player }
	};
	await page.route("**/api/v1/settings", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(sampleSettings)
		});
	});
	await page.route("**/api/v1/preferences", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = JSON.parse(route.request().postData() ?? "{}");
			current = {
				...current,
				...body,
				ui: { ...current.ui, ...(body.ui ?? {}) }
			};
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(current)
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(current)
		});
	});
}

test.describe("Settings — appearance", () => {
	test("change theme to dark, reload, and verify persistence with no flash", async ({
		page
	}) => {
		await mockBackend(page);

		await page.goto("/preferences");
		await page.getByTestId("appearance-theme-dark").click();
		await page.getByRole("button", { name: /^save$/i }).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");

		// setMode immediately adds the `dark` class and writes the choice
		// to localStorage.
		await expect(page.locator("html")).toHaveClass(/(?:^|\s)dark(?:\s|$)/);

		// Reload — the inline bootstrap script in <head> must apply the
		// stored mode synchronously *before* paint, so by the time `load`
		// fires the html element already has the dark class.
		await page.reload();

		const isDarkAtLoad = await page.evaluate(() =>
			document.documentElement.classList.contains("dark")
		);
		expect(isDarkAtLoad).toBe(true);

		// And it should stay dark after hydration.
		await expect(page.locator("html")).toHaveClass(/(?:^|\s)dark(?:\s|$)/);
	});
});
