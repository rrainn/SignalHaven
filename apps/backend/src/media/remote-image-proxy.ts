import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Image payload returned by a backend-owned remote image request. */
export interface ProxiedImage {
	body: Buffer;
	contentType: string;
	cacheMaxAgeSeconds: number;
}

interface RemoteImageProxyLogger {
	warn(context: Record<string, unknown>, message: string): void;
}

export interface RemoteImageProxyOptions {
	/** Test seam for deterministic provider responses. */
	fetch?: typeof globalThis.fetch;
	maxBytes?: number;
	ttlMs?: number;
	requestTimeoutMs?: number;
	maxEntries?: number;
	now?: () => number;
	logger?: RemoteImageProxyLogger;
	/** Test seam for hostname safety checks. */
	resolveHost?: (hostname: string) => Promise<string[]>;
}

interface CachedImage extends ProxiedImage {
	expiresAt: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 256;

/**
 * Fetches provider images behind a bounded, shared cache so the browser never
 * needs to request a provider URL directly.
 */
export class RemoteImageProxy {
	private readonly fetch: typeof globalThis.fetch;
	private readonly maxBytes: number;
	private readonly ttlMs: number;
	private readonly requestTimeoutMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;
	private readonly logger: RemoteImageProxyLogger | undefined;
	private readonly resolveHost: (hostname: string) => Promise<string[]>;
	private readonly cache = new Map<string, CachedImage>();
	private readonly inFlight = new Map<string, Promise<ProxiedImage | null>>();

	constructor(options: RemoteImageProxyOptions = {}) {
		this.fetch = options.fetch ?? globalThis.fetch;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? Date.now;
		this.logger = options.logger;
		this.resolveHost = options.resolveHost ?? resolveHostAddresses;
	}

	/** Fetch and validate an image without exposing its remote URL to callers. */
	async get(ownerKey: string, source: string): Promise<ProxiedImage | null> {
		const url = parseRemoteImageUrl(source);
		if (!url) return null;

		const cacheKey = `${ownerKey}\n${url.href}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > this.now()) return cached;
		if (cached) this.cache.delete(cacheKey);

		const activeRequest = this.inFlight.get(cacheKey);
		if (activeRequest) return activeRequest;

		const request = this.fetchAndCache(cacheKey, ownerKey, url);
		this.inFlight.set(cacheKey, request);
		try {
			return await request;
		} finally {
			this.inFlight.delete(cacheKey);
		}
	}

	/** Apply response limits while the body streams to avoid oversized buffers. */
	private async fetchAndCache(
		cacheKey: string,
		ownerKey: string,
		url: URL
	): Promise<ProxiedImage | null> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		try {
			const fetched = await this.fetchWithSafeRedirects(
				ownerKey,
				url,
				controller.signal
			);
			if (!fetched) return null;
			const { response } = fetched;
			const contentType = response.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase();
			const contentLength = Number(response.headers.get("content-length"));
			if (
				!response.ok ||
				!contentType?.startsWith("image/") ||
				(Number.isFinite(contentLength) && contentLength > this.maxBytes)
			) {
				await response.body?.cancel();
				this.warn(ownerKey, url, "Remote image response was rejected", {
					status: response.status
				});
				return null;
			}

			const body = await readBoundedBody(response, this.maxBytes);
			if (!body) {
				this.warn(ownerKey, url, "Remote image exceeded the size limit");
				return null;
			}
			const image: CachedImage = {
				body,
				contentType,
				cacheMaxAgeSeconds: Math.floor(this.ttlMs / 1000),
				expiresAt: this.now() + this.ttlMs
			};
			this.cache.set(cacheKey, image);
			this.trimCache();
			return image;
		} catch (error) {
			this.warn(ownerKey, url, "Remote image request failed", {
				error: error instanceof Error ? error.name : "unknown"
			});
			return null;
		} finally {
			clearTimeout(timeout);
		}
	}

	/** Follow a small redirect chain while validating every target first. */
	private async fetchWithSafeRedirects(
		ownerKey: string,
		initialUrl: URL,
		signal: AbortSignal
	): Promise<{ response: Response; finalUrl: URL } | null> {
		let url = initialUrl;
		for (let redirects = 0; redirects <= 3; redirects += 1) {
			if (!(await isPublicRemoteUrl(url, this.resolveHost))) {
				this.warn(ownerKey, url, "Remote image host was rejected");
				return null;
			}
			const response = await this.fetch(url, { signal, redirect: "manual" });
			if (response.status < 300 || response.status >= 400) {
				return { response, finalUrl: url };
			}

			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location || redirects === 3) {
				this.warn(ownerKey, url, "Remote image redirect was rejected");
				return null;
			}
			const redirectUrl = parseRemoteImageUrl(new URL(location, url).href);
			if (!redirectUrl) {
				this.warn(ownerKey, url, "Remote image redirect URL was rejected");
				return null;
			}
			url = redirectUrl;
		}
		return null;
	}

	/** Keep cache ownership explicit and memory usage bounded. */
	private trimCache(): void {
		while (this.cache.size > this.maxEntries) {
			const oldest = this.cache.keys().next().value as string | undefined;
			if (!oldest) break;
			this.cache.delete(oldest);
		}
	}

	/** Log only a host and owner key so signed provider URLs remain private. */
	private warn(
		ownerKey: string,
		url: URL,
		message: string,
		extra: Record<string, unknown> = {}
	): void {
		this.logger?.warn({ ownerKey, host: url.host, ...extra }, message);
	}
}

/** Only HTTP(S) URLs without embedded credentials may cross this boundary. */
function parseRemoteImageUrl(source: string): URL | null {
	try {
		const url = new URL(source);
		if (!["http:", "https:"].includes(url.protocol)) return null;
		if (url.username || url.password) return null;
		return url;
	} catch {
		return null;
	}
}

/** Resolve every address and reject hosts that can reach local infrastructure. */
async function isPublicRemoteUrl(
	url: URL,
	resolveHost: (hostname: string) => Promise<string[]>
): Promise<boolean> {
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
	const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
	return addresses.length > 0 && addresses.every(isPublicAddress);
}

/** Resolve all records so a mixed public/private hostname is also rejected. */
async function resolveHostAddresses(hostname: string): Promise<string[]> {
	const records = await lookup(hostname, { all: true, verbatim: true });
	return records.map((record) => record.address);
}

/** Cover private, loopback, link-local, multicast, and unspecified ranges. */
function isPublicAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a = 0, b = 0] = address.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	if (isIP(address) === 6) {
		const normalized = address.toLowerCase();
		if (normalized.startsWith("::ffff:")) {
			return isPublicAddress(normalized.slice("::ffff:".length));
		}
		return !(
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith("ff")
		);
	}
	return false;
}

/** Consume a web stream while enforcing the configured byte ceiling. */
async function readBoundedBody(
	response: Response,
	maxBytes: number
): Promise<Buffer | null> {
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let result = await reader.read();
	while (!result.done) {
		size += result.value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(result.value);
		result = await reader.read();
	}
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		size
	);
}
