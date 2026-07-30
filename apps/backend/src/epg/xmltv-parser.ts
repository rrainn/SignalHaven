/**
 * Streaming XMLTV parser + Postgres importer.
 *
 * XMLTV (https://wiki.xmltv.org/index.php/XMLTVFormat) is a simple XML
 * dialect that carries channel definitions and program (broadcast)
 * entries. Files in the wild routinely reach hundreds of MB so we never
 * materialise the whole document — instead we stream-parse with `sax`
 * and emit channels/programs incrementally to the database via COPY into
 * staging tables, then a single `INSERT … ON CONFLICT DO UPDATE` flush.
 */

import { createStream } from "sax";

/**
 * Parsed XMLTV `<channel>` element. XMLTV permits multiple display names,
 * which may include both a callsign and a tuner guide number.
 */
export interface XmltvChannel {
	externalId: string;
	displayName: string | null;
	displayNames: string[];
}

/**
 * Parsed XMLTV `<programme>` element. Times are absolute moments — we
 * compute UTC `Date`s here from the wire timestamps (which include an
 * offset like `20240101120000 -0500`) so DST transitions are handled
 * once, at parse time.
 */
export interface XmltvProgram {
	channelExternalId: string;
	start: Date;
	stop: Date;
	title: string;
	subtitle: string | null;
	description: string | null;
	episode: number | null;
	season: number | null;
	categories: string[];
	/** Stable episode identifier supplied by the guide provider when available. */
	providerEpisodeId: string | null;
	/** Durable identity used after the transient guide row is pruned. */
	episodeIdentityKey: string | null;
	/** Calendar date on which the provider says the episode first aired. */
	originalAirDate: string | null;
	/** Provider classification; unknown is intentional when the feed is silent. */
	broadcastNewness: BroadcastNewness;
	/** Evidence used to classify the broadcast for diagnostics. */
	newnessSource: BroadcastNewnessSource;
	/** Stable identifier inside the source: "channelId|startISO". */
	externalId: string;
}

/** Provider-backed broadcast classification used by series recording policies. */
export type BroadcastNewness = "new" | "rerun" | "premiere" | "unknown";

/** Stable evidence labels retained so scheduling decisions are explainable. */
export type BroadcastNewnessSource =
	| "xmltv_new"
	| "xmltv_previously_shown"
	| "xmltv_premiere"
	| "original_air_date"
	| "none";

export interface XmltvEvents {
	onChannel(channel: XmltvChannel): void | Promise<void>;
	onProgram(program: XmltvProgram): void | Promise<void>;
}

export interface ParseXmltvOptions {
	/**
	 * Fallback timezone for `<programme start="..."/>` strings that don't
	 * carry an explicit `+HHMM` / `-HHMM` offset (rare but allowed). Pass
	 * an IANA name like `"America/New_York"` or a fixed `"+00:00"` form;
	 * defaults to UTC when omitted.
	 */
	defaultTimezone?: string;
}

const XMLTV_TIME_REGEX =
	/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?$/;

/**
 * Parse an XMLTV timestamp such as `20260315023000 -0500` into a UTC
 * `Date`. Throws `RangeError` on malformed input.
 *
 * The XMLTV grammar permits an offset omitted entirely; in that case we
 * resolve via {@link resolveTimezoneOffsetMinutes} so callers can opt
 * into an IANA timezone (e.g. for feeds known to be local time).
 */
export function parseXmltvTimestamp(
	raw: string,
	defaultTimezone?: string
): Date {
	const match = XMLTV_TIME_REGEX.exec(raw.trim());
	if (!match) {
		throw new RangeError(`Invalid XMLTV timestamp: ${raw}`);
	}
	const [, y, mo, d, h, mi, s, off] = match;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const hour = Number(h);
	const minute = Number(mi);
	const second = Number(s);

	let offsetMinutes: number;
	if (off) {
		const sign = off.startsWith("-") ? -1 : 1;
		const offHour = Number(off.slice(1, 3));
		const offMin = Number(off.slice(3, 5));
		offsetMinutes = sign * (offHour * 60 + offMin);
	} else {
		offsetMinutes = resolveTimezoneOffsetMinutes(
			defaultTimezone,
			year,
			month,
			day,
			hour,
			minute,
			second
		);
	}

	// Compose as UTC then shift back by the offset to recover the absolute
	// moment. Doing it this way is DST-safe because IANA offset resolution
	// happens once for the wall-clock instant, then we just subtract.
	const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
	return new Date(utcMs - offsetMinutes * 60_000);
}

