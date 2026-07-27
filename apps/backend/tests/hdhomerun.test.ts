import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Tuner } from "@signalhaven/shared";

import {
	createHdhomerunFactory,
	HdhomerunHttpError,
	HdhomerunProvider,
	type FetchLike,
	type HdhomerunClock
} from "../src/tuners/providers/hdhomerun";

interface MockResponse {
	ok?: boolean;
	status?: number;
	statusText?: string;
	body?: unknown;
	text?: string;
	/** When set, this attempt rejects with the given error instead of resolving. */
	throws?: Error;
}

interface RecordedCall {
	url: string;
	attempt: number;
}

function jsonResponse(body: unknown): MockResponse {
	return { body };
}

function htmlResponse(text: string): MockResponse {
	return { text };
}

function errorResponse(error: Error): MockResponse {
	return { throws: error };
}

function statusResponse(status: number): MockResponse {
	return { status, ok: false };
}

/**
 * Build a `fetch` stub that returns successive responses for the same URL.
 * Each URL gets its own queue so retry tests can simulate a transient
 * failure followed by a success without affecting unrelated endpoints.
 */
function mockFetch(responses: Record<string, MockResponse[]>): {
	fetch: FetchLike;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const counts = new Map<string, number>();
	const fetch: FetchLike = async (url) => {
		const queue = responses[url];
		const attempt = (counts.get(url) ?? 0) + 1;
		counts.set(url, attempt);
		calls.push({ url, attempt });
		if (!queue || queue.length === 0) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		const next = queue.length === 1 ? queue[0] : queue.shift();
		if (!next) {
			throw new Error(`No response queued for ${url}`);
		}
		if (next.throws) {
			throw next.throws;
		}
		const status = next.status ?? 200;
		const ok = next.ok ?? (status >= 200 && status < 300);
		return {
			ok,
			status,
			statusText: next.statusText ?? "OK",
			async json() {
				return next.body;
			},
			async text() {
				if (typeof next.text === "string") {
					return next.text;
				}
				return JSON.stringify(next.body ?? "");
			}
		};
	};
	return { fetch, calls };
}

/** Simple immediate clock: timeouts fire immediately so retries don't sleep. */
function instantClock(): HdhomerunClock {
	return {
		now: () => 0,
		setTimeout: (handler: () => void) => {
			// Fire on the microtask queue so callers can still cancel the timer
			// synchronously before it runs.
			let cancelled = false;
			queueMicrotask(() => {
				if (!cancelled) handler();
			});
			return { cancel: () => (cancelled = true) };
		},
		clearTimeout: (handle: unknown) => {
			const h = handle as { cancel?: () => void } | undefined;
			h?.cancel?.();
		}
	};
}

/**
 * Clock whose `now()` is controllable. Used for the lineup-cache TTL test.
 * Timers behave like the instant clock so retries (which we don't need here)
 * still fire promptly.
 */
function controllableClock(): HdhomerunClock & { advance(ms: number): void } {
	let nowMs = 0;
	return {
		now: () => nowMs,
		setTimeout: (handler: () => void) => {
			let cancelled = false;
			queueMicrotask(() => {
				if (!cancelled) handler();
			});
			return { cancel: () => (cancelled = true) };
		},
		clearTimeout: (handle: unknown) => {
			const h = handle as { cancel?: () => void } | undefined;
			h?.cancel?.();
		},
		advance(ms: number) {
			nowMs += ms;
		}
	};
}

function makeRow(host = "192.0.2.10"): Tuner {
	return {
		id: randomUUID(),
		kind: "hdhomerun",
		name: "Living Room",
		config: { host },
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString()
	};
}

test("HdhomerunProvider.getStreamUrl always uses port 5004", async () => {
	const provider = new HdhomerunProvider(makeRow("http://10.0.0.5"), {
		fetch: mockFetch({}).fetch,
		clock: instantClock()
	});
	const stream = await provider.getStreamUrl("5.1");
	assert.equal(stream.url, "http://10.0.0.5:5004/auto/v5.1");
});

