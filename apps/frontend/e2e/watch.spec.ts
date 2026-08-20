import { test, expect, type Page } from "./fixtures";

/**
 * E2E smoke for the U7-watch live watch page.
 *
 * Verifies the Acceptance Criteria call-out: `open page, switch channel
 * via keyboard, verify URL updates and stream restarts`. The actual HLS
 * playback is mocked so the headless worker never tries to fetch a real
 * segment, but the master.m3u8 hits are counted so we can prove the
 * stream URL was re-requested after the channel switch.
 */

const CHANNEL_A = "00000000-0000-4000-8000-00000000aaaa";
const CHANNEL_B = "00000000-0000-4000-8000-00000000bbbb";
const CHANNEL_C = "00000000-0000-4000-8000-00000000cccc";

const baseSettings = {
	storage: { path: "/mnt/recordings", quotaGb: 200 },
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
	channels: { favorites: [CHANNEL_B], hidden: [], order: [] },
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {} as Record<string, string>
	},
	observability: { debugBundleEnabled: false }
};

function buildChannel(id: string, number: string, name: string) {
	return {
		id,
		number,
		name,
		logoUrl: null,
		tvgId: null,
		tunerId: "11111111-1111-4111-8111-111111111111",
		tunerName: "Antenna",
		tunerKind: "hdhomerun" as const,
		enabled: true,
		sortOrder: Number.parseInt(number, 10),
		hasMapping: true
	};
}