/**
 * Compute the UTC offset (minutes) for a wall-clock instant in the given
 * IANA timezone. Falls back to `0` (UTC) when no zone is supplied. Uses
 * `Intl.DateTimeFormat` so DST transitions are handled correctly without
 * pulling in a tz library.
 */
export function resolveTimezoneOffsetMinutes(
	timezone: string | undefined,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number
): number {
	if (!timezone || timezone === "UTC" || timezone === "Z") {
		return 0;
	}
	const fixedMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(timezone);
	if (fixedMatch) {
		const sign = fixedMatch[1] === "-" ? -1 : 1;
		return sign * (Number(fixedMatch[2]) * 60 + Number(fixedMatch[3]));
	}

	// Iterate towards the wall-clock instant. One pass is exact except
	// across DST boundaries; a second pass converges on the right offset.
	let utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
	for (let i = 0; i < 2; i += 1) {
		const offset = getZoneOffsetMinutes(timezone, new Date(utcGuess));
		const adjusted =
			Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000;
		if (adjusted === utcGuess) {
			return offset;
		}
		utcGuess = adjusted;
	}
	return getZoneOffsetMinutes(timezone, new Date(utcGuess));
}

function getZoneOffsetMinutes(timezone: string, when: Date): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	});
	const parts = formatter.formatToParts(when);
	const map: Record<string, number> = {};
	for (const part of parts) {
		if (part.type !== "literal") {
			map[part.type] = Number(part.value);
		}
	}
	const asUtc = Date.UTC(
		map["year"] ?? 1970,
		(map["month"] ?? 1) - 1,
		map["day"] ?? 1,
		(map["hour"] ?? 0) % 24,
		map["minute"] ?? 0,
		map["second"] ?? 0
	);
	return Math.round((asUtc - when.getTime()) / 60_000);
}

interface ProgramAccumulator {
	externalId: string;
	channelExternalId: string;
	start: Date;
	stop: Date;
	title: string | null;
	subtitle: string | null;
	description: string | null;
	episode: number | null;
	season: number | null;
	categories: string[];
	providerEpisodeId: string | null;
	originalAirDate: string | null;
	broadcastNewness: BroadcastNewness;
	newnessSource: BroadcastNewnessSource;
}

interface ChannelAccumulator {
	externalId: string;
	displayName: string | null;
	displayNames: string[];
}

/**
 * Parse an XMLTV byte stream and invoke `events` for every channel and
 * program. Resolves once the document closes; rejects on XML parse
 * errors. The caller is responsible for piping a transcoded UTF-8
 * stream — see {@link decodeStream} in `./xmltv-encoding`.
 */
