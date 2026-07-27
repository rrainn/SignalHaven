import { expect, test, type Page } from "@playwright/test";

const CHANNEL_ID = "10000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "20000000-0000-4000-8000-000000000001";
const FUTURE_START = "2099-01-01T01:00:00.000Z";
const FUTURE_STOP = "2099-01-01T02:00:00.000Z";

const settings = {
	storage: { path: "/recordings", quotaGb: null },
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

/** Installs the smallest contract-faithful backend needed by shell flows. */
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
	await page.route("**/api/v1/settings", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(settings)
		})
	);
	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] })
		})
	);
	await page.route("**/api/v1/recordings**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items: [],
				total: 0,
				totalSize: 0,
				limit: 50,
				offset: 0,
				nextCursor: null,
				seriesGroups: [],
				oneOffGroup: null
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
	await page.route("**/api/v1/search**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				q: "future",
				channels: [],
				programs: [
					{
						kind: "program",
						id: PROGRAM_ID,
						title: "Future Show",
						subtitle: null,
						start: FUTURE_START,
						stop: FUTURE_STOP,
						channelId: CHANNEL_ID,
						channelName: "Test Channel",
						channelNumber: "12.1",
						score: 1
					}
				],
				recordings: []
			})
		})
	);
	await page.route(`**/api/v1/epg/programs/${PROGRAM_ID}`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				channel: {
					id: CHANNEL_ID,
					number: "12.1",
					name: "Test Channel",
					logoUrl: null,
					hasMapping: true
				},
				program: {
					id: PROGRAM_ID,
					channelId: CHANNEL_ID,
					start: FUTURE_START,
					stop: FUTURE_STOP,
					title: "Future Show",
					subtitle: null,
					description: "A future program.",
					categories: ["Drama"],
					recordingId: null,
					recordingStatus: null
				}
			})
		})
	);
}

test.describe("Application shell", () => {
	test("root redirects without scaffold content and Library opens Recordings", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto("/");

		await expect(page).toHaveURL(/\/guide$/);
		await expect(page.getByText("Frontend scaffold is online")).toHaveCount(0);
		await expect(
			page
				.getByRole("navigation", { name: "Primary" })
				.first()
				.getByRole("link", {
					name: "Guide"
				})
		).toHaveAttribute("aria-current", "page");

		await page
			.getByRole("navigation", { name: "Primary" })
			.first()
			.getByRole("link", { name: "Recordings" })
			.click();
		await expect(page).toHaveURL(/\/recordings$/);
		await expect(page.getByTestId("recordings-page")).toBeVisible();
	});

	test("mobile navigation has icons and a compact working theme action", async ({
		page
	}) => {
		await page.setViewportSize({ width: 320, height: 700 });
		await mockBackend(page);
		await page.goto("/guide");

		const nav = page.getByTestId("bottom-nav");
		await expect(nav.locator('[data-testid="nav-icon"]')).toHaveCount(5);
		await expect(nav).not.toContainText("•");
		const theme = page.getByRole("button", { name: /theme: system/i });
		await theme.click();
		await expect(
			page.getByRole("button", { name: /theme: light/i })
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth
			)
		).toBe(true);
	});

	test("future search results open details and browser Back restores Guide context", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto("/guide");
		await page.getByTestId("global-search-trigger").click();
		await page.getByPlaceholder(/search channels/i).fill("future");
		await page.getByRole("option", { name: /Future Show/i }).click();

		await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}`));
		await expect(page.getByRole("dialog")).toContainText("Future Show");
		await expect(page.getByRole("button", { name: /^watch$/i })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^record$/i })).toBeVisible();

		await page.goBack();
		await expect(page).toHaveURL(/\/guide$/);
	});
});
