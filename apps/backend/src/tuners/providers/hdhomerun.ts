import {
	hdhomerunConfigSchema,
	type Tuner,
	type TunerCapabilities,
	type TunerDiscoveryResult,
	type TunerLineupChannel,
	type TunerStatus,
	type TunerStreamOptions,
	type TunerStreamUrl
} from "@signalhaven/shared";

import type {
	TunerChannelQuality,
	TunerProvider,
	TunerProviderFactory
} from "../provider";

/**
 * Subset of the global `fetch` we depend on. Declared so tests can swap in a
 * deterministic stub without monkey-patching the global.
 */
export type FetchLike = (
	input: string,
	init?: { signal?: AbortSignal; method?: string }
) => Promise<{
	ok: boolean;
	status: number;
	statusText: string;
	text(): Promise<string>;
	json(): Promise<unknown>;
}>;

/** Minimal clock used for cache TTL & retry backoff. */
export interface HdhomerunClock {
	now(): number;
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: HdhomerunClock = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => {
		if (handle !== undefined) {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		}
	}
};

/** Default HTTP timeout for every HDHomeRun request (per acceptance criteria). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** Maximum number of *retries* (4 total attempts) per the acceptance criteria. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default lineup cache TTL — 24h, the value called out in the issue. */
export const DEFAULT_LINEUP_TTL_MS = 24 * 60 * 60 * 1_000;

/** Cloud discovery endpoint that lists every device on the caller's LAN. */
export const DEFAULT_CLOUD_DISCOVERY_URL = "https://api.hdhomerun.com/discover";

/** SiliconDust XMLTV endpoint populated with a fresh DeviceAuth token. */
export const DEFAULT_GUIDE_URL = "https://api.hdhomerun.com/api/xmltv";

export interface HdhomerunProviderOptions {
	fetch?: FetchLike;
	clock?: HdhomerunClock;
	/** Override the per-request timeout. Defaults to 5s. */
	requestTimeoutMs?: number;
	/** Override the maximum number of retries. Defaults to 3. */
	maxRetries?: number;
	/** Initial backoff delay in milliseconds (doubles per attempt). */
	retryBaseDelayMs?: number;
	/** Lineup cache TTL in milliseconds. Defaults to 24h. */
	lineupTtlMs?: number;
}

export interface HdhomerunFactoryOptions extends HdhomerunProviderOptions {
	/** Override the cloud discovery endpoint (useful for tests). */
	cloudDiscoveryUrl?: string;
}

interface ResolvedOptions {
	fetch: FetchLike;
	clock: HdhomerunClock;
	requestTimeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	lineupTtlMs: number;
}

function defaultFetch(): FetchLike {
	// `globalThis.fetch` is a Node 18+ built-in. Bind to keep the receiver
	// correct without pulling in a third-party HTTP client.
	const f = globalThis.fetch;
	if (typeof f !== "function") {
		throw new Error("Global fetch is not available in this runtime");
	}
	return ((input: string, init?: { signal?: AbortSignal; method?: string }) =>
		f(input, init as RequestInit)) as unknown as FetchLike;
}

function resolveOptions(options: HdhomerunProviderOptions): ResolvedOptions {
	return {
		fetch: options.fetch ?? defaultFetch(),
		clock: options.clock ?? realClock,
		requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		maxRetries: Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES),
		retryBaseDelayMs: Math.max(0, options.retryBaseDelayMs ?? 200),
		lineupTtlMs: Math.max(0, options.lineupTtlMs ?? DEFAULT_LINEUP_TTL_MS)
	};
}

/**
 * Normalize a user-supplied `host` to a URL. Accepts bare hostnames/IPs,
 * `host:port`, or a full URL (`http://...`).
 */
function normalizeBaseUrl(host: string): URL {
	const trimmed = host.trim();
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `http://${trimmed}`;
	const url = new URL(withScheme);
	// discover.json / lineup.json live at the device root; strip any path
	// accidentally supplied by the user.
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url;
}

