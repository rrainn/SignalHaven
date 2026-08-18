import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

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
	fetch?: RemoteImageFetch;
	maxBytes?: number;
	maxCacheBytes?: number;
	maxConcurrent?: number;
	negativeTtlMs?: number;
	ttlMs?: number;
	requestTimeoutMs?: number;
	maxEntries?: number;
	now?: () => number;
	logger?: RemoteImageProxyLogger;
	/** Test seam for hostname safety checks. */
	resolveHost?: (hostname: string) => Promise<string[]>;
}

/** Transport receives validated addresses so it cannot re-resolve the host. */
export type RemoteImageFetch = (
	url: URL,
	options: {
		signal: AbortSignal;
		redirect: "manual";
		addresses: readonly string[];
	}
) => Promise<Response>;

interface CachedImage extends ProxiedImage {
	expiresAt: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

/**
 * Fetches provider images behind a bounded, shared cache so the browser never
 * needs to request a provider URL directly.
 */
export class RemoteImageProxy {
	private readonly fetch: RemoteImageFetch;
	private readonly maxBytes: number;
	private readonly ttlMs: number;
	private readonly requestTimeoutMs: number;
	private readonly maxEntries: number;
	private readonly maxCacheBytes: number;
	private readonly maxConcurrent: number;
	private readonly negativeTtlMs: number;
	private readonly now: () => number;
	private readonly logger: RemoteImageProxyLogger | undefined;
	private readonly resolveHost: (hostname: string) => Promise<string[]>;
	private readonly cache = new Map<string, CachedImage>();
	private readonly inFlight = new Map<string, Promise<ProxiedImage | null>>();
	private readonly negativeCache = new Map<string, number>();
	private cachedBytes = 0;

	constructor(options: RemoteImageProxyOptions = {}) {
		this.fetch = options.fetch ?? fetchPinnedRemoteImage;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
		this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
		this.now = options.now ?? Date.now;
		this.logger = options.logger;
		this.resolveHost = options.resolveHost ?? resolveHostAddresses;
	}

	/** Fetch and validate an image without exposing its remote URL to callers. */
	async get(ownerKey: string, source: string): Promise<ProxiedImage | null> {
		const url = parseRemoteImageUrl(source);
		if (!url) return null;

		const cacheKey = `${ownerKey}\n${url.href}`;
		const negativeExpiry = this.negativeCache.get(cacheKey);
		if (negativeExpiry && negativeExpiry > this.now()) return null;
		if (negativeExpiry) this.negativeCache.delete(cacheKey);
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > this.now()) return cached;
		if (cached) this.deleteCached(cacheKey, cached);

		const activeRequest = this.inFlight.get(cacheKey);
		if (activeRequest) return activeRequest;
		if (this.inFlight.size >= this.maxConcurrent) {
			this.warn(ownerKey, url, "Remote image concurrency limit reached");
			return null;
		}

		const request = this.fetchAndCache(cacheKey, ownerKey, url);
		this.inFlight.set(cacheKey, request);
		try {
			const result = await request;
			if (!result) this.rememberFailure(cacheKey);
			return result;
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
				!contentType ||
				!ALLOWED_RASTER_TYPES.has(contentType) ||
				(Number.isFinite(contentLength) && contentLength > this.maxBytes)
			) {
				await response.body?.cancel();
				this.warn(ownerKey, url, "Remote image response was rejected", {
					status: response.status
				});
				return null;
			}