export async function parseXmltvStream(
	stream: NodeJS.ReadableStream,
	events: XmltvEvents,
	options: ParseXmltvOptions = {}
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const parser = createStream(true, {
			trim: false,
			normalize: false,
			lowercase: true,
			position: false
		});

		/**
		 * Pause/resume backpressure: when an event handler returns a
		 * Promise, we pause the source until it resolves so the importer
		 * (or any other consumer) can finish a batch flush before we feed
		 * it more data. Without this, sax keeps parsing and the per-batch
		 * arrays grow unbounded — easily OOMing on multi-MB inputs.
		 */
		let currentChannel: ChannelAccumulator | null = null;
		let currentProgram: ProgramAccumulator | null = null;
		let textTarget: ((value: string) => void) | null = null;
		let textBuffer = "";
		/**
		 * Number of in-flight async event handlers. We deliberately do NOT
		 * keep references to the promises themselves (an unbounded array
		 * leaks ~1 KB per promise on multi-MB feeds); instead we resolve
		 * once the parser has finished AND no work remains in flight.
		 */
		let inFlight = 0;
		let parserEnded = false;
		let settled = false;

		const checkDone = (): void => {
			if (settled) return;
			if (parserEnded && inFlight === 0) {
				settled = true;
				resolve();
			}
		};

		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};

		const handleAsync = (work: void | Promise<void>): void => {
			if (!work || typeof (work as Promise<void>).then !== "function") {
				return;
			}
			inFlight += 1;
			// Pause is not reference-counted in Node streams: a single resume
			// unblocks the stream regardless of how many pause()s preceded it.
			// We therefore only resume once ALL outstanding work clears,
			// otherwise fast-resolving microtasks would let new data in
			// before slow batch flushes (COPY, etc.) finish — defeating the
			// backpressure entirely and OOMing on multi-MB inputs.
			stream.pause?.();
			(work as Promise<void>).then(
				() => {
					inFlight -= 1;
					if (inFlight === 0) {
						stream.resume?.();
					}
					checkDone();
				},
				(err: Error) => {
					inFlight -= 1;
					fail(err);
				}
			);
		};

		parser.on("error", (err: Error) => {
			fail(err);
		});

		parser.on("opentag", (node) => {
			const name = node.name;
			const attrs = node.attributes as Record<string, string>;
			textBuffer = "";
			textTarget = null;

			if (name === "channel") {
				currentChannel = {
					externalId: String(attrs["id"] ?? "").trim(),
					displayName: null,
					displayNames: []
				};
			} else if (name === "display-name" && currentChannel) {
				textTarget = (value) => {
					const trimmed = value.trim();
					if (!currentChannel || !trimmed) return;

					// Preserve feed order while avoiding duplicate aliases.
					if (!currentChannel.displayNames.includes(trimmed)) {
						currentChannel.displayNames.push(trimmed);
					}
					currentChannel.displayName ??= trimmed;
				};
			} else if (name === "programme") {
				const channelId = String(attrs["channel"] ?? "").trim();
				const startRaw = String(attrs["start"] ?? "");
				const stopRaw = String(attrs["stop"] ?? startRaw);
				try {
					const start = parseXmltvTimestamp(startRaw, options.defaultTimezone);
					const stop = stopRaw
						? parseXmltvTimestamp(stopRaw, options.defaultTimezone)
						: start;
					currentProgram = {
						externalId: `${channelId}|${start.toISOString()}`,
						channelExternalId: channelId,
						start,
						stop,
						title: null,
						subtitle: null,
						description: null,
						episode: null,
						season: null,
						categories: [],
						providerEpisodeId: null,
						originalAirDate: null,
						broadcastNewness: "unknown",
						newnessSource: "none"
					};
				} catch {
					// Skip programmes with bad timestamps; they would otherwise
					// poison the whole stream.
					currentProgram = null;
				}
			} else if (currentProgram) {
				if (name === "title" && currentProgram.title === null) {
					textTarget = (value) => {
						if (currentProgram) currentProgram.title = value.trim();
					};
				} else if (name === "sub-title" && currentProgram.subtitle === null) {
					textTarget = (value) => {
						if (currentProgram) {
							currentProgram.subtitle = value.trim() || null;
						}
					};
				} else if (name === "desc" && currentProgram.description === null) {
					textTarget = (value) => {
						if (currentProgram) {
							currentProgram.description = value.trim() || null;
						}
					};
				} else if (name === "category") {
					textTarget = (value) => {
						const trimmed = value.trim();
						if (currentProgram && trimmed) {
							currentProgram.categories.push(trimmed);
						}
					};
				} else if (name === "episode-num") {
					const system = (attrs["system"] ?? "").toLowerCase();
					textTarget = (value) => {
						if (!currentProgram) return;
						const trimmed = value.trim();
						applyEpisodeNum(currentProgram, system, trimmed);
						if (
							trimmed &&
							(system === "dd_progid" ||
								(currentProgram.providerEpisodeId === null &&
									system !== "" &&
									system !== "xmltv_ns" &&
									system !== "onscreen" &&
									system !== "original-air-date"))
						) {
							currentProgram.providerEpisodeId = `${system}:${trimmed}`;
						}
					};
				} else if (name === "date") {
					textTarget = (value) => {
						if (!currentProgram) return;
						currentProgram.originalAirDate = parseXmltvDate(value);
					};
				} else if (name === "new") {
					setProgramNewness(currentProgram, "new", "xmltv_new");
				} else if (name === "previously-shown") {
					setProgramNewness(currentProgram, "rerun", "xmltv_previously_shown");
				} else if (name === "premiere") {
					setProgramNewness(currentProgram, "premiere", "xmltv_premiere");
				}
			}
		});

		parser.on("text", (chunk: string) => {
			if (textTarget) {
				textBuffer += chunk;
			}
		});

		parser.on("cdata", (chunk: string) => {
			if (textTarget) {
				textBuffer += chunk;
			}
		});

		parser.on("closetag", (name: string) => {
			if (textTarget) {
				textTarget(textBuffer);
				textTarget = null;
				textBuffer = "";
			}

			if (name === "channel" && currentChannel) {
				const out: XmltvChannel = {
					externalId: currentChannel.externalId,
					displayName: currentChannel.displayName,
					displayNames: currentChannel.displayNames
				};
				currentChannel = null;
				if (out.externalId) {
					handleAsync(events.onChannel(out));
				}
			} else if (name === "programme" && currentProgram) {
				applyOriginalAirDateNewness(currentProgram);
				const program: XmltvProgram = {
					externalId: currentProgram.externalId,
					channelExternalId: currentProgram.channelExternalId,
					start: currentProgram.start,
					stop: currentProgram.stop,
					title: currentProgram.title ?? "",
					subtitle: currentProgram.subtitle,
					description: currentProgram.description,
					episode: currentProgram.episode,
					season: currentProgram.season,
					categories: currentProgram.categories,
					providerEpisodeId: currentProgram.providerEpisodeId,
					episodeIdentityKey: buildEpisodeIdentityKey(currentProgram),
					originalAirDate: currentProgram.originalAirDate,
					broadcastNewness: currentProgram.broadcastNewness,
					newnessSource: currentProgram.newnessSource
				};
				currentProgram = null;
				if (program.channelExternalId && program.title) {
					handleAsync(events.onProgram(program));
				}
			}
		});

		parser.on("end", () => {
			parserEnded = true;
			checkDone();
		});

		stream.on("error", (err) => fail(err as Error));
		stream.pipe(parser);
	});
}