/** Build the `tuner<N>/Status` endpoint for the given base URL. */
function tunerStatusUrl(base: URL, tuner: number): string {
	return new URL(`tuner${tuner}/Status`, base).toString();
}

class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

/**
 * Best-effort detection of "transient" failures that warrant a retry. 5xx and
 * network errors retry; 4xx surfaces immediately so a misconfigured device
 * doesn't waste backoff sleeping.
 */
function isTransientHttpError(error: unknown): boolean {
	if (error instanceof TimeoutError) {
		return true;
	}
	if (error instanceof HdhomerunHttpError) {
		return error.status >= 500 && error.status <= 599;
	}
	return true;
}

export class HdhomerunHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, url: string) {
		super(`HDHomeRun HTTP ${status} ${statusText} (${url})`);
		this.name = "HdhomerunHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

interface HttpHelper {
	text(url: string): Promise<string>;
	json(url: string): Promise<unknown>;
}

/**
 * Perform an HTTP request with the configured timeout & retry/backoff. The
 * helper is exported as a closure so callers don't have to thread the options
 * through every call site.
 */
function makeHttp(opts: ResolvedOptions): HttpHelper {
	async function attempt(url: string): Promise<{
		ok: boolean;
		status: number;
		statusText: string;
		text(): Promise<string>;
		json(): Promise<unknown>;
	}> {
		const controller = new AbortController();
		const timer = opts.clock.setTimeout(() => {
			controller.abort();
		}, opts.requestTimeoutMs);
		try {
			const response = await opts.fetch(url, { signal: controller.signal });
			if (!response.ok) {
				throw new HdhomerunHttpError(response.status, response.statusText, url);
			}
			return response;
		} catch (error) {
			if (error instanceof HdhomerunHttpError) {
				throw error;
			}
			const isAbortError =
				error instanceof Error &&
				(error.name === "AbortError" || error.name === "TimeoutError");
			if (controller.signal.aborted && isAbortError) {
				throw new TimeoutError(
					`HDHomeRun request timed out after ${opts.requestTimeoutMs}ms (${url})`
				);
			}
			throw error;
		} finally {
			opts.clock.clearTimeout(timer);
		}
	}

	async function withRetry<T>(
		url: string,
		extract: (response: Awaited<ReturnType<typeof attempt>>) => Promise<T>
	): Promise<T> {
		let lastError: unknown;
		for (let i = 0; i <= opts.maxRetries; i++) {
			try {
				const response = await attempt(url);
				return await extract(response);
			} catch (error) {
				lastError = error;
				const hasMoreAttempts = i < opts.maxRetries;
				if (!hasMoreAttempts || !isTransientHttpError(error)) {
					throw error;
				}
				const delay = opts.retryBaseDelayMs * Math.pow(2, i);
				if (delay > 0) {
					await new Promise<void>((resolve) => {
						opts.clock.setTimeout(resolve, delay);
					});
				}
			}
		}
		// Unreachable, but TypeScript can't see the loop always returns/throws.
		throw lastError ?? new Error("HDHomeRun request failed");
	}

	return {
		text: (url) => withRetry(url, (r) => r.text()),
		json: (url) => withRetry(url, (r) => r.json())
	};
}

interface RawLineupEntry {
	GuideNumber?: unknown;
	GuideName?: unknown;
	URL?: unknown;
	HD?: unknown;
	VideoCodec?: unknown;
	AudioCodec?: unknown;
	DRM?: unknown;
	Favorite?: unknown;
}

function parseLineup(raw: unknown): TunerLineupChannel[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const channels: TunerLineupChannel[] = [];
	for (const entry of raw as RawLineupEntry[]) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const number =
			typeof entry.GuideNumber === "string" ? entry.GuideNumber : null;
		const name = typeof entry.GuideName === "string" ? entry.GuideName : null;
		if (!number || !name) {
			continue;
		}
		// Skip DRM-encrypted channels: we cannot stream them, so they would only
		// pollute the lineup. Mirrors the behavior of common HDHomeRun clients.
		if (entry.DRM === 1 || entry.DRM === "1") {
			continue;
		}
		channels.push({
			channelId: number,
			number,
			name
		});
	}
	return channels;
}

