/**
 * Streaming parser for extended M3U / M3U8 playlists in the format produced
 * by IPTV providers. Designed for very large lists (10k+ entries) so it
 * accepts an `AsyncIterable<string>` of bytes/chunks rather than buffering
 * the whole document into memory.
 *
 * Recognised directives:
 *   #EXTM3U                      – optional header
 *   #EXTINF:<duration>,<title>   – channel metadata, optionally preceded by
 *                                  ` key="value"` attribute pairs
 *   #EXTVLCOPT:http-*=<value>    – supported per-entry HTTP request metadata
 *
 * Recognised `#EXTINF` attributes (case-insensitive):
 *   tvg-id, tvg-name, tvg-logo, group-title, channel-id, user-agent,
 *   http-user-agent, referrer, referer, http-referrer, origin, http-origin
 *
 * Anything we don't understand (other `#EXTVLCOPT`, `#EXT-X-…` tags, blank
 * lines, comments) is ignored. Malformed entries (e.g. an `#EXTINF` with
 * no following URL, or a URL without a recognised scheme) are skipped and
 * surfaced via the optional `onWarn` callback so callers can log them.
 */
import type { TunerHttpHeaders } from "@signalhaven/shared";

export interface ParsedM3uChannel {
	/** The playable URL exposed by the playlist for this entry. */
	url: string;
	/** Raw display title from the EXTINF line (after the comma). */
	title: string;
	/** `tvg-id` attribute, when present. */
	tvgId?: string;
	/** `tvg-name` attribute, when present. */
	tvgName?: string;
	/** `tvg-logo` URL attribute, when present. */
	tvgLogo?: string;
	/** `group-title` attribute, when present. */
	groupTitle?: string;
	/** Optional explicit `channel-id` attribute. */
	channelId?: string;
	/** Supported request headers required by this entry's upstream. */
	httpHeaders?: TunerHttpHeaders;
}

export interface ParseM3uOptions {
	/** Invoked once per skipped/malformed entry with a human-readable reason. */
	onWarn?: (message: string) => void;
}

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MAX_HEADER_VALUE_LENGTH = 4096;

/** Locate the title separator without mistaking commas inside quoted values. */
function findUnquotedComma(value: string): number {
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === '"') quoted = !quoted;
		if (value[index] === "," && !quoted) return index;
	}
	return -1;
}

/**
 * Parse the prefix that follows `#EXTINF:` — `<duration>[ key="v" ...],<title>`.
 * Duration is allowed to be `-1` or any decimal; we don't currently expose it.
 */
function parseExtinf(line: string): {
	attrs: Record<string, string>;
	title: string;
} | null {
	const trimmed = line.slice("#EXTINF:".length).trim();
	if (trimmed.length === 0) {
		return null;
	}
	const commaIdx = findUnquotedComma(trimmed);
	const head = commaIdx === -1 ? trimmed : trimmed.slice(0, commaIdx);
	const title = commaIdx === -1 ? "" : trimmed.slice(commaIdx + 1).trim();

	// Duration (and the optional whitespace before the first attribute) is
	// ignored; we only need the attributes + the title.
	const attrs: Record<string, string> = {};
	let match: RegExpExecArray | null;
	ATTR_RE.lastIndex = 0;
	while ((match = ATTR_RE.exec(head)) !== null) {
		const [, key, value] = match;
		if (key && value !== undefined) {
			attrs[key.toLowerCase()] = value;
		}
	}
	return { attrs, title };
}

/** Map common M3U header spellings into the provider-neutral stream shape. */
function headersFromAttributes(
	attrs: Record<string, string>
): TunerHttpHeaders {
	const headers: TunerHttpHeaders = {};
	const userAgent = attrs["user-agent"] ?? attrs["http-user-agent"];
	const referer =
		attrs["referrer"] ?? attrs["referer"] ?? attrs["http-referrer"];
	const origin = attrs["origin"] ?? attrs["http-origin"];
	if (isSafeHeaderValue(userAgent)) headers.userAgent = userAgent;
	if (isSafeHeaderValue(referer)) headers.referer = referer;
	if (isSafeHeaderValue(origin)) headers.origin = origin;
	return headers;
}

/** Reject line breaks so playlist metadata cannot inject additional headers. */
function isSafeHeaderValue(value: string | undefined): value is string {
	return (
		value !== undefined &&
		value.length > 0 &&
		value.length <= MAX_HEADER_VALUE_LENGTH &&
		!/[\r\n]/.test(value)
	);
}

/** Apply a supported EXTVLCOPT directive to the pending entry. */
function applyHeaderDirective(
	line: string,
	headers: TunerHttpHeaders
): boolean {
	const match =
		/^#EXTVLCOPT:(http-user-agent|http-referrer|http-origin)=(.*)$/i.exec(line);
	if (!match) return false;
	const key = match[1]?.toLowerCase();
	const value = match[2]?.trim();
	if (!isSafeHeaderValue(value)) return true;
	if (key === "http-user-agent") headers.userAgent = value;
	if (key === "http-referrer") headers.referer = value;
	if (key === "http-origin") headers.origin = value;
	return true;
}

