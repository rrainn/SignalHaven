import { expect, test as base } from "@playwright/test";

export type { Page, Route, WebSocketRoute } from "@playwright/test";
export { expect };

export const authenticatedAdmin = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};

export const defaultPreferences = {
	ui: {
		theme: "system" as const,
		epgHoursVisible: 4,
		use24HourClock: false,
		density: "comfortable" as const,
		animations: true
	},
	channels: {
		favorites: [] as string[],
		hidden: [] as string[],
		order: [] as string[]
	},
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {} as Record<string, string>
	}
};

/** Authenticates legacy browser scenarios before the fail-closed app gate runs. */
export const test = base.extend({
	page: async ({ page }, use) => {
		await page.route("**/api/v1/auth/status", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					requiresInitialAdmin: false,
					systemSetupRequired: false,
					user: authenticatedAdmin
				})
			})
		);
		await page.route("**/api/v1/preferences", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(defaultPreferences)
			})
		);
		await use(page);
	}
});