interface RawDiscoverDocument {
	DeviceID?: unknown;
	FriendlyName?: unknown;
	ModelNumber?: unknown;
	BaseURL?: unknown;
	TunerCount?: unknown;
	LocalIP?: unknown;
	DeviceAuth?: unknown;
}

function parseDiscoverDocument(raw: unknown): {
	deviceId?: string;
	friendlyName?: string;
	modelNumber?: string;
	baseURL?: string;
	tunerCount?: number;
	localIP?: string;
	deviceAuth?: string;
} {
	if (!raw || typeof raw !== "object") {
		return {};
	}
	const doc = raw as RawDiscoverDocument;
	const out: {
		deviceId?: string;
		friendlyName?: string;
		modelNumber?: string;
		baseURL?: string;
		tunerCount?: number;
		localIP?: string;
		deviceAuth?: string;
	} = {};
	if (typeof doc.DeviceID === "string") out.deviceId = doc.DeviceID;
	if (typeof doc.FriendlyName === "string") out.friendlyName = doc.FriendlyName;
	if (typeof doc.ModelNumber === "string") out.modelNumber = doc.ModelNumber;
	if (typeof doc.BaseURL === "string") out.baseURL = doc.BaseURL;
	if (typeof doc.LocalIP === "string") out.localIP = doc.LocalIP;
	if (typeof doc.DeviceAuth === "string" && doc.DeviceAuth.length > 0) {
		out.deviceAuth = doc.DeviceAuth;
	}
	if (typeof doc.TunerCount === "number" && Number.isFinite(doc.TunerCount)) {
		out.tunerCount = doc.TunerCount;
	}
	return out;
}

interface RawLineupStatus {
	ScanInProgress?: unknown;
	ScanPossible?: unknown;
	Source?: unknown;
	SourceList?: unknown;
}

/**
 * Parse the snippet of HTML that `tuner<N>/Status` returns. The endpoint is a
 * fixed-format key/value page (`Tuner: 0\nChannel: ...`). We only need to
 * know whether the tuner is in use, which is true whenever `Channel:` is set
 * to anything other than `none`.
 */
function parseTunerStatusHtml(html: string): {
	inUse: boolean;
	channel?: string;
	target?: string;
	lock?: string;
	signalStrengthPercent?: number;
	signalQualityPercent?: number;
	symbolQualityPercent?: number;
	networkRateMbps?: number;
} {
	const text = html.replace(/<[^>]+>/g, " ");
	const get = (label: string): string | undefined => {
		const re = new RegExp(`${label}\\s*:\\s*([^\\n\\r<]+)`, "i");
		const match = text.match(re);
		if (!match || !match[1]) {
			return undefined;
		}
		return match[1].trim();
	};
	const channel = get("Channel");
	const target = get("Target");
	const lock = get("Lock");
	const normalized = channel?.toLowerCase();
	const inUse =
		!!channel &&
		normalized !== "none" &&
		normalized !== "" &&
		normalized !== "0";
	const out: {
		inUse: boolean;
		channel?: string;
		target?: string;
		lock?: string;
		signalStrengthPercent?: number;
		signalQualityPercent?: number;
		symbolQualityPercent?: number;
		networkRateMbps?: number;
	} = { inUse };
	if (channel) out.channel = channel;
	if (target) out.target = target;
	if (lock) out.lock = lock;
	const signalStrength = parseStatusPercent(get("Signal Strength"));
	const signalQuality = parseStatusPercent(get("Signal Quality"));
	const symbolQuality = parseStatusPercent(get("Symbol Quality"));
	const networkRate = parseStatusNumber(get("Network Rate"));
	if (signalStrength !== undefined) out.signalStrengthPercent = signalStrength;
	if (signalQuality !== undefined) out.signalQualityPercent = signalQuality;
	if (symbolQuality !== undefined) out.symbolQualityPercent = symbolQuality;
	if (networkRate !== undefined) out.networkRateMbps = networkRate;
	return out;
}