/**
 * Parse a single line into either a directive or a URL. Empty lines and
 * comments (anything starting with `#` that isn't a recognised directive)
 * are skipped silently.
 */
async function* iterateChannels(
	lines: AsyncIterable<string>,
	options: ParseM3uOptions
): AsyncGenerator<ParsedM3uChannel> {
	let pendingExtinf: {
		attrs: Record<string, string>;
		title: string;
		httpHeaders: TunerHttpHeaders;
	} | null = null;
	let lineNumber = 0;
	for await (const raw of lines) {
		lineNumber += 1;
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith("#EXTINF:")) {
			if (pendingExtinf) {
				options.onWarn?.(
					`Line ${lineNumber}: dropping previous #EXTINF with no URL`
				);
			}
			const parsed = parseExtinf(line);
			if (!parsed) {
				options.onWarn?.(`Line ${lineNumber}: malformed #EXTINF`);
				pendingExtinf = null;
				continue;
			}
			pendingExtinf = {
				...parsed,
				httpHeaders: headersFromAttributes(parsed.attrs)
			};
			continue;
		}
		if (line.startsWith("#")) {
			if (
				pendingExtinf &&
				applyHeaderDirective(line, pendingExtinf.httpHeaders)
			) {
				continue;
			}
			// Other directives (#EXTM3U, #EXTVLCOPT, #EXT-X-…) and comments are
			// ignored; they don't pair with a URL on the next line.
			continue;
		}
		// Non-comment line: a URL.
		if (!URL_SCHEME_RE.test(line)) {
			options.onWarn?.(
				`Line ${lineNumber}: ignoring entry with unsupported URL scheme: ${line}`
			);
			pendingExtinf = null;
			continue;
		}
		const meta = pendingExtinf;
		pendingExtinf = null;
		const channel: ParsedM3uChannel = {
			url: line,
			title: meta?.title ?? line
		};
		const attrs = meta?.attrs ?? {};
		if (attrs["tvg-id"]) channel.tvgId = attrs["tvg-id"];
		if (attrs["tvg-name"]) channel.tvgName = attrs["tvg-name"];
		if (attrs["tvg-logo"]) channel.tvgLogo = attrs["tvg-logo"];
		if (attrs["group-title"]) channel.groupTitle = attrs["group-title"];
		if (attrs["channel-id"]) channel.channelId = attrs["channel-id"];
		if (meta && Object.keys(meta.httpHeaders).length > 0) {
			channel.httpHeaders = meta.httpHeaders;
		}
		yield channel;
	}
	if (pendingExtinf) {
		options.onWarn?.(`End of playlist: trailing #EXTINF with no URL`);
	}
}

/**
 * Streaming entry point. `lines` is consumed once; the returned generator
 * yields parsed channels in playlist order. Use {@link linesFromChunks} to
 * adapt a `ReadableStream<Uint8Array>` (e.g. `fetch().body`) into the
 * expected line iterable.
 */
export function parseM3uLines(
	lines: AsyncIterable<string>,
	options: ParseM3uOptions = {}
): AsyncGenerator<ParsedM3uChannel> {
	return iterateChannels(lines, options);
}

/**
 * Convenience wrapper that parses a complete in-memory M3U string. Intended
 * for unit tests and small playlists; production code paths should use
 * {@link parseM3uLines} with a streamed body.
 */
export async function parseM3uText(
	text: string,
	options: ParseM3uOptions = {}
): Promise<ParsedM3uChannel[]> {
	const lines = stringToLines(text);
	const out: ParsedM3uChannel[] = [];
	for await (const channel of parseM3uLines(lines, options)) {
		out.push(channel);
	}
	return out;
}

async function* stringToLines(text: string): AsyncGenerator<string> {
	// Normalise CRLF / CR to LF before splitting so Windows-encoded playlists
	// parse identically to Unix-encoded ones.
	const normalised = text.replace(/\r\n?/g, "\n");
	for (const line of normalised.split("\n")) {
		yield line;
	}
}

/**
 * Adapt a chunked byte stream (Web `ReadableStream<Uint8Array>` or any async
 * iterable of `Uint8Array`) into an async iterable of decoded text lines.
 * Decoding is incremental so multi-byte UTF-8 sequences split across chunks
 * are handled correctly, and we never accumulate more than the current
 * partial line in memory.
 */
export async function* linesFromChunks(
	source:
		| AsyncIterable<Uint8Array>
		| {
				getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
		  }
): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8");
	let buffer = "";

	const iterable = isAsyncIterable<Uint8Array>(source)
		? source
		: readerToAsyncIterable(source.getReader());

	for await (const chunk of iterable) {
		buffer += decoder.decode(chunk, { stream: true });
		let newlineIdx: number;
		while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIdx);
			buffer = buffer.slice(newlineIdx + 1);
			yield line.endsWith("\r") ? line.slice(0, -1) : line;
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) {
		yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
	}
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	return (
		typeof value === "object" &&
		value !== null &&
		Symbol.asyncIterator in (value as Record<symbol, unknown>)
	);
}

async function* readerToAsyncIterable(reader: {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}): AsyncGenerator<Uint8Array> {
	while (true) {
		const { done, value } = await reader.read();
		if (done) return;
		if (value) yield value;
	}
}