/** Parse the common XMLTV YYYYMMDD date form without inventing a timezone. */
function parseXmltvDate(value: string): string | null {
	const match = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value.trim());
	return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Prefer explicit rerun evidence when a malformed feed supplies contradictions. */
function setProgramNewness(
	program: ProgramAccumulator,
	newness: BroadcastNewness,
	source: BroadcastNewnessSource
): void {
	if (program.broadcastNewness === "rerun" && newness !== "rerun") return;
	program.broadcastNewness = newness;
	program.newnessSource = source;
}

/** Use original-air-date only when the feed did not provide an explicit marker. */
function applyOriginalAirDateNewness(program: ProgramAccumulator): void {
	if (!program.originalAirDate || program.broadcastNewness !== "unknown")
		return;
	const broadcastDate = program.start.toISOString().slice(0, 10);
	if (program.originalAirDate < broadcastDate) {
		setProgramNewness(program, "rerun", "original_air_date");
	} else if (program.originalAirDate === broadcastDate) {
		setProgramNewness(program, "new", "original_air_date");
	}
}

/** Build only identities strong enough to survive guide pruning safely. */
function buildEpisodeIdentityKey(program: ProgramAccumulator): string | null {
	if (program.providerEpisodeId) return program.providerEpisodeId;
	const title = program.title?.trim().toLowerCase().replace(/\s+/g, " ");
	if (!title) return null;
	if (program.season !== null && program.episode !== null) {
		return `title:${title}:s${program.season}:e${program.episode}`;
	}
	const subtitle = program.subtitle?.trim().toLowerCase().replace(/\s+/g, " ");
	if (subtitle && program.originalAirDate) {
		return `title:${title}:subtitle:${subtitle}:date:${program.originalAirDate}`;
	}
	return null;
}

function applyEpisodeNum(
	program: ProgramAccumulator,
	system: string,
	value: string
): void {
	if (!value) return;
	if (system === "xmltv_ns") {
		// Format: "season . episode . part" with each part 0-indexed and
		// optionally followed by "/total".
		const parts = value.split(".").map((p) => p.trim());
		const seasonRaw = parts[0]?.split("/")[0];
		const episodeRaw = parts[1]?.split("/")[0];
		if (seasonRaw && /^\d+$/.test(seasonRaw)) {
			program.season = Number(seasonRaw) + 1;
		}
		if (episodeRaw && /^\d+$/.test(episodeRaw)) {
			program.episode = Number(episodeRaw) + 1;
		}
	} else if (system === "onscreen" || system === "") {
		const seMatch = /S(\d+)E(\d+)/i.exec(value);
		if (seMatch) {
			program.season = Number(seMatch[1]);
			program.episode = Number(seMatch[2]);
			return;
		}
		const num = Number(value);
		if (Number.isFinite(num) && Number.isInteger(num)) {
			program.episode = num;
		}
	}
}
