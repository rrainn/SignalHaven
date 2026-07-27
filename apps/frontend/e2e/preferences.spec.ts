import { expect, test, type Page } from "@playwright/test";

const CHANNEL_A = "00000000-0000-4000-8000-00000000000a";
const CHANNEL_B = "00000000-0000-4000-8000-00000000000b";
const CHANNEL_C = "00000000-0000-4000-8000-00000000000c";

const channels = [
	channel(CHANNEL_A, "5", "Alpha", 0),
	channel(CHANNEL_B, "6", "Bravo", 1),
	channel(CHANNEL_C, "7", "Charlie", 2)
];

const baseSettings = {
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

type SettingsFixture = typeof baseSettings;

function channel(id: string, number: string, name: string, sortOrder: number) {
	return {
		id,
		number,
		name,
		logoUrl: null,
		tvgId: null,
		tunerId: "11111111-1111-4111-8111-111111111111",
		tunerName: "Antenna",
		tunerKind: "hdhomerun",
		enabled: true,
		sortOrder,
		hasMapping: true
	};
}

async function mockBackend(page: Page) {
	let current: SettingsFixture = structuredClone(baseSettings);

	// Keep the app-boundary live subscription open without requiring the
	// backend event server; HTTP settings responses drive this scenario.
	await page.routeWebSocket("**/api/v1/events", () => {});
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
			const patch = route.request().postDataJSON() as Partial<SettingsFixture>;
			current = { ...current, ...patch } as SettingsFixture;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(current)
		});
	});
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
			body: JSON.stringify({ items: channels })
		})
	);
	await page.route("**/api/v1/epg/grid**", (route) => {
		const url = new URL(route.request().url());
		const from = new Date(
			url.searchParams.get("from") ?? new Date().toISOString()
		);
		const to = new Date(url.searchParams.get("to") ?? from.toISOString());
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(buildGrid(from, to))
		});
	});
	await page.route("**/api/v1/stream/**", (route) =>
		route.fulfill({ status: 404, body: "" })
	);

	return {
		get settings() {
			return current;
		}
	};
}

function buildGrid(from: Date, to: Date) {
	return {
		from: from.toISOString(),
		to: to.toISOString(),
		channels: channels.map(({ id, number, name, logoUrl, hasMapping }) => ({
			id,
			number,
			name,
			logoUrl,
			hasMapping
		})),
		programs: channels.map((item, index) => ({
			id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
			channelId: item.id,
			start: from.toISOString(),
			stop: to.toISOString(),
			title: `${item.name} Live`,
			subtitle: null,
			description: null,
			categories: [],
			recordingId: null,
			recordingStatus: null
		}))
	};
}

test("preferences update Guide and Watch immediately and survive reload", async ({
	page
}) => {
	const backend = await mockBackend(page);
	await page.goto("/settings");
	await page.getByRole("tab", { name: /appearance/i }).click();

	const saveButton = page.getByRole("button", { name: /^save$/i });
	const comfortableHeight = await saveButton.evaluate(
		(element) => element.getBoundingClientRect().height
	);
	await page.getByLabel("Density").click();
	await page.getByRole("option", { name: "Compact" }).click();
	await page.getByLabel(/guide hours visible/i).fill("6");
	await page.getByLabel("24-hour clock").click();
	await saveButton.click();
	await expect(page.getByRole("status")).toHaveText("Saved.");
	// Assert the user-owned setting at the persisted API boundary. Guide data
	// requests may include adjacent prefetch buffers for seamless scrolling.
	await expect.poll(() => backend.settings.ui.epgHoursVisible).toBe(6);
	await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
	const compactHeight = await saveButton.evaluate(
		(element) => element.getBoundingClientRect().height
	);
	expect(compactHeight).toBeLessThan(comfortableHeight);

	await page.getByRole("link", { name: "Channels" }).first().click();
	await expect(page.getByTestId("channels-list")).toBeVisible();
	await page.getByTestId(`favorite-${CHANNEL_A}`).click();
	await expect
		.poll(() => backend.settings.channels.favorites)
		.toEqual([CHANNEL_A]);
	await page.getByTestId(`favorite-${CHANNEL_C}`).click();
	await expect
		.poll(() => backend.settings.channels.favorites)
		.toEqual([CHANNEL_A, CHANNEL_C]);
	await page.getByTestId(`hide-${CHANNEL_B}`).click();
	await expect
		.poll(() => backend.settings.channels.hidden)
		.toEqual([CHANNEL_B]);

	await page
		.getByRole("button", { name: "Drag to reorder Charlie" })
		.dragTo(page.locator(`[data-channel-row-id="${CHANNEL_A}"]`));
	await expect
		.poll(() => backend.settings.channels.order.slice(0, 2))
		.toEqual([CHANNEL_C, CHANNEL_A]);

	await page.getByRole("link", { name: "Guide" }).first().click();
	await expect(page.getByTestId("guide-grid")).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByTestId("channel-row")
				.evaluateAll((rows) =>
					rows.map((row) => row.getAttribute("data-channel-id"))
				)
		)
		.toEqual([CHANNEL_C, CHANNEL_A]);
	await expect(
		page.getByTestId("guide-window-label").locator("..")
	).not.toContainText(/\b(?:AM|PM)\b/i);

	await page.getByRole("link", { name: "Watch 5 Alpha" }).click();
	const switcher = page
		.getByTestId("watch-desktop")
		.getByTestId("watch-switcher");
	await expect(switcher.getByTestId(`watch-channel-${CHANNEL_B}`)).toHaveCount(
		0
	);
	await expect
		.poll(() =>
			switcher
				.locator("[data-testid^='watch-channel-00000000-']")
				.evaluateAll((items) =>
					items.map((item) => item.getAttribute("data-testid"))
				)
		)
		.toEqual([`watch-channel-${CHANNEL_C}`, `watch-channel-${CHANNEL_A}`]);
	await expect(
		page.getByTestId("watch-desktop").getByTestId("watch-now-next")
	).not.toContainText(/\b(?:AM|PM)\b/i);

	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
	await expect(switcher.getByTestId(`watch-channel-${CHANNEL_B}`)).toHaveCount(
		0
	);
	await expect(
		switcher.getByTestId(`watch-channel-${CHANNEL_C}`)
	).toBeVisible();
});
