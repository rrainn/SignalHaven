import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { Tuner } from "@signalhaven/shared";
import request from "supertest";

import { createApp } from "../src/app";
import { createTestAuthentication } from "../src/auth/middleware";
import { EventBus } from "../src/events/event-bus";
import type { HealthRepository } from "../src/repositories/health.repository";
import type {
	TunersRepository,
	UpdateTunerInput,
	CreateTunerInput
} from "../src/repositories/tuners.repository";
import { TunerRegistry } from "../src/tuners/provider";
import {
	createIptvFactory,
	IptvProvider,
	type IptvFetchLike,
	type IptvLogger
} from "../src/tuners/providers/iptv";
import { parseM3uText } from "../src/tuners/providers/m3u-parser";
import { TunersService } from "../src/tuners/tuners.service";

function stubHealthRepository(): HealthRepository {
	return { isHealthy: async () => true } as unknown as HealthRepository;
}

interface TunerRow {
	id: string;
	kind: string;
	name: string;
	config: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

class InMemoryTunersRepository {
	private rows = new Map<string, TunerRow>();

	async create(input: CreateTunerInput): Promise<TunerRow> {
		const now = new Date();
		const row: TunerRow = {
			id: randomUUID(),
			kind: input.kind,
			name: input.name,
			config: input.config,
			createdAt: now,
			updatedAt: now
		};
		this.rows.set(row.id, row);
		return row;
	}
	async getById(id: string): Promise<TunerRow | null> {
		return this.rows.get(id) ?? null;
	}
	async list(): Promise<TunerRow[]> {
		return [...this.rows.values()];
	}
	async update(id: string, input: UpdateTunerInput): Promise<TunerRow | null> {
		const existing = this.rows.get(id);
		if (!existing) return null;
		const updated: TunerRow = {
			...existing,
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.kind !== undefined ? { kind: input.kind } : {}),
			...(input.config !== undefined ? { config: input.config } : {}),
			updatedAt: new Date()
		};
		this.rows.set(id, updated);
		return updated;
	}
	async delete(id: string): Promise<boolean> {
		return this.rows.delete(id);
	}
}

const SAMPLE_PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="news.us" tvg-name="News HD" tvg-logo="http://logos.example/news.png" group-title="News",News HD
http://stream.example/news.m3u8
#EXTINF:-1 tvg-id="sports.us" group-title="Sports",Sports Live
http://stream.example/sports.m3u8
#EXTINF:0,Plain Channel
http://stream.example/plain.ts
`;

const MALFORMED_PLAYLIST = `#EXTM3U
# a regular comment
#EXTINF:-1,Good
http://stream.example/good.m3u8
#EXTINF:-1,Orphan
#EXTINF:-1,Following
http://stream.example/following.m3u8
not-a-url
#EXTINF:-1,Trailing
`;

function makeFetch(
	responses: Record<string, () => Awaited<ReturnType<IptvFetchLike>>>
): { fetch: IptvFetchLike; calls: string[] } {
	const calls: string[] = [];
	const fetch: IptvFetchLike = async (url) => {
		calls.push(url);
		const handler = responses[url];
		if (!handler) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		return handler();
	};
	return { fetch, calls };
}

function textBodyResponse(text: string) {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	// Yield in two chunks to exercise the streaming line decoder.
	const half = Math.floor(bytes.length / 2);
	const chunks = [bytes.slice(0, half), bytes.slice(half)];
	async function* body() {
		for (const c of chunks) yield c;
	}
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: () => null },
		body: body() as AsyncIterable<Uint8Array>,
		async text() {
			return text;
		},
		async arrayBuffer() {
			return toArrayBuffer(bytes);
		}
	};
}

function imageResponse(contentType: string, bytes: Uint8Array) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "content-type" ? contentType : null
		},
		body: null,
		async text() {
			return "";
		},
		async arrayBuffer() {
			return toArrayBuffer(bytes);
		}
	};
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buf).set(bytes);
	return buf;
}

function makeRow(url = "http://playlist.example/list.m3u"): Tuner {
	return {
		id: randomUUID(),
		kind: "iptv",
		name: "Sample IPTV",
		config: { url },
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString()
	};
}

class CapturingLogger implements IptvLogger {
	warnings: string[] = [];
	warn(...args: unknown[]): void {
		this.warnings.push(args.map(String).join(" "));
	}
}

// ---------------------------------------------------------------- parser ---

test("parseM3uText extracts tvg-* and group-title attributes", async () => {
	const channels = await parseM3uText(SAMPLE_PLAYLIST);
	assert.equal(channels.length, 3);
	assert.deepEqual(channels[0], {
		url: "http://stream.example/news.m3u8",
		title: "News HD",
		tvgId: "news.us",
		tvgName: "News HD",
		tvgLogo: "http://logos.example/news.png",
		groupTitle: "News"
	});
	assert.equal(channels[1]?.tvgId, "sports.us");
	assert.equal(channels[1]?.groupTitle, "Sports");
	// Plain entry: no extended attrs but still parsed.
	assert.equal(channels[2]?.title, "Plain Channel");
	assert.equal(channels[2]?.tvgLogo, undefined);
});

test("parseM3uText handles a minimal playlist with no extended attributes", async () => {
	const text = `#EXTM3U