/** HDHomeRun commonly reports a raw value followed by the useful percentage. */
function parseStatusPercent(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parenthesized = value.match(/\(([\d.]+)%\)/)?.[1];
	const plain = value.match(/([\d.]+)%/)?.[1];
	const parsed = Number(parenthesized ?? plain);
	return Number.isFinite(parsed)
		? Math.min(100, Math.max(0, parsed))
		: undefined;
}

/** Pulls the first numeric value from fields such as `19.2 Mbps`. */
function parseStatusNumber(value: string | undefined): number | undefined {
	const parsed = Number(value?.match(/[\d.]+/)?.[0]);
	return Number.isFinite(parsed) ? parsed : undefined;
}

interface CachedLineup {
	expiresAt: number;
	channels: TunerLineupChannel[];
}

/**
 * HDHomeRun network tuner provider. Talks to the public HTTP API documented
 * at https://info.hdhomerun.com/info/http_api . All network calls share a
 * single timeout + retry/backoff policy; the lineup is cached in memory so
 * repeated callers don't hammer the device between scheduled refreshes.
 */
export class HdhomerunProvider implements TunerProvider {
	readonly kind = "hdhomerun" as const;
	readonly id: string;
	private readonly base: URL;
	private readonly streamHostname: string;
	private readonly options: ResolvedOptions;
	private readonly http: HttpHelper;
	private cachedLineup: CachedLineup | undefined;

	constructor(row: Tuner, options: HdhomerunProviderOptions = {}) {
		const config = hdhomerunConfigSchema.parse(row.config);
		this.id = row.id;
		this.base = normalizeBaseUrl(config.host);
		this.streamHostname = this.base.hostname;
		this.options = resolveOptions(options);
		this.http = makeHttp(this.options);
	}

	getCapabilities(): TunerCapabilities {
		// HDHomeRun EXTEND/PRIME devices support transcoding; we leave the actual
		// probe (via `discover.json`'s `Legacy`/`SupportsTranscode`) to a later
		// refinement and assume the common case.
		return { supportsTranscoding: true, concurrentStreams: 2 };
	}

	/**
	 * Returns the lineup, hitting the device at most once per `lineupTtlMs`.
	 * Use {@link refreshLineup} to force a refresh on the next call.
	 */
	async getLineup(): Promise<TunerLineupChannel[]> {
		const now = this.options.clock.now();
		if (this.cachedLineup && this.cachedLineup.expiresAt > now) {
			return this.cachedLineup.channels;
		}
		const url = new URL("lineup.json", this.base).toString();
		const raw = await this.http.json(url);
		const channels = parseLineup(raw);
		this.cachedLineup = {
			channels,
			expiresAt: now + this.options.lineupTtlMs
		};
		return channels;
	}

	/**
	 * Resolves the cloud guide URL with the DeviceAuth currently advertised by
	 * the tuner. DeviceAuth rotates frequently, so this intentionally bypasses
	 * caches and reads discover.json for every guide refresh.
	 */
	async getGuideUrl(): Promise<string> {
		const raw = await this.http.json(
			new URL("discover.json", this.base).toString()
		);
		const { deviceAuth } = parseDiscoverDocument(raw);
		if (!deviceAuth) {
			throw new Error(
				"HDHomeRun did not provide a DeviceAuth token for guide access"
			);
		}
		const guideUrl = new URL(DEFAULT_GUIDE_URL);
		guideUrl.searchParams.set("DeviceAuth", deviceAuth);
		return guideUrl.toString();
	}

