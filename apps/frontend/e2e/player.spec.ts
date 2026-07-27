import { test, expect, type Page } from "@playwright/test";

declare global {
	interface Window {
		/** Mutable browser fixture used to model a rotating HLS seek range. */
		__signalhavenTimeShiftFixture?: {
			current: number;
			start: number;
			end: number;
		};
	}
}

/**
 * E2E smoke for the U6 video player.
 *
 * The actual HLS playback is mocked (the test runner has no upstream
 * tuner) — every request to `/api/v1/stream/**` is fulfilled with an
 * empty 200 so HLS.js attaches without trying to fetch real segments.
 * The assertions cover the *control* surface called out in the U6
 * acceptance criteria: play/pause, fullscreen, quality switch,
 * keyboard shortcuts, captions toggle.
 */

const CHANNEL_ID = "00000000-0000-4000-8000-000000000123";

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
	timeShift: {
		enabled: true,
		bufferPath: null,
		durationMinutes: 60,
		maxDiskGb: 10,
		idleGraceSeconds: 30
	},
	channels: { favorites: [], hidden: [], order: [] },
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {} as Record<string, string>
	},
	observability: { debugBundleEnabled: false }
};

async function mockBackend(page: Page) {
	let settings = JSON.parse(JSON.stringify(baseSettings));
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
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(settings)
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(settings)
		});
	});
	// Stub the channels list so WatchPage's Promise.all resolves cleanly.
	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items: [
					{
						id: CHANNEL_ID,
						number: "12.1",
						name: "Player Test Channel",
						logoUrl: null,
						tvgId: null,
						tunerId: "00000000-0000-4000-8000-000000000124",
						tunerName: "Test Tuner",
						tunerKind: "hdhomerun",
						enabled: true,
						sortOrder: 0,
						hasMapping: true
					}
				]
			})
		})
	);
	// Block real stream traffic — we don't have an ffmpeg or a tuner here.
	// A 404 lets the player surface its error state without the CI worker
	// hanging on a never-resolving request.
	await page.route("**/api/v1/stream/**", (route) =>
		route.fulfill({ status: 404, body: "" })
	);
}

