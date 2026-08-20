import {
	expect,
	test,
	type Page,
	type Route,
	type WebSocketRoute
} from "./fixtures";

/**
 * Cross-page DVR action regression coverage for GitHub issue 85.
 *
 * Each page gets an independent mocked WebSocket connection backed by one
 * shared in-memory recording. This models the production contract closely
 * enough to prove that Watch mutations update Guide and Recordings without a
 * reload.
 */

const CHANNEL_ID = "00000000-0000-4000-8000-000000000085";
const PROGRAM_ID = "11111111-1111-4111-8111-111111111085";
const RECORDING_ID = "22222222-2222-4222-8222-222222222085";
const PROGRAM_TITLE = "Issue 85 Live News";

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

type MockRecordingStatus = "scheduled" | "cancelled";

interface MockRecording {
	id: string;
	channelId: string;
	programId: string;
	title: string;
	status: MockRecordingStatus;
	scheduledStart: string;
	scheduledEnd: string;
	actualStart: null;
	actualEnd: null;
	filePath: null;
	fileSize: null;
	durationSeconds: null;
	errorMessage: null;
	seriesRuleId: null;
	manuallyProtected: false;
	watchedAt: null;
	resumePositionSeconds: null;
}

interface DvrSyncState {
	start: string;
	stop: string;
	recording: MockRecording | null;
	sockets: Map<WebSocketRoute, Set<string>>;
}

function createDvrSyncState(): DvrSyncState {
	const now = Date.now();
	return {
		start: new Date(now - 30 * 60_000).toISOString(),
		stop: new Date(now + 30 * 60_000).toISOString(),
		recording: null,
		sockets: new Map<WebSocketRoute, Set<string>>()
	};
}

function buildRecording(
	state: DvrSyncState,
	status: MockRecordingStatus
): MockRecording {
	return {
		id: RECORDING_ID,
		channelId: CHANNEL_ID,
		programId: PROGRAM_ID,
		title: PROGRAM_TITLE,
		status,
		scheduledStart: state.start,
		scheduledEnd: state.stop,
		actualStart: null,
		actualEnd: null,
		filePath: null,
		fileSize: null,
		durationSeconds: null,
		errorMessage: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null
	};
}

function buildGrid(state: DvrSyncState) {
	return {
		from: state.start,
		to: new Date(Date.parse(state.stop) + 5 * 60 * 60_000).toISOString(),
		channels: [
			{
				id: CHANNEL_ID,
				number: "8.5",
				name: "Issue 85 News",
				logoUrl: null,
				hasMapping: true
			}
		],
		programs: [
			{
				id: PROGRAM_ID,
				channelId: CHANNEL_ID,
				start: state.start,
				stop: state.stop,
				title: PROGRAM_TITLE,
				subtitle: "Shared lifecycle contract",
				description: "Verifies synchronized DVR actions across live pages.",
				categories: ["News"],
				recordingId: state.recording?.id ?? null,
				recordingStatus: state.recording?.status ?? null
			}
		]
	};
}

function broadcastRecording(
	state: DvrSyncState,
	event: "recording.scheduled" | "recording.cancelled"
): void {
	if (!state.recording) return;
	const message = JSON.stringify({
		type: "event",
		topic: "recordings",
		event,
		data: state.recording,
		ts: new Date().toISOString()
	});
	for (const [socket, topics] of state.sockets) {
		// Settings now has its own app-boundary subscription; DVR events should
		// only be delivered to consumers that requested recording updates.
		if (topics.has("recordings")) socket.send(message);
	}
}

/** Counts behavior-relevant subscribers without coupling to other app topics. */
function recordingSubscriberCount(state: DvrSyncState): number {
	return [...state.sockets.values()].filter((topics) =>
		topics.has("recordings")
	).length;
}

/** Registers the REST and WebSocket surface used by one browser page. */
async function mockDvrBackend(page: Page, state: DvrSyncState): Promise<void> {
	await page.routeWebSocket("**/api/v1/events", (socket) => {
		state.sockets.set(socket, new Set());
		socket.onMessage((message) => {
			try {
				const request = JSON.parse(String(message)) as {
					type?: string;
					topics?: string[];
				};
				if (request.type === "subscribe") {
					state.sockets.set(socket, new Set(request.topics ?? []));
					socket.send(
						JSON.stringify({
							type: "ack",
							action: "subscribe",
							topics: request.topics ?? []
						})
					);
				}
			} catch {
				// Non-JSON frames are irrelevant to this contract test.
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
						number: "8.5",
						name: "Issue 85 News",
						logoUrl: null,
						tvgId: "issue-85",
						tunerId: "33333333-3333-4333-8333-333333333085",
						tunerName: "Issue 85 Tuner",
						tunerKind: "hdhomerun",
						enabled: true,
						sortOrder: 1,
						hasMapping: true
					}
				]
			})
		})
	);
	await page.route("**/api/v1/epg/grid**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(buildGrid(state))
		})
	);
	await page.route("**/api/v1/stream/**", (route) =>
		route.fulfill({ status: 404, body: "" })
	);

	await page.route("**/api/v1/recordings**", async (route: Route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;

		if (request.method() === "GET" && pathname === "/api/v1/recordings") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					items: state.recording ? [state.recording] : [],
					total: state.recording ? 1 : 0,
					limit: 50,
					offset: 0
				})
			});
			return;
		}

		if (
			request.method() === "POST" &&
			pathname === "/api/v1/recordings/by-program"
		) {
			state.recording = buildRecording(state, "scheduled");
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({ recording: state.recording, created: true })
			});
			broadcastRecording(state, "recording.scheduled");
			return;
		}

		if (
			request.method() === "POST" &&
			pathname === `/api/v1/recordings/${RECORDING_ID}/cancel`
		) {
			state.recording = buildRecording(state, "cancelled");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(state.recording)
			});
			broadcastRecording(state, "recording.cancelled");
			return;
		}

		await route.fallback();
	});
}

test("Watch schedule and cancel actions synchronize Guide and Recordings", async ({
	context,
	page: watchPage
}) => {
	const state = createDvrSyncState();
	const guidePage = await context.newPage();
	const recordingsPage = await context.newPage();
	await Promise.all(
		[watchPage, guidePage, recordingsPage].map((page) =>
			mockDvrBackend(page, state)
		)
	);

	await Promise.all([
		watchPage.goto(`/watch/${CHANNEL_ID}`),
		guidePage.goto("/guide"),
		recordingsPage.goto("/recordings")
	]);

	const watchAction = watchPage
		.getByTestId("watch-desktop")
		.getByTestId("watch-record");
	const guideProgram = guidePage.locator(`[data-program-id="${PROGRAM_ID}"]`);
	const recordingCard = recordingsPage.getByTestId(
		`recording-card-${RECORDING_ID}`
	);

	await expect(watchAction).toHaveText(/Record this program/);
	await expect(guideProgram).toBeVisible();
	await expect(recordingsPage.getByTestId("recordings-empty")).toBeVisible();
	await expect.poll(() => recordingSubscriberCount(state)).toBe(3);

	await watchAction.click();

	await expect(watchAction).toHaveText(/Cancel recording/);
	await expect(guideProgram.getByLabel("Scheduled to record")).toBeVisible();
	await expect(recordingCard).toContainText(PROGRAM_TITLE);
	await expect(recordingCard).toContainText(/scheduled/i);

	await watchAction.click();

	await expect(watchAction).toHaveText(/Record this program/);
	await expect(guideProgram.getByLabel("Recording cancelled")).toBeVisible();
	await expect(recordingCard).toContainText(/cancelled/i);
});
