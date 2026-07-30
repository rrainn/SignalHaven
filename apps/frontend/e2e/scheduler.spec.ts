import {
	test,
	expect,
	type Page,
	type Route,
	type WebSocketRoute
} from "@playwright/test";

/**
 * E2E for the U9 scheduler page.
 *
 * The whole backend is mocked: we maintain in-memory lists of
 * recordings, series rules, and conflicts; serve the listing /
 * mutation endpoints from Playwright's route handler; and stub the
 * `/api/v1/events` WebSocket so the test can push a synthetic
 * `recording.conflict` event to drive the conflict-resolution flow
 * called out in the U9 acceptance criteria.
 */

const CHANNEL_ID = "00000000-0000-4000-8000-000000000aaa";
const RULE_ID = "11111111-1111-4111-8111-111111111111";
const CONFLICT_ID = "22222222-2222-4222-8222-222222222222";

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

interface MockSeriesRule {
	id: string;
	title: string;
	channelId: string | null;
	epgChannelId: null;
	keepCount: number;
	newOnly: boolean;
	episodePolicy: "all" | "confirmed_new" | "new_and_unknown";
	priority: number;
	retentionDays: number | null;
	createdAt: string;
	updatedAt: string;
}

interface SchedulerMockState {
	rules: MockSeriesRule[];
	settings: typeof baseSettings;
	/** All sockets that subscribed to recording events during route hydration. */
	recordingSockets: Set<WebSocketRoute>;
	/** Resolves once at least one recordings subscription is active. */
	recordingSubscribed: Promise<void>;
}

async function mockSchedulerBackend(page: Page): Promise<SchedulerMockState> {
	const state: SchedulerMockState = {
		rules: [],
		settings: {
			...baseSettings,
			storage: { ...baseSettings.storage },
			recordings: { ...baseSettings.recordings }
		},
		recordingSockets: new Set<WebSocketRoute>(),
		recordingSubscribed: undefined as unknown as Promise<void>
	};

	// Next hydration can briefly replace a route consumer. Track every matching
	// subscriber so the mock bus delivers events to the stable instance too.
	let resolveRecordingSubscription!: () => void;
	state.recordingSubscribed = new Promise<void>((resolve) => {
		resolveRecordingSubscription = resolve;
	});
	await page.routeWebSocket("**/api/v1/events", (ws) => {
		ws.onMessage((msg) => {
			// The page sends a single `subscribe` message on open. We don't
			// need to model the ack precisely — the page treats anything
			// that doesn't parse as `event` as a no-op.
			try {
				const parsed = JSON.parse(String(msg));
				if (parsed?.type === "subscribe") {
					const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
					ws.send(
						JSON.stringify({
							type: "ack",
							action: "subscribe",
							topics
						})
					);
					if (topics.includes("recordings")) {
						state.recordingSockets.add(ws);
						resolveRecordingSubscription();
					}
				}
			} catch {
				/* ignore — not JSON */
			}
		});
	});

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
			const body = route.request().postDataJSON() as Partial<
				typeof baseSettings
			>;
			state.settings = {
				...state.settings,
				...body,
				storage: {
					...state.settings.storage,
					...(body.storage ?? {})
				},
				recordings: {
					...state.settings.recordings,
					...(body.recordings ?? {})
				}
			};
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(state.settings)
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

	// Recordings list (always empty for this scenario).
	await page.route("**/api/v1/recordings**", (route: Route) => {
		if (route.request().method() === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 })
			});
		}
		return route.fallback();
	});

	// Recording conflicts polling endpoint — initially empty; the WS
	// event drives the visible state.
	await page.route("**/api/v1/recordings/conflicts", (route: Route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] })
		})
	);

	// Series rules CRUD.
	await page.route("**/api/v1/series-rules**", async (route: Route) => {
		const url = new URL(route.request().url());
		const method = route.request().method();

		if (url.pathname === "/api/v1/series-rules" && method === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ items: state.rules })
			});
			return;
		}

		if (url.pathname === "/api/v1/series-rules" && method === "POST") {
			const body = route.request().postDataJSON() as {
				title: string;
				channelId?: string | null;
				keepCount: number;
				retentionDays?: number | null;
				episodePolicy?: "all" | "confirmed_new" | "new_and_unknown";
				newOnly?: boolean;
				priority: number;
			};
			const created: MockSeriesRule = {
				id: RULE_ID,
				title: body.title,
				channelId: body.channelId ?? null,
				epgChannelId: null,
				keepCount: body.keepCount,
				newOnly:
					(body.episodePolicy ?? (body.newOnly ? "confirmed_new" : "all")) !==
					"all",
				episodePolicy:
					body.episodePolicy ?? (body.newOnly ? "confirmed_new" : "all"),
				priority: body.priority,
				retentionDays: body.retentionDays ?? null,
				createdAt: "2025-01-01T00:00:00Z",
				updatedAt: "2025-01-01T00:00:00Z"
			};
			state.rules.push(created);
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify(created)
			});
			return;
		}

		if (method === "PATCH") {
			const pathSegments = url.pathname.split("/");
			const id = pathSegments[pathSegments.length - 1];
			const existing = state.rules.find((rule) => rule.id === id);
			if (!existing) {
				await route.fulfill({ status: 404 });
				return;
			}
			const body = route.request().postDataJSON() as Partial<MockSeriesRule>;
			Object.assign(existing, body, {
				updatedAt: "2025-01-02T00:00:00Z"
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(existing)
			});
			return;
		}

		await route.fallback();
	});

	return state;
}

