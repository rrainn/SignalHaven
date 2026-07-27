import { test, expect, type Page } from "@playwright/test";

const FIRST_CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000000";

/**
 * E2E smoke for the live grid guide (U4-guide).
 *
 * The backend is mocked so every requested range renders 30 channels with
 * back-to-back programs. We exercise:
 *   - The grid renders with the sticky `now` indicator and channel rows.
 *   - Clicking a program opens the details modal with the three actions.
 *   - Vertical scrolling cannot mutate the requested time range.
 *   - Time navigation is exact, repeatable, and usable on a phone viewport.
 */

const sampleSettings = {
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
	channels: { favorites: [], hidden: [], order: [] },
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {}
	},
	observability: { debugBundleEnabled: false }
};

const channels = Array.from({ length: 30 }, (_, i) => ({
	id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
	number: `${100 + i}`,
	name: `Channel ${i + 1}`,
	logoUrl: null,
	hasMapping: true
}));

interface RequestedRange {
	from: string;
	to: string;
}

interface MockBackendOptions {
	/** Keeps unloaded intervals visible long enough to exercise buffer handoff. */
	gridDelayMs?: number;
	/** Returns a confirmed provider window with no scheduled programs. */
	emptyGrid?: boolean;
}

/** Build only the requested window so range-navigation tests match production. */
function buildGridFixture(from: Date, to: Date) {
	const gridChannels = channels.map((channel) => ({ ...channel }));
	const programs: Array<Record<string, unknown>> = [];
	let pid = 0;
	for (const [channelIndex, ch] of gridChannels.entries()) {
		let cursor = from.getTime();
		while (cursor < to.getTime()) {
			const minutes = 30;
			const stop = new Date(Math.min(cursor + minutes * 60_000, to.getTime()));
			// Slice boundaries must not redefine identity; otherwise merging a
			// prefetch can replace unrelated programs that reused a local counter.
			const halfHourSlot = Math.floor(cursor / (30 * 60_000)) % 10_000_000_000;
			const stableTail = String(
				(channelIndex + 1) * 10_000_000_000 + halfHourSlot
			).padStart(12, "0");
			programs.push({
				id: `bbbbbbbb-bbbb-4bbb-8bbb-${stableTail}`,
				channelId: ch.id,
				start: new Date(cursor).toISOString(),
				stop: stop.toISOString(),
				title: `Program ${++pid}`,
				subtitle: null,
				description: "Sample program for the e2e fixture.",
				categories: ["News"],
				recordingId: null,
				recordingStatus: null
			});
			cursor = stop.getTime();
		}
	}

	return {
		from: from.toISOString(),
		to: to.toISOString(),
		channels: gridChannels,
		programs
	};
}

async function mockBackend(
	page: Page,
	streamHits: string[] = [],
	options: MockBackendOptions = {}
) {
	const gridRequests: RequestedRange[] = [];
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
			body: JSON.stringify(sampleSettings)
		})
	);
	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items: channels.map((channel, index) => ({
					...channel,
					tvgId: null,
					tunerId: "11111111-1111-4111-8111-111111111111",
					tunerName: "Antenna",
					tunerKind: "hdhomerun",
					enabled: true,
					sortOrder: index
				}))
			})
		})
	);
	await page.route("**/api/v1/epg/grid**", (route) => {
		const url = new URL(route.request().url());
		const requestedFrom = url.searchParams.get("from");
		const requestedTo = url.searchParams.get("to");
		if (!requestedFrom || !requestedTo) {
			return route.fulfill({ status: 400, body: "Missing guide bounds" });
		}

		const from = new Date(requestedFrom);
		const to = new Date(requestedTo);
		if (
			!Number.isFinite(from.getTime()) ||
			!Number.isFinite(to.getTime()) ||
			from >= to
		) {
			return route.fulfill({ status: 400, body: "Invalid guide bounds" });
		}

		// Recording the exact contract lets interaction tests catch accidental
		// range shifts without coupling to component state.
		gridRequests.push({
			from: from.toISOString(),
			to: to.toISOString()
		});
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				const fixture = buildGridFixture(from, to);
				if (options.emptyGrid) fixture.programs = [];
				void route
					.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify(fixture)
					})
					.then(resolve);
			}, options.gridDelayMs ?? 0);
		});
	});
	// A playlist request proves the destination player started the live feed.
	await page.route("**/api/v1/stream/**", (route) => {
		const url = route.request().url();
		if (url.includes("/master.m3u8")) streamHits.push(url);
		return route.fulfill({ status: 404, body: "" });
	});

	return { gridRequests };
}