function buildGrid() {
	const fromHour = new Date();
	fromHour.setMinutes(0, 0, 0);
	const from = new Date(fromHour.getTime() - 30 * 60_000);
	const to = new Date(from.getTime() + 6 * 60 * 60_000);
	const channels = [
		{ id: CHANNEL_A, number: "5", name: "Alpha" },
		{ id: CHANNEL_B, number: "6", name: "Bravo" },
		{ id: CHANNEL_C, number: "7", name: "Charlie" }
	].map((c) => ({
		id: c.id,
		number: c.number,
		name: c.name,
		logoUrl: null,
		hasMapping: true
	}));
	const programs: Array<Record<string, unknown>> = [];
	let pid = 0;
	for (const c of channels) {
		let cursor = from.getTime();
		while (cursor < to.getTime()) {
			const stop = new Date(cursor + 60 * 60_000);
			programs.push({
				id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(pid++).padStart(12, "0")}`,
				channelId: c.id,
				start: new Date(cursor).toISOString(),
				stop: stop.toISOString(),
				title: `${c.name} hour ${pid}`,
				subtitle: null,
				description: "Sample program for the U7 e2e fixture.",
				categories: [],
				recordingId: null,
				recordingStatus: null
			});
			cursor = stop.getTime();
		}
	}
	return { from: from.toISOString(), to: to.toISOString(), channels, programs };
}

async function mockBackend(page: Page, streamHits: string[]): Promise<void> {
	let settings = JSON.parse(JSON.stringify(baseSettings));
	let preferences = {
		ui: structuredClone(baseSettings.ui),
		channels: structuredClone(baseSettings.channels),
		player: structuredClone(baseSettings.player)
	};
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
	await page.route("**/api/v1/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON() as Partial<typeof settings>;
			settings = { ...settings, ...body };
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(settings)
		});
	});
	await page.route("**/api/v1/preferences", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON() as Partial<
				typeof preferences
			>;
			preferences = { ...preferences, ...body };
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(preferences)
		});
	});
	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items: [
					buildChannel(CHANNEL_A, "5", "Alpha"),
					buildChannel(CHANNEL_B, "6", "Bravo"),
					buildChannel(CHANNEL_C, "7", "Charlie")
				]
			})
		})
	);
	await page.route("**/api/v1/epg/grid**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(buildGrid())
		})
	);
	// Block real stream traffic — record every master.m3u8 hit so the
	// test can assert the player re-requested the playlist on a channel
	// switch.
	await page.route("**/api/v1/stream/**", (route) => {
		const url = route.request().url();
		if (url.includes("/master.m3u8")) streamHits.push(url);
		return route.fulfill({ status: 404, body: "" });
	});
}

test.describe("Live watch page", () => {
	test("renders the watch surface with the player + now/next + switcher + mini-guide", async ({
		page
	}) => {
		await mockBackend(page, []);
		await page.goto(`/watch/${CHANNEL_A}`);

		await expect(page.getByTestId("watch-page")).toBeVisible();
		await expect(page.getByTestId("player")).toBeVisible();
		const desktop = page.getByTestId("watch-desktop");
		await expect(desktop.getByTestId("watch-now-next")).toBeVisible();
		await expect(desktop.getByTestId("watch-switcher")).toBeVisible();
		await expect(desktop.getByTestId("watch-mini-guide")).toBeVisible();

		// Inline record actions exposed.
		await expect(desktop.getByTestId("watch-record")).toBeVisible();
		await expect(desktop.getByTestId("watch-record-series")).toBeVisible();
	});

	test("PageDown switches to the next channel — URL updates and stream restarts", async ({
		page
	}) => {
		const streamHits: string[] = [];
		await mockBackend(page, streamHits);
		await page.goto(`/watch/${CHANNEL_A}`);

		// Wait for the bootstrap fetches to settle so the channel order is
		// populated before we send the keyboard event.
		await expect(page.getByTestId("watch-page")).toBeVisible();
		await expect(
			page
				.getByTestId("watch-desktop")
				.getByTestId(`watch-channel-${CHANNEL_A}`)
		).toBeVisible();

		// Wait for the initial mount to fetch the master playlist for the
		// active channel; the player loads hls.js dynamically so the request
		// can lag the page load by a few hundred ms.
		await expect
			.poll(() => streamHits.some((u) => u.includes(CHANNEL_A)))
			.toBe(true);

		await page.keyboard.press("PageDown");

		// Favorites-first order is [B, A, C]; current=A; PgDn → C.
		await expect.poll(() => page.url()).toContain(`/watch/${CHANNEL_C}`);
		await expect
			.poll(() => streamHits.some((u) => u.includes(CHANNEL_C)))
			.toBe(true);
	});

	test("favorites the current channel and persists the setting", async ({
		page
	}) => {
		await mockBackend(page, []);
		await page.goto(`/watch/${CHANNEL_A}`);

		const favoriteButton = page
			.getByTestId("watch-desktop")
			.getByRole("button", { name: "Add Alpha to favorites" });
		await expect(favoriteButton).toHaveAttribute("aria-pressed", "false");

		const settingsRequest = page.waitForRequest(
			(request) =>
				request.url().endsWith("/api/v1/preferences") &&
				request.method() === "PATCH"
		);
		await favoriteButton.click();
		const request = await settingsRequest;

		expect(request.postDataJSON()).toMatchObject({
			channels: { favorites: [CHANNEL_B, CHANNEL_A] }
		});
		await expect(
			page
				.getByTestId("watch-desktop")
				.getByRole("button", { name: "Remove Alpha from favorites" })
		).toHaveAttribute("aria-pressed", "true");
	});

	test("PageUp wraps backward to the previous channel in the switcher order", async ({
		page
	}) => {
		const streamHits: string[] = [];
		await mockBackend(page, streamHits);
		await page.goto(`/watch/${CHANNEL_A}`);

		await expect(page.getByTestId("watch-page")).toBeVisible();
		await expect(
			page
				.getByTestId("watch-desktop")
				.getByTestId(`watch-channel-${CHANNEL_B}`)
		).toBeVisible();

		await page.keyboard.press("PageUp");

		// Order is [B (fav), A, C]; current=A; PgUp → B.
		await expect.poll(() => page.url()).toContain(`/watch/${CHANNEL_B}`);
		await expect
			.poll(() => streamHits.some((u) => u.includes(CHANNEL_B)))
			.toBe(true);
	});
});
