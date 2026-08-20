import { test, expect, type Page, type Route } from "./fixtures";

/**
 * E2E for the U8 recordings library + playback flow.
 *
 * The data backend is mocked, but recording playback uses the real HLS URL
 * contract: a playable-shaped manifest references an immutable segment. The
 * flow verifies playback state, seeking, progress persistence, and reload
 * resume without relying on the historical mocked 404.
 */

const RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000aaa";
const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const PLAYBACK_SESSION_ID = "33333333-3333-4333-8333-333333333333";

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
	channels: { favorites: [], hidden: [], order: [] },
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {} as Record<string, string>
	},
	observability: { debugBundleEnabled: false }
};

interface MockRecording {
	id: string;
	channelId: string;
	programId: null;
	title: string;
	status: "scheduled" | "recording" | "completed" | "failed" | "cancelled";
	scheduledStart: string;
	scheduledEnd: string;
	actualStart: string | null;
	actualEnd: string | null;
	filePath: string | null;
	fileSize: number | null;
	durationSeconds: number | null;
	errorMessage: string | null;
	seriesRuleId: string | null;
	manuallyProtected: boolean;
	watchedAt: string | null;
	resumePositionSeconds: number | null;
}

const recordingMetadata = {
	subtitle: "A Study in Pink",
	description: "Sherlock and John meet for the first time.",
	episode: 1,
	season: 1,
	categories: ["Drama"],
	artworkUrl: null
};

function buildRecording(overrides: Partial<MockRecording> = {}): MockRecording {
	return {
		id: RECORDING_ID,
		channelId: CHANNEL_ID,
		programId: null,
		title: "Sherlock S01E01",
		status: "completed",
		scheduledStart: "2025-01-01T00:00:00Z",
		scheduledEnd: "2025-01-01T01:00:00Z",
		actualStart: "2025-01-01T00:00:00Z",
		actualEnd: "2025-01-01T01:00:00Z",
		filePath: "/var/lib/signalhaven/recordings/sherlock.mkv",
		fileSize: 2_500_000_000,
		durationSeconds: 3000,
		errorMessage: null,
		seriesRuleId: SERIES_ID,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		...overrides
	};
}

interface BackendState {
	recordings: MockRecording[];
	patches: Array<Record<string, unknown>>;
	manifestRequests: number;
	manifestStartRequests: Array<number | null>;
	manifestViewerRequests: Array<string | null>;
	segmentRequests: number;
	segmentViewerRequests: Array<string | null>;
	releaseViewerRequests: string[];
}