			const body = await readBoundedBody(response, this.maxBytes);
			if (!body || !matchesRasterSignature(contentType, body)) {
				this.warn(ownerKey, url, "Remote image body was rejected");
				return null;
			}
			const image: CachedImage = {
				body,
				contentType,
				cacheMaxAgeSeconds: Math.floor(this.ttlMs / 1000),
				expiresAt: this.now() + this.ttlMs
			};
			this.cache.set(cacheKey, image);
			this.cachedBytes += body.byteLength;
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
			const addresses = await resolvePublicAddresses(url, this.resolveHost);
			if (!addresses) {
				this.warn(ownerKey, url, "Remote image host was rejected");
				return null;
			}
			const response = await this.fetch(url, {
				signal,
				redirect: "manual",
				addresses
			});
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
		while (
			this.cache.size > this.maxEntries ||
			this.cachedBytes > this.maxCacheBytes
		) {
			const oldest = this.cache.entries().next().value as
				| [string, CachedImage]
				| undefined;
			if (!oldest) break;
			this.deleteCached(oldest[0], oldest[1]);
		}
	}

	/** Avoid repeatedly refetching broken provider URLs within a short window. */
	private rememberFailure(cacheKey: string): void {
		this.negativeCache.set(cacheKey, this.now() + this.negativeTtlMs);
		while (this.negativeCache.size > this.maxEntries) {
			const oldest = this.negativeCache.keys().next().value as string | undefined;
			if (!oldest) break;
			this.negativeCache.delete(oldest);
		}
	}

	/** Keep the byte accounting and map mutation inseparable. */
	private deleteCached(key: string, image: CachedImage): void {
		if (!this.cache.delete(key)) return;
		this.cachedBytes = Math.max(0, this.cachedBytes - image.body.byteLength);
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
async function resolvePublicAddresses(
	url: URL,
	resolveHost: (hostname: string) => Promise<string[]>
): Promise<string[] | null> {
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
	const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
	return addresses.length > 0 && addresses.every(isPublicAddress)
		? addresses
		: null;
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

const ALLOWED_RASTER_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif"
]);

/** Verify the declared raster type before bytes enter a browser-visible cache. */
function matchesRasterSignature(contentType: string, body: Buffer): boolean {
	if (contentType === "image/png") {
		return body
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	}
	if (contentType === "image/jpeg") {
		return (
			body.length >= 3 &&
			body[0] === 0xff &&
			body[1] === 0xd8 &&
			body[2] === 0xff
		);
	}
	if (contentType === "image/gif") {
		const signature = body.subarray(0, 6).toString("ascii");
		return signature === "GIF87a" || signature === "GIF89a";
	}
	if (contentType === "image/webp") {
		return (
			body.subarray(0, 4).toString("ascii") === "RIFF" &&
			body.subarray(8, 12).toString("ascii") === "WEBP"
		);
	}
	if (contentType === "image/avif") {
		return (
			body.subarray(4, 8).toString("ascii") === "ftyp" &&
			["avif", "avis"].includes(body.subarray(8, 12).toString("ascii"))
		);
	}
	return false;
}

/** Connect to one prevalidated address while retaining Host and TLS identity. */
async function fetchPinnedRemoteImage(
	url: URL,
	options: {
		signal: AbortSignal;
		redirect: "manual";
		addresses: readonly string[];
	}
): Promise<Response> {
	const address = options.addresses[0];
	if (!address) throw new Error("No validated remote address");
	return new Promise<Response>((resolve, reject) => {
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method: "GET",
				lookup: (_hostname, _lookupOptions, callback) => {
					callback(null, address, isIP(address));
				},
				...(url.protocol === "https:" ? { servername: url.hostname } : {})
			},
			(response) => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					if (Array.isArray(value)) {
						for (const item of value) headers.append(name, item);
					} else if (value !== undefined) {
						headers.set(name, String(value));
					}
				}
				const status = response.statusCode ?? 500;
				const body =
					status === 204 || status === 304
						? null
						: (Readable.toWeb(response) as ReadableStream<Uint8Array>);
				resolve(new Response(body, { status, headers }));
			}
		);
		const abort = (): void => {
			request.destroy(new Error("Request aborted"));
		};
		options.signal.addEventListener("abort", abort, { once: true });
		request.once("close", () => {
			options.signal.removeEventListener("abort", abort);
		});
		request.once("error", reject);
		request.end();
	});
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
