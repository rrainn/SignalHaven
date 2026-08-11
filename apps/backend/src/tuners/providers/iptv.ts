import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	iptvConfigSchema,
	type Tuner,
	type TunerCapabilities,
	type TunerDiscoveryResult,
	type TunerLineupChannel,
	type TunerStatus,
	type TunerStreamOptions,
	type TunerStreamUrl
} from "@signalhaven/shared";

import type {
	TunerProvider,
	TunerProviderFactory,
	TunerLogo
} from "../provider";

import {
	linesFromChunks,
	parseM3uLines,
	type ParsedM3uChannel
} from "./m3u-parser";

/**
 * Subset of the global `fetch` we depend on. Declared so tests can swap in
 * a deterministic stub without monkey-patching the global. Intentionally
 * mirrors {@link FetchLike} from the HDHomeRun provider but adds support
 * for streaming response bodies (needed for large playlists).
 */
export type IptvFetchLike = (
	input: string,
	init?: { signal?: AbortSignal; method?: string }
) => Promise<{
	ok: boolean;
	status: number;
	statusText: string;
	headers: { get(name: string): string | null };
	body?:
		| AsyncIterable<Uint8Array>
		| {
				getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
		  }
		| null;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Minimal clock used for cache TTL computations. */
export interface IptvClock {
	now(): number;
}

const realClock: IptvClock = {
	now: () => Date.now()
};

export interface IptvLogger {
	warn(...args: unknown[]): void;
}

const noopLogger: IptvLogger = { warn: () => {} };

/** Default 12-hour refresh interval per the issue's acceptance criteria. */
export const DEFAULT_LINEUP_TTL_MS = 12 * 60 * 60 * 1_000;
/** Default logo cache TTL — 24h. Logos rarely change. */
export const DEFAULT_LOGO_TTL_MS = 24 * 60 * 60 * 1_000;
/** Hard cap on the number of bytes we'll buffer for a single proxied logo. */
export const DEFAULT_LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** Default per-request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Avoid hammering a failing playlist while serving a last known-good lineup. */
const LINEUP_REFRESH_RETRY_MS = 60_000;

export interface IptvProviderOptions {
	fetch?: IptvFetchLike;
	clock?: IptvClock;
	logger?: IptvLogger;
	/** Override the lineup cache TTL (default 12h). */
	lineupTtlMs?: number;
	/** Override the logo cache TTL (default 24h). */
	logoTtlMs?: number;
	/** Override the per-request timeout. */
	requestTimeoutMs?: number;
	/** Override the maximum logo response size we'll proxy (default 2 MiB). */
	logoMaxBytes?: number;
}

interface ResolvedOptions {
	fetch: IptvFetchLike;
	clock: IptvClock;
	logger: IptvLogger;
	lineupTtlMs: number;
	logoTtlMs: number;
	requestTimeoutMs: number;
	logoMaxBytes: number;
}

function defaultFetch(): IptvFetchLike {
	const f = globalThis.fetch;
	if (typeof f !== "function") {
		throw new Error("Global fetch is not available in this runtime");
	}
	return ((input: string, init?: { signal?: AbortSignal; method?: string }) =>
		f(input, init as RequestInit)) as unknown as IptvFetchLike;
}

function resolveOptions(options: IptvProviderOptions): ResolvedOptions {
	return {
		fetch: options.fetch ?? defaultFetch(),
		clock: options.clock ?? realClock,
		logger: options.logger ?? noopLogger,
		lineupTtlMs: Math.max(0, options.lineupTtlMs ?? DEFAULT_LINEUP_TTL_MS),
		logoTtlMs: Math.max(0, options.logoTtlMs ?? DEFAULT_LOGO_TTL_MS),
		requestTimeoutMs: Math.max(
			1_000,
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		),
		logoMaxBytes: Math.max(1, options.logoMaxBytes ?? DEFAULT_LOGO_MAX_BYTES)
	};
}

/**
 * Compute a stable, opaque channel id from an M3U entry. We prefer the
 * explicit `channel-id`, then `tvg-id`, then a SHA-1 of the URL so the id
 * survives playlist refreshes that re-order entries. The id never contains
 * URL-unsafe characters so it can be embedded directly in our routes.
 */
export function deriveChannelId(entry: ParsedM3uChannel): string {
	if (entry.channelId) return sanitizeId(entry.channelId);
	if (entry.tvgId) return sanitizeId(entry.tvgId);
	return createHash("sha1").update(entry.url).digest("hex").slice(0, 16);
}

function sanitizeId(raw: string): string {
	// Restrict to URL-safe characters; fall back to a hash if the input is
	// entirely unusable (e.g. only whitespace).
	const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_");
	if (cleaned.length === 0) {
		return createHash("sha1").update(raw).digest("hex").slice(0, 16);
	}
	return cleaned.slice(0, 64);
}

/**
 * Synthesise a channel number when the playlist doesn't carry one. We use
 * the 1-based position so the lineup remains stable across refreshes that
 * preserve order.
 */
function deriveChannelNumber(index: number): string {
	return String(index + 1);
}

interface CachedLineup {
	expiresAt: number;
	channels: TunerLineupChannel[];
	/** Maps channelId -> source URL so getStreamUrl() can resolve without re-fetching. */
	urls: Map<string, string>;
	/** Maps channelId -> logo URL for the proxy endpoint. */
	logos: Map<string, string>;
}

interface CachedLogo {
	expiresAt: number;
	body: Buffer;
	contentType: string;
}

/**
 * IPTV / M3U playlist provider.
 *
 * Acceptance criteria covered (rrainn/SignalHaven#13):
 *   * config supports a playlist URL (`url`) and an optional XMLTV EPG URL
 *     (`epgUrl`); both are validated by `iptvConfigSchema`.
 *   * Extended M3U attributes (`tvg-id`, `tvg-logo`, `tvg-name`, `group-title`)
 *     are parsed and surfaced on the returned lineup.
 *   * `getStreamUrl()` returns the channel URL exactly as it appears in the
 *     playlist – no redirection, no rewriting.
 *   * `supportsTranscoding=true`: upstream HLS/TS streams are transcoded by
 *     FFmpeg further down the pipeline.
 *   * The playlist body is consumed as a stream (`linesFromChunks` +
 *     `parseM3uLines`) so 10k+ channel lists don't load entirely into memory.
 *   * Lineup is cached for `lineupTtlMs` (default 12h); the next call after
 *     expiry refreshes from upstream. {@link refreshLineup} forces a refresh.
 *   * Channel logos are proxied via {@link getLogo}, which caches bytes
 *     locally so the UI can fetch them over the same origin (avoiding the
 *     mixed-content issues that arise when an HTTPS UI references HTTP logos).
 *   * Malformed entries are skipped and logged via the supplied
 *     {@link IptvLogger}.
 */
export class IptvProvider implements TunerProvider {
	readonly kind = "iptv" as const;
	readonly id: string;
	private readonly url: string;
	private readonly options: ResolvedOptions;
	private cachedLineup: CachedLineup | undefined;
	private readonly logoCache = new Map<string, CachedLogo>();
	/** De-dupes concurrent lineup fetches so a burst of callers makes one HTTP request. */
	private inflightLineup: Promise<CachedLineup> | undefined;

	constructor(row: Tuner, options: IptvProviderOptions = {}) {
		const config = iptvConfigSchema.parse(row.config);
		this.id = row.id;
		this.url = config.url;
		this.options = resolveOptions(options);
	}

	getCapabilities(): TunerCapabilities {
		// Upstream HLS/TS streams are transcoded by FFmpeg later in the pipeline,
		// so the provider declares transcoding support. `concurrentStreams` is
		// effectively limited by upstream bandwidth; 4 is a sensible default
		// matching the previous stub.
		return { supportsTranscoding: true, concurrentStreams: 4 };
	}

	async getLineup(): Promise<TunerLineupChannel[]> {
		const cached = await this.ensureLineup();
		return cached.channels;
	}

	/** Drop the cached lineup so the next `getLineup()` re-fetches. */
	refreshLineup(): void {
		this.cachedLineup = undefined;
	}

	async getStreamUrl(
		channelId: string,
		_options?: TunerStreamOptions
	): Promise<TunerStreamUrl> {
		const cached = await this.ensureLineup();
		const url = cached.urls.get(channelId);
		if (!url) {
			throw new Error(`Unknown IPTV channel id: ${channelId}`);
		}
		return { url };
	}

	async getStatus(): Promise<TunerStatus> {
		const checkedAt = new Date(this.options.clock.now()).toISOString();
		try {
			await this.ensureLineup();
			return { online: true, checkedAt };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { online: false, message, checkedAt };
		}
	}

	/**
	 * Fetch & cache a logo for the given channel. Returns `null` when the
	 * channel has no logo URL or the upstream fetch fails. The returned bytes
	 * are safe to ship straight to an HTTP client.
	 */
	async getLogo(channelId: string): Promise<TunerLogo | null> {
		const cached = await this.ensureLineup();
		const logoUrl = cached.logos.get(channelId);
		if (!logoUrl) {
			return null;
		}
		const now = this.options.clock.now();
		const hit = this.logoCache.get(channelId);
		if (hit && hit.expiresAt > now) {
			return {
				body: hit.body,
				contentType: hit.contentType,
				cacheMaxAgeSeconds: Math.max(
					0,
					Math.floor((hit.expiresAt - now) / 1_000)
				)
			};
		}

		let response: Awaited<ReturnType<IptvFetchLike>>;
		try {
			response = await this.fetchWithTimeout(logoUrl);
		} catch (error) {
			this.options.logger.warn(
				`IPTV logo fetch failed for ${channelId} (${logoUrl}): ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return null;
		}
		if (!response.ok) {
			this.options.logger.warn(
				`IPTV logo fetch returned HTTP ${response.status} for ${channelId} (${logoUrl})`
			);
			return null;
		}
		let buffer: Buffer;
		try {
			const ab = await response.arrayBuffer();
			if (ab.byteLength > this.options.logoMaxBytes) {
				this.options.logger.warn(
					`IPTV logo for ${channelId} exceeds ${this.options.logoMaxBytes} bytes; refusing to proxy`
				);
				return null;
			}
			buffer = Buffer.from(ab);
		} catch (error) {
			this.options.logger.warn(
				`IPTV logo body read failed for ${channelId}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return null;
		}
		const contentType =
			response.headers.get("content-type")?.trim() ||
			"application/octet-stream";
		const entry: CachedLogo = {
			body: buffer,
			contentType,
			expiresAt: now + this.options.logoTtlMs
		};
		this.logoCache.set(channelId, entry);
		return {
			body: entry.body,
			contentType: entry.contentType,
			cacheMaxAgeSeconds: Math.floor(this.options.logoTtlMs / 1_000)
		};
	}

	// -- internals -----------------------------------------------------------

	private async ensureLineup(): Promise<CachedLineup> {
		const now = this.options.clock.now();
		if (this.cachedLineup && this.cachedLineup.expiresAt > now) {
			return this.cachedLineup;
		}
		if (this.inflightLineup) {
			return this.inflightLineup;
		}
		const staleLineup = this.cachedLineup;
		const promise = this.fetchAndParseLineup(now)
			.then((cached) => {
				this.cachedLineup = cached;
				return cached;
			})
			.catch((error: unknown) => {
				if (!staleLineup) {
					throw error;
				}
				// A temporary playlist outage must not erase stream URLs that were
				// already known to work, especially when a scheduled recording starts.
				const retryDelayMs = Math.min(
					this.options.lineupTtlMs,
					LINEUP_REFRESH_RETRY_MS
				);
				const fallback = {
					...staleLineup,
					expiresAt: now + retryDelayMs
				};
				this.cachedLineup = fallback;
				this.options.logger.warn(
					`IPTV playlist refresh failed; using the last known lineup: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
				return fallback;
			})
			.finally(() => {
				this.inflightLineup = undefined;
			});
		this.inflightLineup = promise;
		return promise;
	}

	private async fetchAndParseLineup(now: number): Promise<CachedLineup> {
		const lines = await this.openPlaylistLines();
		const channels: TunerLineupChannel[] = [];
		const urls = new Map<string, string>();
		const logos = new Map<string, string>();
		const seenIds = new Set<string>();
		let index = 0;

		for await (const entry of parseM3uLines(lines, {
			onWarn: (msg) => {
				this.options.logger.warn(`IPTV playlist parse warning: ${msg}`);
			}
		})) {
			const baseId = deriveChannelId(entry);
			let id = baseId;
			let dedup = 1;
			while (seenIds.has(id)) {
				dedup += 1;
				id = `${baseId}-${dedup}`;
			}
			seenIds.add(id);

			const name = entry.tvgName?.trim() || entry.title.trim() || id;
			const channel: TunerLineupChannel = {
				channelId: id,
				number: deriveChannelNumber(index),
				name
			};
			if (entry.tvgId?.trim()) {
				// Preserve the provider's guide identity for exact XMLTV matching.
				channel.tvgId = entry.tvgId.trim();
			}
			if (entry.tvgLogo && isHttpUrl(entry.tvgLogo)) {
				channel.logoUrl = entry.tvgLogo;
				logos.set(id, entry.tvgLogo);
			}
			channels.push(channel);
			urls.set(id, entry.url);
			index += 1;
		}

		return {
			expiresAt: now + this.options.lineupTtlMs,
			channels,
			urls,
			logos
		};
	}

	/**
	 * Open the configured playlist URL and yield decoded text lines. Supports
	 * both `http(s):` (streaming response body) and `file:` (streaming the
	 * local file off disk). Other schemes are rejected so we don't accidentally
	 * dispatch arbitrary protocol handlers.
	 */
	private async openPlaylistLines(): Promise<AsyncIterable<string>> {
		const lower = this.url.toLowerCase();
		if (lower.startsWith("file:")) {
			const path = fileURLToPath(this.url);
			return linesFromChunks(
				createReadStream(path) as AsyncIterable<Uint8Array>
			);
		}
		if (!isHttpUrl(this.url)) {
			throw new Error(
				`Unsupported playlist URL scheme: ${this.url} (expected http, https or file)`
			);
		}
		const response = await this.fetchWithTimeout(this.url);
		if (!response.ok) {
			throw new Error(
				`Playlist fetch failed: HTTP ${response.status} ${response.statusText}`
			);
		}
		if (response.body) {
			return linesFromChunks(response.body);
		}
		// Fallback for fetch implementations that don't expose a streamable body
		// (e.g. older polyfills): read the whole text and split it. Only hit on
		// small playlists in practice; the streaming path covers the 10k+ case.
		const text = await response.text();
		return (async function* () {
			for (const line of text.replace(/\r\n?/g, "\n").split("\n")) yield line;
		})();
	}

	private async fetchWithTimeout(url: string): ReturnType<IptvFetchLike> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			this.options.requestTimeoutMs
		);
		try {
			return await this.options.fetch(url, { signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

export type IptvFactoryOptions = IptvProviderOptions;

export function createIptvFactory(
	options: IptvFactoryOptions = {}
): TunerProviderFactory {
	return {
		kind: "iptv",
		create(row) {
			return new IptvProvider(row, options);
		},
		async discover(): Promise<TunerDiscoveryResult[]> {
			// M3U sources are user-supplied URLs; nothing to auto-discover.
			return [];
		}
	};
}

/**
 * Default factory wired with the global `fetch`. Production code uses this;
 * tests prefer {@link createIptvFactory} so they can inject a stub fetch.
 */
export const iptvFactory: TunerProviderFactory = createIptvFactory();