test("HdhomerunProvider.getStreamUrl appends ?transcode=<preset> when requested", async () => {
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch: mockFetch({}).fetch,
		clock: instantClock()
	});
	const stream = await provider.getStreamUrl("5.1", {
		transcode: true,
		preset: "mobile"
	});
	assert.equal(stream.url, "http://10.0.0.5:5004/auto/v5.1?transcode=mobile");
});

test("HdhomerunProvider.getStreamUrl ignores transcode when no preset is given", async () => {
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch: mockFetch({}).fetch,
		clock: instantClock()
	});
	const stream = await provider.getStreamUrl("7.1", { transcode: true });
	assert.equal(stream.url, "http://10.0.0.5:5004/auto/v7.1");
});

test("HdhomerunProvider.getLineup parses lineup.json and skips DRM channels", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const { fetch } = mockFetch({
		[lineupUrl]: [
			jsonResponse([
				{ GuideNumber: "5.1", GuideName: "FOX" },
				{ GuideNumber: "7.1", GuideName: "ABC" },
				{ GuideNumber: "9.1", GuideName: "Encrypted", DRM: 1 },
				{ GuideNumber: "", GuideName: "junk" }
			])
		]
	});
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock: instantClock()
	});
	const lineup = await provider.getLineup();
	assert.deepEqual(lineup, [
		{ channelId: "5.1", number: "5.1", name: "FOX" },
		{ channelId: "7.1", number: "7.1", name: "ABC" }
	]);
});

test("HdhomerunProvider.getLineup caches results until the TTL expires", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const { fetch, calls } = mockFetch({
		[lineupUrl]: [
			jsonResponse([{ GuideNumber: "5.1", GuideName: "FOX" }]),
			jsonResponse([{ GuideNumber: "7.1", GuideName: "ABC" }])
		]
	});
	const clock = controllableClock();
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock,
		lineupTtlMs: 1_000
	});

	const first = await provider.getLineup();
	const second = await provider.getLineup();
	assert.deepEqual(first, second);
	assert.equal(
		calls.filter((c) => c.url === lineupUrl).length,
		1,
		"second call should be served from cache"
	);

	clock.advance(1_500);
	const third = await provider.getLineup();
	assert.equal(third[0]?.name, "ABC");
	assert.equal(calls.filter((c) => c.url === lineupUrl).length, 2);
});

test("HdhomerunProvider.invalidateLineupCache forces a refresh", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const { fetch, calls } = mockFetch({
		[lineupUrl]: [
			jsonResponse([{ GuideNumber: "5.1", GuideName: "FOX" }]),
			jsonResponse([{ GuideNumber: "7.1", GuideName: "ABC" }])
		]
	});
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock: instantClock()
	});
	await provider.getLineup();
	provider.invalidateLineupCache();
	const refreshed = await provider.getLineup();
	assert.equal(refreshed[0]?.name, "ABC");
	assert.equal(calls.filter((c) => c.url === lineupUrl).length, 2);
});

test("HdhomerunProvider HTTP helper retries transient 5xx up to maxRetries", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const { fetch, calls } = mockFetch({
		[lineupUrl]: [
			statusResponse(503),
			statusResponse(503),
			jsonResponse([{ GuideNumber: "5.1", GuideName: "FOX" }])
		]
	});
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock: instantClock(),
		maxRetries: 3,
		retryBaseDelayMs: 0
	});
	const lineup = await provider.getLineup();
	assert.equal(lineup.length, 1);
	assert.equal(calls.filter((c) => c.url === lineupUrl).length, 3);
});

test("HdhomerunProvider HTTP helper does not retry 4xx errors", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const { fetch, calls } = mockFetch({
		[lineupUrl]: [statusResponse(404)]
	});
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock: instantClock(),
		maxRetries: 3,
		retryBaseDelayMs: 0
	});
	await assert.rejects(
		provider.getLineup(),
		(error) => error instanceof HdhomerunHttpError && error.status === 404
	);
	assert.equal(calls.filter((c) => c.url === lineupUrl).length, 1);
});

