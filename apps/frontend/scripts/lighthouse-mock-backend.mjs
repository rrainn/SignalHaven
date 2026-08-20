#!/usr/bin/env node
/**
 * Tiny stand-in backend used by the `lighthouse` CI job.
 *
 * Lighthouse measures the four primary screens (`/guide`, `/recordings`,
 * `/settings`, `/watch/[id]`) against a Mobile Perf ≥ 90 budget. Without
 * a backend, every API call from those client-rendered pages fails and
 * the pages stay in a spinner — which murders LCP and the perf score.
 *
 * This mock answers the handful of `/api/v1/*` endpoints those pages hit on
 * first paint, with the smallest fixtures that satisfy the production
 * contracts. Watch also starts playback and sends best-effort lifecycle POSTs
 * without interaction, so those requests receive non-error responses too.
 *
 * Zero external deps — uses Node's built-in `http`/`url` modules so the CI
 * job can `node` it directly without an extra package-install round-trip.
 */
import { createServer } from "node:http";
import { URL } from "node:url";

import { buildEpgGrid } from "./lighthouse-guide-fixture.mjs";

const PORT = Number(process.env.PORT ?? "43200");
const HOST = "127.0.0.1";

// Stable channel id used by `apps/frontend/e2e/perf.spec.ts` and the
// Lighthouse `/watch/[id]` URL — the watch page renders a "channel not
// found" empty state when the id isn't in the channel list, so we must
// include it in our fixture.
const PRIMARY_CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000000";
const SECONDARY_CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const TUNER_ID = "11111111-1111-4111-8111-111111111111";

// An empty live media playlist keeps hls.js in its loading state without
// inventing segment media or surfacing a fatal HTTP error during the audit.
const LOADING_LIVE_MANIFEST = [
	"#EXTM3U",
	"#EXT-X-VERSION:3",
	"#EXT-X-TARGETDURATION:6",
	"#EXT-X-MEDIA-SEQUENCE:0",
	""
].join("\n");

// Authenticate Lighthouse so it measures product screens instead of the fail-closed gate.
const authenticatedUser = {
	id: "22222222-2222-4222-8222-222222222222",
	username: "lighthouse-admin",
	role: "admin"
};

const preferences = {
	ui: {
		theme: "system",
		epgHoursVisible: 4,
		use24HourClock: false,
		density: "comfortable",
		animations: true
	},
	channels: { favorites: [], hidden: [], order: [] },
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {}
	}
};

const channels = [
	{
		id: PRIMARY_CHANNEL_ID,
		number: "100",
		name: "SignalHaven Demo 1",
		logoUrl: null,
		tvgId: null,
		tunerId: TUNER_ID,
		tunerName: "Demo tuner",
		tunerKind: "hdhomerun",
		enabled: true,
		sortOrder: 100,
		hasMapping: true
	},
	{
		id: SECONDARY_CHANNEL_ID,
		number: "101",
		name: "SignalHaven Demo 2",
		logoUrl: null,
		tvgId: null,
		tunerId: TUNER_ID,
		tunerName: "Demo tuner",
		tunerKind: "hdhomerun",
		enabled: true,
		sortOrder: 101,
		hasMapping: true
	}
];

const settings = {
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
	recordings: { paddingBeforeSec: 0, paddingAfterSec: 0 },
	observability: { debugBundleEnabled: false }
};

const tuners = [
	{
		id: TUNER_ID,
		name: "Demo tuner",
		kind: "hdhomerun",
		config: {
			type: "hdhomerun",
			deviceId: "demo-device",
			host: "192.168.1.10"
		},
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString()
	}
];

const epgSources = [];
const recordings = [];
const seriesRules = [];
const conflicts = [];

function send(res, status, body, contentType = "application/json") {
	const headers = {
		"Content-Type": contentType,
		"Cache-Control": "no-store"
	};
	const buf = typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(status, headers);
	res.end(buf);
}

/** Match unload beacons for one of the channels exposed by this fixture. */
function isViewerReleasePath(path) {
	const match = /^\/api\/v1\/stream\/([^/]+)\/viewers\/([^/]+)\/release$/.exec(
		path
	);
	return Boolean(
		match?.[2] && channels.some((channel) => channel.id === match[1])
	);
}

/** Send the same empty success response as the production lifecycle routes. */
function sendNoContent(res) {
	res.writeHead(204, { "Cache-Control": "no-store" });
	res.end();
}

const server = createServer((req, res) => {
	if (!req.url) {
		send(res, 400, { error: { message: "Bad request" } });
		return;
	}
	const url = new URL(req.url, `http://${HOST}:${PORT}`);
	const path = url.pathname;

	if (
		req.method === "POST" &&
		(path === "/api/v1/playback/telemetry" || isViewerReleasePath(path))
	) {
		// Drain telemetry bodies so keepalive requests can finish cleanly.
		req.resume();
		return sendNoContent(res);
	}
	if (req.method !== "GET") {
		return send(res, 405, { error: { message: "Method not allowed" } });
	}
	if (
		channels.some(
			(channel) => path === `/api/v1/stream/${channel.id}/master.m3u8`
		)
	) {
		return send(
			res,
			200,
			LOADING_LIVE_MANIFEST,
			"application/vnd.apple.mpegurl; charset=utf-8"
		);
	}

	switch (path) {
		case "/api/v1/health":
			return send(res, 200, { status: "ok", uptimeSeconds: 0 });
		case "/api/v1/auth/status":
			return send(res, 200, {
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: authenticatedUser
			});
		case "/api/v1/preferences":
			return send(res, 200, preferences);
		case "/api/v1/system/status":
			return send(res, 200, {
				firstRun: false,
				hasTuners: true,
				hasEpg: true,
				hasStorage: true
			});
		case "/api/v1/settings":
			return send(res, 200, settings);
		case "/api/v1/channels":
			return send(res, 200, { items: channels });
		case "/api/v1/tuners":
			return send(res, 200, { items: tuners });
		case "/api/v1/epg/sources":
			return send(res, 200, { items: epgSources });
		case "/api/v1/epg/grid": {
			const from = url.searchParams.get("from") ?? new Date().toISOString();
			const to =
				url.searchParams.get("to") ??
				new Date(Date.now() + 6 * 60 * 60_000).toISOString();
			return send(res, 200, buildEpgGrid(from, to));
		}
		case "/api/v1/recordings":
			return send(res, 200, {
				items: recordings,
				total: 0,
				limit: 50,
				offset: 0
			});
		case "/api/v1/recordings/conflicts":
			return send(res, 200, { items: conflicts });
		case "/api/v1/series-rules":
			return send(res, 200, { items: seriesRules });
		default:
			// Anything we haven't taught the mock — 404 so the client treats
			// it as a missing resource rather than a network error (which
			// would surface as a Best-Practices warning in Lighthouse).
			return send(res, 404, { error: { message: "Not found" } });
	}
});

server.listen(PORT, HOST, () => {
	// eslint-disable-next-line no-console
	console.log(`[lighthouse-mock-backend] listening on http://${HOST}:${PORT}`);
});