http://a.example/1.ts
http://b.example/2.ts
`;
	const channels = await parseM3uText(text);
	assert.equal(channels.length, 2);
	assert.equal(channels[0]?.title, "http://a.example/1.ts");
	assert.equal(channels[0]?.url, "http://a.example/1.ts");
});

test("parseM3uText skips malformed entries and reports warnings", async () => {
	const warnings: string[] = [];
	const channels = await parseM3uText(MALFORMED_PLAYLIST, {
		onWarn: (msg) => warnings.push(msg)
	});
	// The "Good" + "Following" entries survive; "Orphan", "not-a-url", and
	// the trailing "Trailing" are dropped.
	assert.deepEqual(
		channels.map((c) => c.title),
		["Good", "Following"]
	);
	assert.ok(warnings.length >= 2, `expected warnings, got ${warnings.length}`);
	assert.ok(warnings.some((w) => /Orphan|previous #EXTINF/i.test(w)));
	assert.ok(warnings.some((w) => /unsupported URL scheme/i.test(w)));
});

test("parseM3uText handles CRLF line endings", async () => {
	const text = "#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://x.example/a\r\n";
	const channels = await parseM3uText(text);
	assert.equal(channels.length, 1);
	assert.equal(channels[0]?.title, "A");
});

// -------------------------------------------------------------- provider ---

test("IptvProvider.getCapabilities reports supportsTranscoding=true", async () => {
	const provider = new IptvProvider(makeRow(), {
		fetch: makeFetch({}).fetch
	});
	assert.deepEqual(provider.getCapabilities(), {
		supportsTranscoding: true,
		concurrentStreams: 4
	});
});

test("IptvProvider.getLineup parses playlist via streaming body", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch, calls } = makeFetch({
		[url]: () => textBodyResponse(SAMPLE_PLAYLIST)
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	const lineup = await provider.getLineup();
	assert.equal(lineup.length, 3);
	assert.equal(lineup[0]?.channelId, "news.us");
	assert.equal(lineup[0]?.name, "News HD");
	assert.equal(lineup[0]?.logoUrl, "http://logos.example/news.png");
	assert.equal(lineup[0]?.number, "1");
	assert.equal(lineup[0]?.tvgId, "news.us");
	assert.equal(lineup[1]?.channelId, "sports.us");
	// Second call hits the in-memory cache.
	await provider.getLineup();
	assert.equal(calls.length, 1);
});

test("IptvProvider.getStreamUrl returns the underlying playlist URL", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch } = makeFetch({
		[url]: () => textBodyResponse(SAMPLE_PLAYLIST)
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	const stream = await provider.getStreamUrl("news.us");
	assert.equal(stream.url, "http://stream.example/news.m3u8");
});

test("IptvProvider.getStreamUrl rejects unknown channel ids", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch } = makeFetch({
		[url]: () => textBodyResponse(SAMPLE_PLAYLIST)
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	await assert.rejects(
		() => provider.getStreamUrl("does-not-exist"),
		/Unknown IPTV channel id/
	);
});

test("IptvProvider.refreshLineup invalidates the cache", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch, calls } = makeFetch({
		[url]: () => textBodyResponse(SAMPLE_PLAYLIST)
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	await provider.getLineup();
	provider.refreshLineup();
	await provider.getLineup();
	assert.equal(calls.length, 2);
});

test("IptvProvider lineup TTL controls the cache lifetime", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch, calls } = makeFetch({
		[url]: () => textBodyResponse(SAMPLE_PLAYLIST)
	});
	let now = 1_000;
	const provider = new IptvProvider(makeRow(url), {
		fetch,
		clock: { now: () => now },
		lineupTtlMs: 500
	});
	await provider.getLineup();
	now += 200;
	await provider.getLineup();
	assert.equal(calls.length, 1);
	now += 1_000;
	await provider.getLineup();
	assert.equal(calls.length, 2);
});

test("IptvProvider keeps the last known lineup during a refresh outage", async () => {
	const url = "http://playlist.example/list.m3u";
	let now = 1_000;
	let fetchCalls = 0;
	const logger = new CapturingLogger();
	const fetch: IptvFetchLike = async () => {
		fetchCalls += 1;
		if (fetchCalls === 1) {
			return textBodyResponse(SAMPLE_PLAYLIST);
		}
		throw new Error("temporary playlist outage");
	};
	const provider = new IptvProvider(makeRow(url), {
		fetch,
		clock: { now: () => now },
		lineupTtlMs: 500,
		logger
	});

	await provider.getLineup();
	now += 1_000;
	const stream = await provider.getStreamUrl("news.us");

	assert.equal(stream.url, "http://stream.example/news.m3u8");
	assert.equal(fetchCalls, 2);
	assert.ok(
		logger.warnings.some((warning) =>
			warning.includes("using the last known lineup")
		)
	);
});

test("IptvProvider concurrent getLineup calls share a single fetch", async () => {
	const url = "http://playlist.example/list.m3u";
	let resolve: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		resolve = r;
	});
	const { fetch, calls } = makeFetch({
		[url]: () => {
			const response = textBodyResponse(SAMPLE_PLAYLIST);
			// Wait until both callers are queued before resolving so the inflight
			// de-dup is exercised even if the body resolves synchronously.
			return Promise.resolve(gate).then(() => response) as never;
		}
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	const both = Promise.all([provider.getLineup(), provider.getLineup()]);
	resolve?.();
	await both;
	assert.equal(calls.length, 1);
});

test("IptvProvider.getStatus is online when the playlist parses", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch } = makeFetch({
		[url]: () => textBodyResponse(SAMPLE_PLAYLIST)
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	const status = await provider.getStatus();
	assert.equal(status.online, true);
});

test("IptvProvider.getStatus is offline when the playlist fetch fails", async () => {
	const url = "http://playlist.example/list.m3u";
	const fetch: IptvFetchLike = async () => ({
		ok: false,
		status: 502,
		statusText: "Bad Gateway",
		headers: { get: () => null },
		body: null,
		async text() {
			return "";
		},
		async arrayBuffer() {
			return new ArrayBuffer(0);
		}
	});
	const provider = new IptvProvider(makeRow(url), { fetch });
	const status = await provider.getStatus();
	assert.equal(status.online, false);
	assert.match(status.message ?? "", /HTTP 502/);
});

test("IptvProvider warns on malformed entries via the supplied logger", async () => {
	const url = "http://playlist.example/list.m3u";
	const { fetch } = makeFetch({
		[url]: () => textBodyResponse(MALFORMED_PLAYLIST)
	});
	const logger = new CapturingLogger();
	const provider = new IptvProvider(makeRow(url), { fetch, logger });
	const lineup = await provider.getLineup();
	assert.equal(lineup.length, 2);
	assert.ok(
		logger.warnings.some((w) => /IPTV playlist parse warning/.test(w)),
		`expected warnings, got: ${logger.warnings.join(" | ")}`
	);
});

test("IptvProvider rejects unsupported playlist URL schemes", async () => {
	const provider = new IptvProvider(makeRow("ftp://example.com/list.m3u"), {
		fetch: async () => {
			throw new Error("unexpected fetch");
		}
	});
	await assert.rejects(() => provider.getLineup(), /Unsupported playlist URL/);
});

test("IptvProvider streams a file:// playlist off disk", async () => {
	const dir = mkdtempSync(join(tmpdir(), "iptv-test-"));
	const path = join(dir, "list.m3u");
	writeFileSync(path, SAMPLE_PLAYLIST, "utf-8");
	const fileUrl = pathToFileURL(path).toString();
	const provider = new IptvProvider(makeRow(fileUrl), {
		fetch: async () => {
			throw new Error("no network for file://");
		}
	});
	const lineup = await provider.getLineup();
	assert.equal(lineup.length, 3);
});

test("IptvProvider.getLogo proxies and caches upstream image bytes", async () => {
	const url = "http://playlist.example/list.m3u";
	const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
	let fetchCount = 0;
	const fetch: IptvFetchLike = async (target) => {
		fetchCount += 1;
		if (target === url) return textBodyResponse(SAMPLE_PLAYLIST);
		if (target === "http://logos.example/news.png")
			return imageResponse("image/png", logoBytes);
		throw new Error(`Unexpected fetch: ${target}`);
	};
	const provider = new IptvProvider(makeRow(url), { fetch });
	const first = await provider.getLogo("news.us");
	assert.ok(first);
	assert.equal(first?.contentType, "image/png");
	assert.equal(first?.body.length, logoBytes.length);
	// Logo cache hit.
	await provider.getLogo("news.us");
	// Channel without a logo returns null.
	const noLogo = await provider.getLogo("sports.us");
	assert.equal(noLogo, null);
	// Two upstream calls: 1 playlist + 1 logo.
	assert.equal(fetchCount, 2);
});

test("IptvProvider.getLogo enforces the configured size cap", async () => {
	const url = "http://playlist.example/list.m3u";
	const big = new Uint8Array(1_000);
	const fetch: IptvFetchLike = async (target) => {
		if (target === url) return textBodyResponse(SAMPLE_PLAYLIST);
		return imageResponse("image/png", big);
	};
	const logger = new CapturingLogger();
	const provider = new IptvProvider(makeRow(url), {
		fetch,
		logger,
		logoMaxBytes: 100
	});
	const result = await provider.getLogo("news.us");
	assert.equal(result, null);
	assert.ok(logger.warnings.some((w) => /exceeds 100 bytes/.test(w)));
});

// ---------------------------------------------------------------- routes ---

interface Harness {
	app: ReturnType<typeof createApp>;
	service: TunersService;
	repo: InMemoryTunersRepository;
	fetchCalls: string[];
}

function buildHarness(fetchImpl: IptvFetchLike, callsRef: string[]): Harness {
	const bus = new EventBus();
	const repo = new InMemoryTunersRepository();
	const factory = createIptvFactory({
		fetch: (input, init) => {
			callsRef.push(input);
			return fetchImpl(input, init);
		}
	});
	const registry = new TunerRegistry([factory]);
	const service = new TunersService({
		repository: repo as unknown as TunersRepository,
		registry,
		bus
	});
	const app = createApp({
		authentication: createTestAuthentication(),
		env: { ...process.env, NODE_ENV: "test" },
		healthRepository: stubHealthRepository(),
		tunersService: service,
		bus
	});
	return { app, service, repo, fetchCalls: callsRef };
}

test("GET /api/v1/tuners/:id/channels/:channelId/logo proxies the image", async () => {
	const url = "http://playlist.example/list.m3u";
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const fetchCalls: string[] = [];
	const fetchImpl: IptvFetchLike = async (target) => {
		if (target === url) return textBodyResponse(SAMPLE_PLAYLIST);
		if (target === "http://logos.example/news.png")
			return imageResponse("image/png", png);
		throw new Error(`Unexpected fetch: ${target}`);
	};
	const { app, repo } = buildHarness(fetchImpl, fetchCalls);
	const row = await repo.create({
		kind: "iptv",
		name: "Sample",
		config: { url }
	});
	const response = await request(app).get(
		`/api/v1/tuners/${row.id}/channels/news.us/logo`
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers["content-type"], "image/png");
	assert.equal(response.headers["cache-control"], "private, no-store");
	assert.equal(response.body.length, png.length);
});

test("GET /api/v1/tuners/:id/channels/:channelId/logo returns 404 when missing", async () => {
	const url = "http://playlist.example/list.m3u";
	const fetchCalls: string[] = [];
	const fetchImpl: IptvFetchLike = async (target) => {
		if (target === url) return textBodyResponse(SAMPLE_PLAYLIST);
		throw new Error(`Unexpected fetch: ${target}`);
	};
	const { app, repo } = buildHarness(fetchImpl, fetchCalls);
	const row = await repo.create({
		kind: "iptv",
		name: "Sample",
		config: { url }
	});
	// sports.us has no logo in the sample playlist.
	const response = await request(app).get(
		`/api/v1/tuners/${row.id}/channels/sports.us/logo`
	);
	assert.equal(response.status, 404);
});