test("HdhomerunProvider HTTP helper gives up after maxRetries", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const { fetch, calls } = mockFetch({
		[lineupUrl]: [
			errorResponse(new Error("ECONNRESET")),
			errorResponse(new Error("ECONNRESET")),
			errorResponse(new Error("ECONNRESET")),
			errorResponse(new Error("ECONNRESET"))
		]
	});
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock: instantClock(),
		maxRetries: 3,
		retryBaseDelayMs: 0
	});
	await assert.rejects(provider.getLineup(), /ECONNRESET/);
	// 1 initial attempt + 3 retries = 4 total.
	assert.equal(calls.filter((c) => c.url === lineupUrl).length, 4);
});

test("HdhomerunProvider HTTP helper times out after requestTimeoutMs", async () => {
	const lineupUrl = "http://10.0.0.5/lineup.json";
	const fetch: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	const provider = new HdhomerunProvider(makeRow("10.0.0.5"), {
		fetch,
		clock: instantClock(),
		requestTimeoutMs: 5,
		maxRetries: 0,
		retryBaseDelayMs: 0
	});
	await assert.rejects(provider.getLineup(), /timed out/);
	// We don't have a calls recorder here; the regex assertion above is enough.
	void lineupUrl;
});

test("HdhomerunProvider.getStatus reports online with tuner-in-use detail", async () => {
	const base = "http://10.0.0.5";
	const { fetch } = mockFetch({
		[`${base}/lineup_status.json`]: [
			jsonResponse({
				ScanInProgress: 0,
				ScanPossible: 1,
				Source: "Cable",
				SourceList: ["Cable", "Antenna"]
			})
		],
		[`${base}/discover.json`]: [
			jsonResponse({
				DeviceID: "1234ABCD",
				FriendlyName: "HDHomeRun PRIME",
				ModelNumber: "HDHR3-CC",
				BaseURL: base,
				TunerCount: 2
			})
		],
		[`${base}/tuner0/Status`]: [htmlResponse("Channel: none\nTarget: none")],
		[`${base}/tuner1/Status`]: [
			htmlResponse(
				"Channel: auto:5.1\nLock: qam256\nSignal Strength: 95(80%)\nTarget: rtp://10.0.0.20:1234"
			)
		]
	});
	const provider = new HdhomerunProvider(makeRow(base), {
		fetch,
		clock: instantClock()
	});
	const status = await provider.getStatus();
	assert.equal(status.online, true);
	assert.match(status.message ?? "", /Source: Cable/);
	assert.match(status.message ?? "", /Tuners in use: 1/);
});

test("HdhomerunProvider.getChannelQuality returns metrics for the tuned channel", async () => {
	const base = "http://10.0.0.5";
	const { fetch } = mockFetch({
		[`${base}/discover.json`]: [
			jsonResponse({ DeviceID: "1234ABCD", BaseURL: base, TunerCount: 2 })
		],
		[`${base}/tuner0/Status`]: [htmlResponse("Channel: none\nTarget: none")],
		[`${base}/tuner1/Status`]: [
			htmlResponse(
				"Channel: auto:5.1\nLock: 8vsb\nSignal Strength: 95(80%)\nSignal Quality: 90(90%)\nSymbol Quality: 100(100%)\nNetwork Rate: 19.2 Mbps"
			)
		]
	});
	const provider = new HdhomerunProvider(makeRow(base), {
		fetch,
		clock: instantClock()
	});

	const quality = await provider.getChannelQuality("5.1");

	assert.deepEqual(quality, {
		tunerIndex: 1,
		lock: "8vsb",
		signalStrengthPercent: 80,
		signalQualityPercent: 90,
		symbolQualityPercent: 100,
		networkRateMbps: 19.2
	});
});

test("HdhomerunProvider.getStatus reports offline when the device is unreachable", async () => {
	const base = "http://10.0.0.99";
	const { fetch } = mockFetch({
		[`${base}/lineup_status.json`]: [
			errorResponse(new Error("ECONNREFUSED")),
			errorResponse(new Error("ECONNREFUSED")),
			errorResponse(new Error("ECONNREFUSED")),
			errorResponse(new Error("ECONNREFUSED"))
		]
	});
	const provider = new HdhomerunProvider(makeRow(base), {
		fetch,
		clock: instantClock(),
		maxRetries: 3,
		retryBaseDelayMs: 0
	});
	const status = await provider.getStatus();
	assert.equal(status.online, false);
	assert.match(status.message ?? "", /ECONNREFUSED/);
});

