import { test, expect, type Page } from "@playwright/test";

/**
 * Frontend perf gate — asserts FCP < 1.5s on `/guide` under a Slow-3G
 * network profile + 4× CPU throttle, applied via the Chrome DevTools
 * Protocol. See docs/perf-baseline.md for the rationale.
 *
 * The backend is mocked at the network layer so the measurement is
 * dominated by frontend code — backend latency would add noise that's
 * unrelated to the perf budget we want to defend.
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

function buildGridFixture() {
	const fromHour = new Date();
	fromHour.setMinutes(0, 0, 0);
	const from = new Date(fromHour.getTime() - 60 * 60_000);
	const to = new Date(from.getTime() + 24 * 60 * 60_000);

	// 30 channels × 24h × 30-min programs is the same shape as the
	// smoke-test fixture — representative of a real EPG grid.
	const channels = Array.from({ length: 30 }, (_, i) => ({
		id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
		number: `${100 + i}`,
		name: `Channel ${i + 1}`,
		logoUrl: null,
		hasMapping: true
	}));

	const programs: Array<Record<string, unknown>> = [];
	let pid = 0;
	for (const ch of channels) {
		let cursor = from.getTime();
		while (cursor < to.getTime()) {
			const stop = new Date(cursor + 30 * 60_000);
			programs.push({
				id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(pid++).padStart(12, "0")}`,
				channelId: ch.id,
				start: new Date(cursor).toISOString(),
				stop: stop.toISOString(),
				title: `Program ${pid}`,
				subtitle: null,
				description: "Sample program for the perf fixture.",
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
		channels,
		programs
	};
}

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
			body: JSON.stringify(sampleSettings)
		})
	);
	await page.route("**/api/v1/epg/grid**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(buildGridFixture())
		})
	);
}

test.describe("Frontend perf budgets", () => {
	test("guide reaches FCP < 1.5s under 4x CPU + Slow-3G throttle", async ({
		page,
		browserName
	}) => {
		test.skip(
			browserName !== "chromium",
			"FCP throttling uses the Chrome DevTools Protocol."
		);

		await mockBackend(page);

		// Apply throttling via the Chrome DevTools Protocol. The values
		// come from Lighthouse's Slow-3G profile (1.6 Mbit/s down,
		// 750 Kbit/s up, 150 ms RTT) plus a 4× CPU slowdown — the same
		// profile the Lighthouse CI job uses.
		const client = await page.context().newCDPSession(page);
		await client.send("Network.enable");
		await client.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: 150,
			downloadThroughput: (1.6 * 1024 * 1024) / 8,
			uploadThroughput: (750 * 1024) / 8
		});
		await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });

		await page.goto("/guide", { waitUntil: "domcontentloaded" });

		// Wait until Chrome has actually recorded the FCP entry. The
		// PerformanceObserver callback fires once the browser commits
		// the first paint of any DOM content (text, image, non-white
		// canvas, …) — exactly what the Lighthouse "First Contentful
		// Paint" audit measures.
		const fcpMs = await page.evaluate<number>(
			() =>
				new Promise<number>((resolve) => {
					const existing = performance
						.getEntriesByType("paint")
						.find((e) => e.name === "first-contentful-paint");
					if (existing) {
						resolve(existing.startTime);
						return;
					}
					new PerformanceObserver((list, obs) => {
						const entry = list
							.getEntries()
							.find((e) => e.name === "first-contentful-paint");
						if (entry) {
							obs.disconnect();
							resolve(entry.startTime);
						}
					}).observe({ type: "paint", buffered: true });
				})
		);

		// eslint-disable-next-line no-console
		console.log(`Guide FCP under throttle: ${fcpMs.toFixed(0)}ms`);
		expect(fcpMs).toBeLessThan(1500);
	});
});