async function mockBackend(page: Page): Promise<BackendState> {
	const state: BackendState = {
		recordings: [buildRecording()],
		patches: [],
		manifestRequests: 0,
		manifestStartRequests: [],
		manifestViewerRequests: [],
		segmentRequests: 0,
		segmentViewerRequests: [],
		releaseViewerRequests: []
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

	await page.route("**/api/v1/settings", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(baseSettings)
		})
	);

	await page.route("**/api/v1/channels", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items: [
					{
						id: CHANNEL_ID,
						number: "1.1",
						name: "Mystery TV",
						logoUrl: null,
						tvgId: null,
						tunerId: "00000000-0000-4000-8000-000000000bbb",
						tunerName: "Tuner 1",
						tunerKind: "hdhomerun",
						enabled: true,
						sortOrder: 1,
						hasMapping: true
					}
				]
			})
		})
	);

	// Listing endpoint.
	await page.route("**/api/v1/recordings**", async (route: Route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const method = route.request().method();

		// Viewer release is idempotent because pagehide and unmount may race.
		const releaseMatch = path.match(
			/\/api\/v1\/recordings\/[^/]+\/viewers\/([^/]+)\/release$/
		);
		if (releaseMatch && method === "POST") {
			state.releaseViewerRequests.push(
				decodeURIComponent(releaseMatch[1] ?? "")
			);
			await route.fulfill({ status: 204, body: "" });
			return;
		}

		// PATCH /api/v1/recordings/:id — record progress writes
		const patchMatch = path.match(/\/api\/v1\/recordings\/([^/]+)$/);
		if (patchMatch && method === "PATCH") {
			const id = decodeURIComponent(patchMatch[1] ?? "");
			const body = route.request().postDataJSON() as Record<string, unknown>;
			state.patches.push({ id, ...body });
			const target = state.recordings.find((r) => r.id === id);
			if (target) {
				if (typeof body["resumePositionSeconds"] === "number") {
					target.resumePositionSeconds = body[
						"resumePositionSeconds"
					] as number;
				} else if (body["resumePositionSeconds"] === null) {
					target.resumePositionSeconds = null;
				}
				if (body["watched"] === true) {
					target.watchedAt = new Date().toISOString();
				} else if (body["watched"] === false) {
					target.watchedAt = null;
				}
				if (typeof body["manuallyProtected"] === "boolean") {
					target.manuallyProtected = body["manuallyProtected"];
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(target ?? {})
			});
			return;
		}

		// DELETE /api/v1/recordings/:id
		const deleteMatch = path.match(/\/api\/v1\/recordings\/([^/]+)$/);
		if (deleteMatch && method === "DELETE") {
			const id = decodeURIComponent(deleteMatch[1] ?? "");
			const target = state.recordings.find((recording) => recording.id === id);
			if (
				target?.manuallyProtected &&
				url.searchParams.get("overrideProtection") !== "true"
			) {
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({
						error: {
							code: "recording_protected",
							message: "Recording is protected"
						}
					})
				});
				return;
			}
			state.recordings = state.recordings.filter((r) => r.id !== id);
			await route.fulfill({ status: 204, body: "" });
			return;
		}

		// GET /api/v1/recordings/:id — detail (not the listing)
		const detailMatch = path.match(/\/api\/v1\/recordings\/([0-9a-f-]{36})$/i);
		if (detailMatch && method === "GET") {
			const id = decodeURIComponent(detailMatch[1] ?? "");
			const target = state.recordings.find((r) => r.id === id);
			if (!target) {
				await route.fulfill({ status: 404, body: "" });
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					...target,
					metadata: recordingMetadata
				})
			});
			return;
		}

		// GET /api/v1/recordings (with optional ?query)
		if (path === "/api/v1/recordings" && method === "GET") {
			const search = url.searchParams.get("search")?.toLowerCase();
			const status = url.searchParams.get("status");
			const channelId = url.searchParams.get("channelId");
			const seriesRuleId = url.searchParams.get("seriesRuleId");
			const limit = Number(url.searchParams.get("limit") ?? "50");
			const requestedOffset = Number(url.searchParams.get("offset") ?? "0");
			const cursor = url.searchParams.get("cursor");
			const cursorOffset = cursor?.startsWith("mock:")
				? Number(cursor.slice("mock:".length))
				: null;
			const offset = cursorOffset ?? requestedOffset;
			const filtered = state.recordings
				.filter(
					(recording) =>
						(!search || recording.title.toLowerCase().includes(search)) &&
						(!status || recording.status === status) &&
						(!channelId || recording.channelId === channelId) &&
						(!seriesRuleId || recording.seriesRuleId === seriesRuleId)
				)
				.sort((left, right) => {
					const time =
						Date.parse(right.scheduledStart) - Date.parse(left.scheduledStart);
					return time !== 0 ? time : left.id.localeCompare(right.id);
				});
			const items = filtered.slice(offset, offset + limit);
			const nextOffset = offset + items.length;
			const representedSeries = new Set(
				items.flatMap((recording) =>
					recording.seriesRuleId ? [recording.seriesRuleId] : []
				)
			);
			const seriesGroups = [...representedSeries].map((id) => {
				const members = filtered.filter(
					(recording) => recording.seriesRuleId === id
				);
				return {
					seriesRuleId: id,
					title: members[0]?.title ?? "Series",
					recordingCount: members.length,
					totalSize: members.reduce(
						(total, recording) => total + (recording.fileSize ?? 0),
						0
					)
				};
			});
			const oneOffs = filtered.filter(
				(recording) => recording.seriesRuleId === null
			);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					items: items.map((recording) => ({
						...recording,
						metadata: recordingMetadata
					})),
					total: filtered.length,
					totalSize: filtered.reduce(
						(total, recording) => total + (recording.fileSize ?? 0),
						0
					),
					limit,
					offset,
					nextCursor:
						nextOffset < filtered.length ? `mock:${nextOffset}` : null,
					seriesGroups,
					oneOffGroup: items.some(
						(recording) => recording.seriesRuleId === null
					)
						? {
								recordingCount: oneOffs.length,
								totalSize: oneOffs.reduce(
									(total, recording) => total + (recording.fileSize ?? 0),
									0
								)
							}
						: null
				})
			});
			return;
		}

		if (path.endsWith("/stream.m3u8")) {
			state.manifestRequests += 1;
			// Capture absolute DVR offsets so resume behavior is verified at the
			// HTTP boundary instead of through the relative media timeline.
			const requestedStart = url.searchParams.get("start");
			state.manifestStartRequests.push(
				requestedStart === null ? null : Number(requestedStart)
			);
			const viewerId = url.searchParams.get("viewerId");
			state.manifestViewerRequests.push(viewerId);
			const viewerQuery = viewerId
				? `&viewerId=${encodeURIComponent(viewerId)}`
				: "";
			await route.fulfill({
				status: 200,
				contentType: "application/vnd.apple.mpegurl",
				headers: { "Cache-Control": "no-store" },
				body: [
					"#EXTM3U",
					"#EXT-X-VERSION:3",
					"#EXT-X-TARGETDURATION:6",
					"#EXT-X-MEDIA-SEQUENCE:0",
					"#EXTINF:6.0,",
					`segments/seg-00000.ts?session=${PLAYBACK_SESSION_ID}${viewerQuery}`,
					"#EXT-X-ENDLIST",
					""
				].join("\n")
			});
			return;
		}

		if (path.endsWith("/segments/seg-00000.ts")) {
			state.segmentRequests += 1;
			state.segmentViewerRequests.push(url.searchParams.get("viewerId"));
			await route.fulfill({
				status: 200,
				contentType: "video/mp2t",
				headers: { "Cache-Control": "private, max-age=300, immutable" },
				body: Buffer.from("contract-faithful non-empty HLS segment")
			});
			return;
		}

		await route.fallback();
	});

	return state;
}

