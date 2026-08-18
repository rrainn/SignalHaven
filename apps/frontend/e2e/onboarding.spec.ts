import { test, expect, type Page } from "./fixtures";

/**
 * End-to-end smoke test for the first-run onboarding wizard.
 *
 * The backend is mocked via Playwright route handlers — we don't depend on
 * the real Express server here because the goal is to assert the wizard
 * flow itself (step navigation, form submission, completion).
 */

const sampleSettings = {
	storage: { path: null, quotaGb: null },
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

async function mockBackend(page: Page, opts: { firstRun: boolean }) {
	await page.route("**/api/v1/system/status", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				firstRun: opts.firstRun,
				hasTuners: !opts.firstRun,
				hasEpg: !opts.firstRun,
				hasStorage: !opts.firstRun
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

	await page.route("**/api/v1/settings", (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON() as {
				storage?: { path?: string };
			};
			const updated = {
				...sampleSettings,
				storage: {
					path: body?.storage?.path ?? null,
					quotaGb: null
				}
			};
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(updated)
			});
		}
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(sampleSettings)
		});
	});

	await page.route("**/api/v1/tuners/discover", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ results: [] })
		})
	);
}

test.describe("Onboarding wizard", () => {
	test("walks the user through every step on first launch", async ({
		page
	}) => {
		await mockBackend(page, { firstRun: true });

		await page.goto("/");
		await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
		await expect(page.getByTestId("onboarding-step-welcome")).toBeVisible();

		// Welcome -> Tuners
		await page.getByRole("button", { name: /get started/i }).click();
		await expect(page.getByTestId("onboarding-step-tuners")).toBeVisible();

		// Tuners -> Epg (defer tuner setup)
		await page.getByRole("button", { name: /set up later/i }).click();
		await expect(page.getByTestId("onboarding-step-epg")).toBeVisible();

		// Epg -> Storage (continue)
		await page.getByRole("button", { name: /^continue$/i }).click();
		await expect(page.getByTestId("onboarding-step-storage")).toBeVisible();

		// The standard container path is ready to save without extra input.
		await expect(
			page.getByRole("textbox", { name: /^recordings folder$/i })
		).toHaveValue("/var/lib/signalhaven/recordings");
		await page.getByRole("button", { name: /save and continue/i }).click();
		await expect(page.getByTestId("onboarding-step-mapping")).toBeVisible();

		// Mapping -> Done
		await page.getByRole("button", { name: /looks good/i }).click();
		await expect(page.getByTestId("onboarding-step-done")).toBeVisible();

		// Done -> close
		await page.getByRole("button", { name: /open signalhaven/i }).click();
		await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
	});

	test("does not appear when the backend reports the install is configured", async ({
		page
	}) => {
		await mockBackend(page, { firstRun: false });
		await page.goto("/");

		// Configured installs now land directly on the primary Guide destination.
		await expect(page).toHaveURL(/\/guide$/);
		await expect(
			page.getByRole("heading", { name: "Guide", exact: true })
		).toBeVisible();
		await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
	});
});