	/** Drop the cached lineup so the next `getLineup()` re-fetches. */
	refreshLineup(): void {
		this.cachedLineup = undefined;
	}

	/** Backward-compatible alias retained for provider consumers. */
	invalidateLineupCache(): void {
		this.refreshLineup();
	}

	/**
	 * Build the playable stream URL for a channel. HDHomeRun serves streams on
	 * port 5004 regardless of the HTTP API port, which is why we rebuild the
	 * URL from the hostname rather than reusing `this.base`.
	 *
	 * Profile suffixes (e.g. `mobile`, `heavy`, `internet540`) are passed via
	 * `?transcode=<preset>`. They only take effect when both `transcode: true`
	 * and a `preset` are supplied; otherwise the device serves its native feed.
	 */
	async getStreamUrl(
		channelId: string,
		options?: TunerStreamOptions
	): Promise<TunerStreamUrl> {
		if (!channelId) {
			throw new Error("channelId is required");
		}
		const stream = new URL(
			`/auto/v${encodeURIComponent(channelId)}`,
			`http://${this.streamHostname}:5004`
		);
		if (options?.transcode && options.preset) {
			stream.searchParams.set("transcode", options.preset);
		}
		return { url: stream.toString() };
	}

	/**
	 * Probe the device. We hit `lineup_status.json` for liveness/scan info and
	 * each `tuner<N>/Status` page to surface in-use details. A failure on the
	 * status endpoint marks the tuner offline; per-tuner status failures are
	 * tolerated so a single broken tuner doesn't hide the rest.
	 */
	async getStatus(): Promise<TunerStatus> {
		const checkedAt = new Date(this.options.clock.now()).toISOString();
		let raw: unknown;
		try {
			raw = await this.http.json(
				new URL("lineup_status.json", this.base).toString()
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { online: false, message, checkedAt };
		}
		const status = (raw ?? {}) as RawLineupStatus;
		const messages: string[] = [];
		if (status.ScanInProgress === 1 || status.ScanInProgress === "1") {
			messages.push("Channel scan in progress");
		}
		if (typeof status.Source === "string" && status.Source.length > 0) {
			messages.push(`Source: ${status.Source}`);
		}

		// Best-effort tuner enumeration. We try tuner0..3 (the largest current
		// SKU has 4) and stop on the first failure that isn't a 404; any /Status
		// 404 simply means that tuner index doesn't exist on this model.
		const tunerCount = await this.probeTunerCount();
		const inUse: number[] = [];
		for (let i = 0; i < tunerCount; i++) {
			try {
				const html = await this.http.text(tunerStatusUrl(this.base, i));
				const parsed = parseTunerStatusHtml(html);
				if (parsed.inUse) {
					inUse.push(i);
				}
			} catch {
				// Per-tuner failures are non-fatal: we still consider the device
				// online if the lineup_status call succeeded.
			}
		}
		if (inUse.length > 0) {
			messages.push(`Tuners in use: ${inUse.join(", ")}`);
		}

		const result: TunerStatus = { online: true, checkedAt };
		if (messages.length > 0) {
			result.message = messages.join("; ");
		}
		return result;
	}

	/** Return RF measurements only while this device is tuned to the channel. */
	async getChannelQuality(
		channelNumber: string
	): Promise<TunerChannelQuality | null> {
		const tunerCount = await this.probeTunerCount();
		for (let index = 0; index < tunerCount; index++) {
			try {
				const html = await this.http.text(tunerStatusUrl(this.base, index));
				const status = parseTunerStatusHtml(html);
				if (!status.inUse || !matchesChannel(status.channel, channelNumber)) {
					continue;
				}
				return {
					tunerIndex: index,
					...(status.lock ? { lock: status.lock } : {}),
					...(status.signalStrengthPercent !== undefined
						? { signalStrengthPercent: status.signalStrengthPercent }
						: {}),
					...(status.signalQualityPercent !== undefined
						? { signalQualityPercent: status.signalQualityPercent }
						: {}),
					...(status.symbolQualityPercent !== undefined
						? { symbolQualityPercent: status.symbolQualityPercent }
						: {}),
					...(status.networkRateMbps !== undefined
						? { networkRateMbps: status.networkRateMbps }
						: {})
				};
			} catch {
				// A busy or older tuner may omit status pages; keep probing siblings.
			}
		}
		return null;
	}

	private async probeTunerCount(): Promise<number> {
		// Cheap heuristic: hit `discover.json` once per status call to read
		// TunerCount. If that fails, fall back to probing 4 tuners (largest
		// current model). The cost is one extra HTTP request, well within the
		// 5s status budget.
		try {
			const raw = await this.http.json(
				new URL("discover.json", this.base).toString()
			);
			const parsed = parseDiscoverDocument(raw);
			if (typeof parsed.tunerCount === "number" && parsed.tunerCount > 0) {
				return parsed.tunerCount;
			}
		} catch {
			// fall through
		}
		return 4;
	}
}

/** Status values use forms such as `auto:5.1` and `8vsb:7`. */
function matchesChannel(statusChannel: string | undefined, number: string) {
	if (!statusChannel) return false;
	return statusChannel === number || statusChannel.endsWith(`:${number}`);
}

/**
 * Build an `hdhomerunFactory` instance with the supplied dependencies. The
 * default export wraps this with production defaults; tests construct a
 * factory with a stub fetch to avoid touching the network.
 */
export function createHdhomerunFactory(
	options: HdhomerunFactoryOptions = {}
): TunerProviderFactory {
	const cloudUrl = options.cloudDiscoveryUrl ?? DEFAULT_CLOUD_DISCOVERY_URL;
	return {
		kind: "hdhomerun",
		create(row) {
			return new HdhomerunProvider(row, options);
		},
		async discover(): Promise<TunerDiscoveryResult[]> {
			const resolved = resolveOptions(options);
			const http = makeHttp(resolved);
			let cloudResults: unknown;
			try {
				cloudResults = await http.json(cloudUrl);
			} catch {
				// Discovery is opportunistic; return nothing rather than failing the
				// whole sweep when the cloud endpoint or LAN is unreachable.
				return [];
			}
			if (!Array.isArray(cloudResults)) {
				return [];
			}

			const results: TunerDiscoveryResult[] = [];
			for (const entry of cloudResults) {
				const candidate = parseDiscoverDocument(entry);
				const baseURL =
					candidate.baseURL ??
					(candidate.localIP ? `http://${candidate.localIP}` : undefined);
				if (!baseURL) {
					continue;
				}
				// Best-effort enrich via the device's discover.json so we get the
				// friendly name + final tuner count even when the cloud entry is
				// sparse. Failures keep the cloud-derived candidate.
				let friendlyName = candidate.friendlyName;
				let deviceId = candidate.deviceId;
				try {
					const detail = parseDiscoverDocument(
						await http.json(new URL("discover.json", baseURL).toString())
					);
					friendlyName = detail.friendlyName ?? friendlyName;
					deviceId = detail.deviceId ?? deviceId;
				} catch {
					// ignore – fall back to whatever the cloud gave us
				}

				const config: { host: string; deviceId?: string } = { host: baseURL };
				if (deviceId) {
					config.deviceId = deviceId;
				}
				results.push({
					kind: "hdhomerun",
					name: friendlyName ?? deviceId ?? baseURL,
					config
				});
			}
			return results;
		}
	};
}

/**
 * Default factory wired with the global `fetch` and the public HDHomeRun
 * cloud discovery endpoint. Production code uses this; tests prefer
 * {@link createHdhomerunFactory} so they can inject a stub fetch.
 */
export const hdhomerunFactory: TunerProviderFactory = createHdhomerunFactory();