test("HdhomerunProvider resolves a fresh guide URL from discover.json", async () => {
	const base = "http://10.0.0.5";
	const discoverUrl = `${base}/discover.json`;
	const { fetch, calls } = mockFetch({
		[discoverUrl]: [
			jsonResponse({ DeviceAuth: "FIRST_TOKEN" }),
			jsonResponse({ DeviceAuth: "SECOND_TOKEN" })
		]
	});
	const provider = new HdhomerunProvider(makeRow(base), {
		fetch,
		clock: instantClock()
	});
	const guideProvider = provider as unknown as {
		getGuideUrl(): Promise<string>;
	};

	assert.equal(
		await guideProvider.getGuideUrl(),
		"https://api.hdhomerun.com/api/xmltv?DeviceAuth=FIRST_TOKEN"
	);
	assert.equal(
		await guideProvider.getGuideUrl(),
		"https://api.hdhomerun.com/api/xmltv?DeviceAuth=SECOND_TOKEN"
	);
	assert.equal(
		calls.filter((call) => call.url === discoverUrl).length,
		2,
		"DeviceAuth must be re-read for every guide refresh"
	);
});

test("HdhomerunProvider reports a missing DeviceAuth without leaking credentials", async () => {
	const base = "http://10.0.0.5";
	const { fetch } = mockFetch({
		[`${base}/discover.json`]: [jsonResponse({ DeviceID: "1234ABCD" })]
	});
	const provider = new HdhomerunProvider(makeRow(base), {
		fetch,
		clock: instantClock()
	}) as unknown as { getGuideUrl(): Promise<string> };

	await assert.rejects(
		provider.getGuideUrl(),
		/did not provide a DeviceAuth token/
	);
});

test("createHdhomerunFactory.discover hits the cloud endpoint and enriches via discover.json", async () => {
	const cloudUrl = "https://api.example/discover";
	const deviceBase = "http://192.0.2.50";
	const { fetch } = mockFetch({
		[cloudUrl]: [
			jsonResponse([
				{
					DeviceID: "1234ABCD",
					LocalIP: "192.0.2.50",
					BaseURL: deviceBase
				}
			])
		],
		[`${deviceBase}/discover.json`]: [
			jsonResponse({
				DeviceID: "1234ABCD",
				FriendlyName: "Living Room HDHR",
				ModelNumber: "HDHR5-4US",
				BaseURL: deviceBase,
				TunerCount: 4
			})
		]
	});
	const factory = createHdhomerunFactory({
		fetch,
		clock: instantClock(),
		cloudDiscoveryUrl: cloudUrl
	});
	const results = await factory.discover();
	assert.equal(results.length, 1);
	assert.equal(results[0]?.kind, "hdhomerun");
	assert.equal(results[0]?.name, "Living Room HDHR");
	assert.deepEqual(results[0]?.config, {
		host: deviceBase,
		deviceId: "1234ABCD"
	});
});

test("createHdhomerunFactory.discover swallows cloud errors and returns []", async () => {
	const cloudUrl = "https://api.example/discover";
	const { fetch } = mockFetch({
		[cloudUrl]: [
			errorResponse(new Error("network down")),
			errorResponse(new Error("network down")),
			errorResponse(new Error("network down")),
			errorResponse(new Error("network down"))
		]
	});
	const factory = createHdhomerunFactory({
		fetch,
		clock: instantClock(),
		cloudDiscoveryUrl: cloudUrl,
		maxRetries: 3,
		retryBaseDelayMs: 0
	});
	const results = await factory.discover();
	assert.deepEqual(results, []);
});

test("createHdhomerunFactory.create hydrates a HdhomerunProvider from a row", () => {
	const factory = createHdhomerunFactory({
		fetch: mockFetch({}).fetch,
		clock: instantClock()
	});
	const provider = factory.create(makeRow("10.0.0.7"));
	assert.equal(provider.kind, "hdhomerun");
	assert.equal(provider.getCapabilities().concurrentStreams, 2);
});