test.describe("Scheduler and DVR settings", () => {
	test("persists DVR padding and edits series retention", async ({ page }) => {
		const state = await mockSchedulerBackend(page);

		// Save both padding values and prove the backend-backed values survive reload.
		await page.goto("/settings");
		await page.getByRole("tab", { name: "Storage" }).click();
		await page.getByLabel(/pre-record padding/i).fill("15");
		await page.getByLabel(/post-record padding/i).fill("45");
		await page.getByRole("button", { name: /^save$/i }).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");
		expect(state.settings.recordings).toEqual({
			paddingBeforeSec: 15,
			paddingAfterSec: 45
		});

		await page.reload();
		await page.getByRole("tab", { name: "Storage" }).click();
		await expect(page.getByLabel(/pre-record padding/i)).toHaveValue("15");
		await expect(page.getByLabel(/post-record padding/i)).toHaveValue("45");

		await page.goto("/scheduler");
		await expect(page.getByTestId("scheduler-page")).toBeVisible();

		// ── Create a series rule ──────────────────────────────────────────
		await page.getByTestId("scheduler-tab-series").click();
		await expect(page.getByTestId("scheduler-series-empty")).toBeVisible();

		await page.getByTestId("scheduler-new-rule").click();
		await expect(page.getByTestId("scheduler-editor-modal")).toBeVisible();
		await page.getByTestId("series-rule-title").fill("Sherlock");
		const keep = page.getByTestId("series-rule-keep-count");
		await keep.fill("");
		await keep.fill("3");
		await page.getByTestId("series-rule-submit").click();

		await expect(page.getByTestId(`scheduler-series-${RULE_ID}`)).toBeVisible();
		await expect(state.rules).toHaveLength(1);
		expect(state.rules[0]?.title).toBe("Sherlock");
		expect(state.rules[0]?.keepCount).toBe(3);

		// Edit the created rule so retention is proven through the PATCH path.
		await page.getByTestId(`scheduler-series-edit-${RULE_ID}`).click();
		await page.getByTestId("series-rule-retention-days").fill("30");
		await page.getByTestId("series-rule-submit").click();
		await expect(page.getByTestId(`scheduler-series-${RULE_ID}`)).toContainText(
			"Delete after 30 days"
		);
		expect(state.rules[0]?.retentionDays).toBe(30);
	});

	test("creates a series rule, then resolves a conflict pushed via WS", async ({
		page
	}) => {
		const state = await mockSchedulerBackend(page);

		await page.goto("/scheduler");
		await expect(page.getByTestId("scheduler-page")).toBeVisible();
		await page.getByTestId("scheduler-tab-series").click();
		await expect(page.getByTestId("scheduler-series-empty")).toBeVisible();

		await page.getByTestId("scheduler-new-rule").click();
		await page.getByTestId("series-rule-title").fill("Sherlock");
		await page.getByTestId("series-rule-keep-count").fill("3");
		await page.getByTestId("series-rule-submit").click();
		await expect(page.getByTestId(`scheduler-series-${RULE_ID}`)).toBeVisible();

		// ── Push a conflict over the (mocked) WS event bus ────────────────
		await state.recordingSubscribed;
		const conflictMessage = JSON.stringify({
			type: "event",
			topic: "recordings",
			event: "recording.conflict",
			ts: "2025-01-01T00:00:00Z",
			data: {
				id: CONFLICT_ID,
				seriesRuleId: RULE_ID,
				programId: null,
				channelId: CHANNEL_ID,
				title: "Sherlock S02E01",
				scheduledStart: "2025-03-10T20:00:00Z",
				scheduledEnd: "2025-03-10T21:00:00Z",
				reason: "tuner_capacity",
				message: "Tuner capacity exceeded by 1 at 20:00",
				conflictsWith: [],
				detectedAt: "2025-03-09T00:00:00Z"
			}
		});
		for (const socket of state.recordingSockets) {
			await socket.send(conflictMessage);
		}

		// ── Conflict appears + is resolved via "Accept" ──────────────────
		await page.getByTestId("scheduler-tab-conflicts").click();
		await expect(page.getByTestId("scheduler-conflicts-count")).toHaveText("1");
		await expect(
			page.getByTestId(`scheduler-conflict-${CONFLICT_ID}`)
		).toBeVisible();
		await expect(
			page.getByTestId(`scheduler-conflict-message-${CONFLICT_ID}`)
		).toContainText("Tuner capacity exceeded");

		await page.getByTestId(`scheduler-conflict-accept-${CONFLICT_ID}`).click();
		await expect(
			page.getByTestId(`scheduler-conflict-${CONFLICT_ID}`)
		).toHaveCount(0);
		await expect(page.getByTestId("scheduler-conflicts-empty")).toBeVisible();
	});
});
