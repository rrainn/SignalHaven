import { expect, test as base, type Page } from "@playwright/test";

import { defaultPreferences } from "./fixtures";

const admin = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};

const standardUser = {
	id: "00000000-0000-4000-8000-000000000002",
	username: "viewer",
	role: "user" as const
};

const onboardingSettings = {
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
	recordings: {
		paddingBeforeSec: 0,
		paddingAfterSec: 0,
		commercialDetection: {
			enabled: false,
			detectorVersion: "comskip-edl-v1"
		}
	},
	timeShift: {
		enabled: true,
		bufferPath: null,
		durationMinutes: 60,
		maxDiskGb: 10,
		idleGraceSeconds: 30
	},
	lineupSync: {
		enabled: true,
		intervalHours: 24,
		removalThreshold: 3
	},
	observability: { debugBundleEnabled: false }
};

/** Supplies only the protected data required after account access succeeds. */
async function mockProtectedShell(page: Page, firstRun = false): Promise<void> {
	await page.route("**/api/v1/preferences", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(defaultPreferences)
		})
	);
	await page.route("**/api/v1/system/status", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				firstRun,
				hasTuners: !firstRun,
				hasEpg: !firstRun,
				hasStorage: !firstRun
			})
		})
	);
	await page.route("**/api/v1/epg/grid**", (route) => {
		const url = new URL(route.request().url());
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				from: url.searchParams.get("from"),
				to: url.searchParams.get("to"),
				channels: [],
				programs: []
			})
		});
	});
	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] })
		})
	);
	await page.route("**/api/v1/settings", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(onboardingSettings)
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
}

base.describe("Local account access", () => {
	base(
		"creates the first administrator before opening the app",
		async ({ page }) => {
			await mockProtectedShell(page, true);
			let signedIn = false;
			await page.route("**/api/v1/auth/status", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						requiresInitialAdmin: !signedIn,
						systemSetupRequired: true,
						user: signedIn ? admin : null
					})
				})
			);
			await page.route("**/api/v1/auth/setup", async (route) => {
				expect(route.request().postDataJSON()).toEqual({
					username: "operator",
					password: "secret123",
					transport: "cookie"
				});
				signedIn = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						user: admin,
						token: null,
						expiresAt: "2099-01-01T00:00:00.000Z"
					})
				});
			});

			await page.goto("/");
			await expect(page).toHaveURL(/\/setup\/account/);
			await page.getByRole("textbox", { name: /^username/i }).fill("operator");
			await page.getByLabel(/^password$/i).fill("secret123");
			await page.getByLabel(/^confirm password$/i).fill("secret123");
			await page.getByRole("button", { name: /create administrator/i }).click();

			await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
			await expect(page.getByTestId("active-username")).toHaveText("operator");
		}
	);

	base(
		"signs in a standard user without administrator navigation",
		async ({ page }) => {
			await mockProtectedShell(page);
			let signedIn = false;
			await page.route("**/api/v1/auth/status", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						requiresInitialAdmin: false,
						systemSetupRequired: false,
						user: signedIn ? standardUser : null
					})
				})
			);
			await page.route("**/api/v1/auth/login", async (route) => {
				signedIn = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						user: standardUser,
						token: null,
						expiresAt: "2099-01-01T00:00:00.000Z"
					})
				});
			});

			await page.goto("/settings");
			await expect(page).toHaveURL(/\/sign-in/);
			await page.getByLabel(/^username$/i).fill("viewer");
			await page.getByLabel(/^password$/i).fill("secret123");
			await page.getByRole("button", { name: /^sign in$/i }).click();

			await expect(page).toHaveURL(/\/guide$/);
			const primary = page.getByRole("navigation", { name: "Primary" }).first();
			await expect(primary.getByRole("link", { name: "Settings" })).toHaveCount(
				0
			);
			await expect(page.getByTestId("active-username")).toHaveText("viewer");
		}
	);
});