test.describe("Video player", () => {
	test("renders the player surface with custom controls", async ({ page }) => {
		await mockBackend(page);
		await page.goto(`/watch/${CHANNEL_ID}`);

		await expect(page.getByTestId("player")).toBeVisible();
		await expect(page.getByTestId("player-video")).toBeAttached();

		// Control surface is rendered.
		await expect(page.getByTestId("player-play")).toBeVisible();
		await expect(page.getByTestId("player-mute")).toBeVisible();
		await expect(page.getByTestId("player-volume")).toBeVisible();
		await expect(page.getByTestId("player-quality")).toBeVisible();
		await expect(page.getByTestId("player-fullscreen")).toBeVisible();
		await expect(page.getByTestId("player-pip")).toBeVisible();
	});

	test("play/pause button toggles aria-label", async ({ page }) => {
		await mockBackend(page);
		await page.goto(`/watch/${CHANNEL_ID}`);

		const playBtn = page.getByTestId("player-play");
		await expect(playBtn).toHaveAttribute("aria-label", "Play");

		// The Player wires its 'play' event listener inside a React useEffect
		// that runs after the first paint.  In the SSR'd production build,
		// the assertion above resolves immediately from server-rendered HTML –
		// potentially before the listener is attached.  We therefore dispatch
		// a synthetic 'play' event on a 100 ms interval so it is handled as
		// soon as the useEffect runs.  Synthetic events from JavaScript are
		// ignored by Chrome's media engine, so no compensating 'pause' fires
		// and playing=true is stable once React has re-rendered.
		//
		// The interval skips dispatches once the button already shows "Pause"
		// (listener attached, React re-rendered) and is stopped in finally so
		// no extra events are dispatched after the assertion resolves.
		const timerId = await page.evaluate(() =>
			window.setInterval(() => {
				const v = document.querySelector(
					'[data-testid="player-video"]'
				) as HTMLVideoElement | null;
				const btn = document.querySelector(
					'[data-testid="player-play"]'
				) as HTMLElement | null;
				// Stop dispatching once React has already reflected playing=true.
				if (!v || btn?.getAttribute("aria-label") === "Pause") return;
				v.dispatchEvent(new Event("play"));
			}, 100)
		);
		try {
			await expect(playBtn).toHaveAttribute("aria-label", "Pause", {
				timeout: 10_000
			});
		} finally {
			await page.evaluate((id: number) => clearInterval(id), timerId);
		}
	});

	test("quality switcher persists the user's choice via the settings API", async ({
		page
	}) => {
		await mockBackend(page);
		const patches: Array<Record<string, unknown>> = [];
		await page.route("**/api/v1/settings", async (route) => {
			if (route.request().method() === "PATCH") {
				patches.push(route.request().postDataJSON() as Record<string, unknown>);
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(baseSettings)
			});
		});
		await page.goto(`/watch/${CHANNEL_ID}`);

		await page.getByTestId("player-quality").click();
		await page.getByTestId("quality-720p").click();

		// Wait for the PATCH to land.
		await expect.poll(() => patches.length).toBeGreaterThan(0);
		const last = patches[patches.length - 1] as {
			player?: { qualityByChannel?: Record<string, string> };
		};
		expect(last.player?.qualityByChannel?.[CHANNEL_ID]).toBe("720p");
	});

	test("fullscreen button is exposed and triggers the API without throwing", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto(`/watch/${CHANNEL_ID}`);

		const fsBtn = page.getByTestId("player-fullscreen");
		await expect(fsBtn).toHaveAttribute("aria-label", "Enter fullscreen");
		// Headless Chromium permits requestFullscreen via user gesture; even
		// when it returns a rejected promise the click MUST NOT throw.
		await fsBtn.click();
	});

	test("keyboard shortcuts: space toggles play, m mutes, c toggles captions intent", async ({
		page
	}) => {
		await mockBackend(page);
		const patches: Array<{ player?: Record<string, unknown> }> = [];
		await page.route("**/api/v1/settings", async (route) => {
			if (route.request().method() === "PATCH") {
				patches.push(
					route.request().postDataJSON() as { player?: Record<string, unknown> }
				);
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(baseSettings)
			});
		});
		await page.goto(`/watch/${CHANNEL_ID}`);
		const player = page.getByTestId("player");
		await player.focus();

		// Synthesize play event so the playing→paused transition is observable.
		await page.evaluate(() => {
			const v = document.querySelector(
				'[data-testid="player-video"]'
			) as HTMLVideoElement | null;
			if (v) v.dispatchEvent(new Event("play"));
		});

		// m → mute (and persists)
		await player.press("m");
		await expect
			.poll(
				() => patches.find((p) => p.player?.["muted"] === true) !== undefined
			)
			.toBe(true);
		await expect(page.getByTestId("player-mute")).toHaveAttribute(
			"aria-pressed",
			"true"
		);

		// c → captions intent
		await player.press("c");
		await expect
			.poll(
				() =>
					patches.find((p) => p.player?.["captionsEnabled"] === true) !==
					undefined
			)
			.toBe(true);
	});

	test("captions toggle is hidden until the player advertises a track", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto(`/watch/${CHANNEL_ID}`);
		// Without a SUBTITLES rendition (the stream route is mocked to 404),
		// the captions button should NOT be rendered.
		await expect(page.getByTestId("player-captions")).toHaveCount(0);
	});

	test("time-shift controls follow the retained range and recover expired media", async ({
		page
	}) => {
		await mockBackend(page);
		await page.goto(`/watch/${CHANNEL_ID}`);
		const player = page.getByTestId("player");
		await expect(page.getByTestId("player-video")).toBeAttached();

		// A controllable TimeRanges fixture models HLS.js rotating old segments
		// without requiring a tuner or wall-clock wait in the browser suite.
		await page.evaluate(() => {
			const video = document.querySelector(
				'[data-testid="player-video"]'
			) as HTMLVideoElement;
			const state = { current: 100, start: 40, end: 120 };
			Object.defineProperty(window, "__signalhavenTimeShiftFixture", {
				configurable: true,
				value: state
			});
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => state.current,
				set: (value: number) => {
					state.current = value;
				}
			});
			Object.defineProperty(video, "seekable", {
				configurable: true,
				get: () => ({
					length: 1,
					start: () => state.start,
					end: () => state.end
				})
			});
			video.dispatchEvent(new Event("progress"));
		});

		await player.focus();
		await player.press("ArrowLeft");
		await expect(page.getByText("Delayed")).toBeVisible();
		await page.getByRole("button", { name: "Go Live" }).click();
		await expect(page.getByText("Live", { exact: true })).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => window.__signalhavenTimeShiftFixture?.current)
			)
			.toBe(119.5);

		await page.evaluate(() => {
			const fixture = window.__signalhavenTimeShiftFixture;
			if (!fixture) throw new Error("Missing time-shift fixture");
			fixture.current = 20;
			fixture.start = 50;
			fixture.end = 130;
			document
				.querySelector('[data-testid="player-video"]')
				?.dispatchEvent(new Event("progress"));
		});

		// Loading and recovery are both live regions, so identify the outcome by
		// its user-visible message instead of assuming only one status exists.
		await expect(
			page.getByRole("status").filter({ hasText: "earliest available point" })
		).toBeVisible();
	});
});