/** Read the viewport's time coordinate rather than presentation copy. */
async function visibleStart(page: Page): Promise<number> {
	const value = await page
		.getByTestId("guide-page")
		.getAttribute("data-visible-start");
	if (!value) throw new Error("Guide did not expose a visible start");
	return Date.parse(value);
}

/** Allow range replacement and its follow-up layout frame to finish. */
async function waitForGuideToSettle(page: Page) {
	await expect(page.getByTestId("guide-grid")).toBeVisible();
	await page.waitForTimeout(100);
	await expect(
		page.getByRole("status", { name: "Updating guide" })
	).toHaveCount(0);
}

/** Click a live cell only where it is genuinely exposed beside sticky chrome. */
async function clickExposedLiveProgram(page: Page): Promise<void> {
	const cells = page.locator(
		'[data-testid="program-cell"][data-airing="true"]'
	);
	const point = await cells.evaluateAll((elements) => {
		for (const element of elements) {
			const cell = element as HTMLElement;
			const grid = cell.closest<HTMLElement>('[data-testid="guide-grid"]');
			const channels = grid?.querySelector<HTMLElement>(
				'[role="columnheader"][aria-colindex="1"]'
			);
			if (!grid || !channels) continue;

			const cellRect = cell.getBoundingClientRect();
			const gridRect = grid.getBoundingClientRect();
			const channelsRect = channels.getBoundingClientRect();
			const left = Math.max(cellRect.left + 2, channelsRect.right + 2);
			const right = Math.min(cellRect.right - 2, gridRect.right - 2);
			const top = Math.max(cellRect.top + 2, channelsRect.bottom + 2);
			const bottom = Math.min(cellRect.bottom - 2, gridRect.bottom - 2);
			if (left >= right || top >= bottom) continue;

			const candidate = { x: (left + right) / 2, y: (top + bottom) / 2 };
			const hit = document.elementFromPoint(candidate.x, candidate.y);
			if (hit?.closest('[data-testid="program-cell"]') === cell)
				return candidate;
		}
		return null;
	});

	expect(point).not.toBeNull();
	await page.mouse.click(point!.x, point!.y);
}