test.describe("Recordings library + playback (U8)", () => {
	test("library page renders the completed recording", async ({ page }) => {
		await mockBackend(page);
		await page.goto("/recordings");

		await expect(
			page.locator("#main-content").getByTestId("recordings-page")
		).toBeVisible();
		await expect(
			page.getByTestId(`recording-card-${RECORDING_ID}`)
		).toBeVisible();
		await expect(page.getByText("Sherlock S01E01")).toBeVisible();
	});

	test("load more reaches a recording beyond the first page", async ({
		page
	}) => {
		const state = await mockBackend(page);
		state.recordings = Array.from({ length: 25 }, (_, index) =>
			buildRecording({
				id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				title: index === 0 ? "Beyond the first page" : `Episode ${index + 1}`,
				scheduledStart: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
				scheduledEnd: new Date(Date.UTC(2025, 0, index + 1, 1)).toISOString()
			})
		);
		await page.goto("/recordings");

		await expect(page.getByText("Beyond the first page")).toHaveCount(0);
		await expect(
			page.getByTestId("recordings-pagination-summary")
		).toContainText("25 total");

		// Wait for the cursor request so slower CI runners do not race the render.
		const secondPageResponse = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return (
				response.request().method() === "GET" &&
				url.pathname === "/api/v1/recordings" &&
				url.searchParams.get("cursor")?.startsWith("mock:") === true &&
				response.ok()
			);
		});
		await page.getByTestId("recordings-load-more").click();
		await secondPageResponse;

		await expect(page).toHaveURL(/pages=2/);
		await expect(page.getByText("Beyond the first page")).toBeVisible();
	});

	test("filter and sort controls fit the mobile viewport", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockBackend(page);
		await page.goto("/recordings");
		await expect(page.getByTestId("recordings-page")).toBeVisible();

		// Prevent clipped controls from forcing page-level horizontal scrolling.
		const widths = await page.evaluate(() => ({
			client: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		}));
		expect(widths.scroll).toBe(widths.client);
	});

	test("delete with confirmation removes the recording", async ({ page }) => {
		await mockBackend(page);
		await page.goto("/recordings");

		await page.getByTestId(`recording-delete-${RECORDING_ID}`).click();
		await expect(page.getByTestId("recordings-delete-confirm")).toBeVisible();
		await page.getByTestId("recordings-delete-confirm-button").click();

		await expect(
			page.getByTestId(`recording-card-${RECORDING_ID}`)
		).toHaveCount(0);
		await expect(page.getByTestId("recordings-empty")).toBeVisible();
	});

	test("protects a recording, updates watched state, and persists rich details", async ({
		page
	}) => {
		const state = await mockBackend(page);
		await page.goto("/recordings");

		await expect(
			page.getByTestId(`recording-episode-${RECORDING_ID}`)
		).toContainText("S01E01");
		await page.getByLabel("Protect recording").click();
		await expect(page.getByText("Protected")).toBeVisible();
		await expect.poll(() => state.recordings[0]?.manuallyProtected).toBe(true);

		await page.getByLabel("Mark recording watched").click();
		await expect(page.getByText("Watched")).toBeVisible();
		await expect.poll(() => state.recordings[0]?.watchedAt !== null).toBe(true);

		await page.reload();
		await expect(page.getByText("Protected")).toBeVisible();
		await expect(page.getByText("Watched")).toBeVisible();

		await page.getByTestId(`recording-play-${RECORDING_ID}`).click();
		await expect(page.getByTestId("recording-episode")).toContainText(
			"S01E01 · A Study in Pink"
		);
		await expect(page.getByTestId("recording-metadata")).toContainText(
			"1.1 Mystery TV"
		);
		await expect(page.getByTestId("recording-description")).toContainText(
			"Sherlock and John meet for the first time."
		);
	});

	test("completed recording plays, seeks, persists progress, and resumes after reload", async ({
		page
	}) => {
		const state = await mockBackend(page);

		// Start with the recording in the "scheduled" state, simulating a
		// freshly-scheduled job that hasn't aired yet.
		state.recordings = [
			buildRecording({
				status: "scheduled",
				actualStart: null,
				actualEnd: null,
				fileSize: null
			})
		];

		await page.goto("/recordings");
		await expect(
			page.getByTestId(`recording-card-${RECORDING_ID}`)
		).toBeVisible();

		// Now simulate the recording completing — flip the row in the
		// mock backend and reload so the listing endpoint serves the new
		// status.
		state.recordings = [buildRecording({ status: "completed" })];
		await page.reload();
		await expect(
			page.getByTestId(`recording-card-${RECORDING_ID}`)
		).toBeVisible();

		// Click play → navigate to the playback page.
		await page.getByTestId(`recording-play-${RECORDING_ID}`).click();
		await expect(page.getByTestId("recording-player-page")).toBeVisible();
		await expect(page.getByTestId("recording-title")).toHaveText(
			"Sherlock S01E01"
		);
		await expect.poll(() => state.manifestRequests).toBeGreaterThan(0);
		const initialViewerId = state.manifestViewerRequests.find(
			(viewerId): viewerId is string => viewerId !== null
		);
		expect(initialViewerId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);

		// Drive media events after the contract-faithful HLS request so the
		// rendered player enters its playing state and persists a seek.
		await page.evaluate(() => {
			const v = document.querySelector(
				'[data-testid="player-video"]'
			) as HTMLVideoElement | null;
			if (!v) return;
			Object.defineProperty(v, "duration", {
				configurable: true,
				get: () => 3000
			});
			let cur = 0;
			Object.defineProperty(v, "currentTime", {
				configurable: true,
				get: () => cur,
				set: (n: number) => {
					cur = n;
				}
			});
			v.dispatchEvent(new Event("loadedmetadata"));
			v.dispatchEvent(new Event("play"));
			v.dispatchEvent(new Event("playing"));
			cur = 612;
			v.dispatchEvent(new Event("timeupdate"));
		});
		// Segment activity and the persisted seek below verify playback without
		// depending on the controls overlay's intentionally transient visibility.
		await expect.poll(() => state.segmentRequests).toBeGreaterThan(0);
		// Preflight, manifest, and segment requests share one page-owned viewer.
		expect(
			new Set(
				[
					...state.manifestViewerRequests,
					...state.segmentViewerRequests
				].filter((viewerId): viewerId is string => viewerId !== null)
			)
		).toEqual(new Set([initialViewerId]));

		// Wait for the PATCH to land.
		await expect
			.poll(() =>
				state.patches.find(
					(p) => p["id"] === RECORDING_ID && p["resumePositionSeconds"] === 612
				)
					? true
					: false
			)
			.toBe(true);

		// Sanity: the recording's persisted state now reflects the resume.
		expect(state.recordings[0]?.resumePositionSeconds).toBe(612);

		// Client-side navigation must release this viewer before a later visit
		// creates a fresh owner at the persisted absolute resume position.
		await page.getByRole("button", { name: "Back to library" }).click();
		await expect
			.poll(() => state.releaseViewerRequests.includes(initialViewerId ?? ""))
			.toBe(true);
		await page.getByTestId(`recording-play-${RECORDING_ID}`).click();
		await expect(page.getByTestId("recording-player-page")).toBeVisible();
		await expect
			.poll(
				() =>
					state.manifestStartRequests[state.manifestStartRequests.length - 1]
			)
			.toBe(612);
		const resumedAt = await page.evaluate(() => {
			const video = document.querySelector(
				'[data-testid="player-video"]'
			) as HTMLVideoElement | null;
			if (!video) return -1;
			Object.defineProperty(video, "duration", {
				configurable: true,
				get: () => 3000
			});
			let currentTime = 612;
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => currentTime,
				set: (value: number) => {
					currentTime = value;
				}
			});
			// Model browser HLS reporting the absolute VOD start position.
			video.dispatchEvent(new Event("loadedmetadata"));
			video.dispatchEvent(new Event("timeupdate"));
			return video.currentTime;
		});
		// The media element and controls now share one absolute recording timeline.
		expect(resumedAt).toBe(612);
		await expect(page.getByTestId("player-time")).toHaveText("10:12 / 50:00");
	});
});