test.describe("Live grid guide", () => {
	test("mounts the guide without a hydration replacement", async ({ page }) => {
		const hydrationErrors: string[] = [];
		const captureHydrationError = (message: string) => {
			if (message.includes("Hydration failed")) hydrationErrors.push(message);
		};
		page.on("console", (message) => {
			// Replacing the guide after Safari restores native scroll state can split
			// the virtual viewport from the physical grid before user interaction.
			if (message.type() === "error") captureHydrationError(message.text());
		});
		page.on("pageerror", (error) => captureHydrationError(error.message));

		await mockBackend(page);
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		expect(hydrationErrors).toEqual([]);
	});

	test("renders the grid, virtualises cells, and opens the details modal", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto("/guide");

		// Grid renders with channel rows + at least one program cell.
		await expect(page.getByTestId("guide-grid")).toBeVisible();
		await expect(page.getByTestId("channel-row").first()).toBeVisible();
		const cells = page.getByTestId("program-cell");
		const cellCount = await cells.count();
		expect(cellCount).toBeGreaterThan(0);
		// A 30-channel requested window still contains hundreds of programs; the
		// rendered DOM must remain bounded to the viewport and its overscan.
		expect(cellCount).toBeLessThan(400);
		const verticalExtent = await page
			.getByTestId("guide-grid")
			.evaluate((element) => ({
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight
			}));
		// Large lineups scroll inside the guide so offscreen channel rows can be
		// virtualized instead of joining every horizontal-frame reconciliation.
		expect(verticalExtent.scrollHeight).toBeGreaterThan(
			verticalExtent.clientHeight
		);

		// Sticky "now" indicator is present.
		await expect(page.getByTestId("now-indicator")).toBeVisible();

		// A live cell exposes Watch; future cells intentionally do not.
		const liveCell = page.locator(
			'[data-testid="program-cell"][data-airing="true"]'
		);
		await expect(liveCell.first()).toBeVisible();
		await clickExposedLiveProgram(page);
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: /^watch$/i })
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: /^record$/i })
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: /record series/i })
		).toBeVisible();
	});

	test("toolbar exposes explicit date and time navigation", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto("/guide");
		await expect(page.getByTestId("guide-grid")).toBeVisible();

		await expect(page.getByRole("button", { name: /^now$/i })).toBeVisible();
		await expect(
			page.getByRole("button", { name: /forward 30m/i })
		).toBeVisible();
		await expect(page.getByRole("button", { name: /back 30m/i })).toBeVisible();
		await expect(
			page.getByRole("combobox", { name: /jump to time/i })
		).toBeVisible();
		await expect(page.getByRole("button", { name: /prime time/i })).toHaveCount(
			0
		);
		await expect(page.getByRole("button", { name: /today/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /tomorrow/i })).toBeVisible();
	});

	test("vertical-only scrolling never changes the requested time range", async ({
		page
	}) => {
		const { gridRequests } = await mockBackend(page);
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const grid = page.getByTestId("guide-grid");
		const requestsBeforeScroll = gridRequests.map((request) => ({
			...request
		}));
		const visibleStartBeforeScroll = await visibleStart(page);

		await grid.evaluate((element) => {
			element.scrollTop += 192;
		});
		await expect
			.poll(() => grid.evaluate((element) => element.scrollTop))
			.toBeGreaterThan(0);

		// The former regression treated any scroll event at x=0 as a left-edge
		// request, so include the settled-range debounce in this observation.
		await page.waitForTimeout(250);
		expect(gridRequests).toEqual(requestsBeforeScroll);
		expect(await visibleStart(page)).toBe(visibleStartBeforeScroll);
	});

	test("keeps time coordinates stable while a scrolled range loads", async ({
		page
	}) => {
		const { gridRequests } = await mockBackend(page, [], { gridDelayMs: 250 });
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const grid = page.getByTestId("guide-grid");
		const initialRequestCount = gridRequests.length;
		const initialCanvasWidth = await grid.evaluate((element) =>
			Math.round(element.scrollWidth)
		);
		const initialVisibleStart = await visibleStart(page);
		expect(initialCanvasWidth).toBeGreaterThan(30_000);

		const anchoredScrollLeft = await grid.evaluate((element) => {
			// The far calendar edge is outside every bounded initial buffer. Using
			// it keeps the regression deterministic across browser viewport widths.
			element.scrollLeft = element.scrollWidth - element.clientWidth;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
			return element.scrollLeft;
		});
		await expect.poll(() => visibleStart(page)).not.toBe(initialVisibleStart);
		const anchoredStart = await visibleStart(page);
		const loadingLabel = page
			.getByTestId("schedule-loading")
			.first()
			.getByTestId("schedule-gap-content");
		const channels = page.getByRole("columnheader", { name: "Channels" });
		await expect(loadingLabel).toBeVisible();
		const [loadingBox, channelsBox] = await Promise.all([
			loadingLabel.boundingBox(),
			channels.boundingBox()
		]);
		expect(loadingBox).not.toBeNull();
		expect(channelsBox).not.toBeNull();
		// Unfetched space must explain itself beside the fixed channel rail even
		// in WebKit, where sticky content inside absolute cells is unreliable.
		expect(
			Math.abs(loadingBox!.x - (channelsBox!.x + channelsBox!.width))
		).toBeLessThan(2);
		await expect
			.poll(() => gridRequests.length)
			.toBeGreaterThan(initialRequestCount);
		await waitForGuideToSettle(page);

		expect(await visibleStart(page)).toBe(anchoredStart);
		expect(await grid.evaluate((element) => element.scrollLeft)).toBe(
			anchoredScrollLeft
		);
		expect(
			await grid.evaluate((element) => Math.round(element.scrollWidth))
		).toBe(initialCanvasWidth);
		await expect(page.getByTestId("program-cell").first()).toBeVisible();
	});

	test("keeps a confirmed missing-data label visible during horizontal scrolling", async ({
		page
	}) => {
		await mockBackend(page, [], { emptyGrid: true });
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const grid = page.getByTestId("guide-grid");
		const label = page.getByTestId("schedule-gap-content").first();
		const channels = page.getByRole("columnheader", { name: "Channels" });
		await expect(label).toBeVisible();

		await grid.evaluate((element) => {
			element.scrollLeft += 800;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await expect(label).toBeVisible();

		const [labelBox, channelsBox] = await Promise.all([
			label.boundingBox(),
			channels.boundingBox()
		]);
		expect(labelBox).not.toBeNull();
		expect(channelsBox).not.toBeNull();
		// The frame-committed transform keeps the label immediately beside the
		// channel rail without relying on WebKit's nested sticky implementation.
		expect(
			Math.abs(labelBox!.x - (channelsBox!.x + channelsBox!.width))
		).toBeLessThan(2);
	});

	test("Earlier and Later move the viewport by exactly 30 minutes", async ({
		page
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await mockBackend(page);
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const later = page.getByRole("button", { name: /forward 30m/i });
		const earlier = page.getByRole("button", { name: /back 30m/i });
		const initialStart = await visibleStart(page);

		await later.click();
		await expect
			.poll(() => visibleStart(page))
			.toBe(initialStart + 30 * 60_000);

		await later.click();
		await expect
			.poll(() => visibleStart(page))
			.toBe(initialStart + 60 * 60_000);

		await earlier.click();
		await expect
			.poll(() => visibleStart(page))
			.toBe(initialStart + 30 * 60_000);

		await earlier.click();
		await expect.poll(() => visibleStart(page)).toBe(initialStart);
	});

	test("rapid Later activations accumulate while smooth scrolling", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const later = page.getByRole("button", { name: /forward 30m/i });
		const initialStart = await visibleStart(page);

		// Keep real motion enabled so this catches clicks collapsing onto one
		// in-flight native smooth-scroll destination.
		await later.click();
		await later.click();
		await later.click();

		await expect
			.poll(() => visibleStart(page))
			.toBe(initialStart + 90 * 60_000);
		await waitForGuideToSettle(page);
	});

	test("repeated Now activation resolves to one deterministic position", async ({
		page
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await mockBackend(page);
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const now = page.getByRole("button", { name: /^now$/i });
		await now.click();
		await waitForGuideToSettle(page);
		const firstPosition = await visibleStart(page);

		await now.click();
		await expect.poll(() => visibleStart(page)).toBe(firstPosition);
	});

	test("phone layout contains horizontal overflow and preserves touch targets", async ({
		page
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockBackend(page);
		await page.goto("/guide");
		await waitForGuideToSettle(page);

		const documentWidths = await page.evaluate(() => ({
			client: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		}));
		expect(documentWidths.scroll).toBe(documentWidths.client);

		const navigation = page.getByLabel("Guide navigation");
		const controls = [
			navigation.getByRole("button", { name: /today/i }),
			navigation.getByRole("button", { name: /tomorrow/i }),
			navigation.getByRole("button", { name: /back 30m/i }),
			navigation.getByRole("button", { name: /^now$/i }),
			navigation.getByRole("button", { name: /forward 30m/i }),
			navigation.getByRole("combobox", { name: /jump to time/i })
		];

		for (const control of controls) {
			await expect(control).toBeVisible();
			const box = await control.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(44);
		}
	});

	test("clicking a channel label opens its live feed", async ({ page }) => {
		const streamHits: string[] = [];
		await mockBackend(page, streamHits);
		await page.goto("/guide");

		await page.getByRole("link", { name: "Watch 100 Channel 1" }).click();

		await expect.poll(() => page.url()).toContain(`/watch/${FIRST_CHANNEL_ID}`);
		await expect(page.getByTestId("player")).toBeVisible();
		await expect
			.poll(() => streamHits.some((url) => url.includes(FIRST_CHANNEL_ID)))
			.toBe(true);
	});
});
