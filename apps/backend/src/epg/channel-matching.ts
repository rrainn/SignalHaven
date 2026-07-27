/**
 * Pure ranking + normalization helpers for matching tuner channels to
 * EPG channels (rrainn/SignalHaven E3-mapping).
 *
 * The matcher is intentionally side-effect free so it can be unit tested
 * without a database — see `tests/channel-matching.test.ts`. The
 * higher-level orchestration (load rows, persist auto-matches, never
 * overwrite manual mappings) lives in {@link ./epg-matcher.service}.
 */

/** A tuner-side channel, in the shape the matcher needs. */
export interface MatchableChannel {
	id: string;
	number: string;
	name: string;
	/** Optional XMLTV-style id (e.g. M3U `tvg-id`); enables the strongest match. */
	tvgId: string | null;
}

/** An EPG-side channel candidate, in the shape the matcher needs. */
export interface MatchableEpgChannel {
	id: string;
	sourceId: string;
	externalId: string;
	displayName: string;
	/** Every XMLTV display-name, including numeric tuner guide aliases. */
	displayNames: readonly string[];
}

/** Why a candidate was matched, in descending confidence order. */
export type MatchStrategy =
	| "tvg-id"
	| "channel-number"
	| "display-name"
	| "normalized-name"
	| "stream-metadata-name"
	| "channel-number-prefix";

/** Confidence weights are well-spaced so ties rank by strategy strength. */
const STRATEGY_SCORES: Record<MatchStrategy, number> = {
	"tvg-id": 100,
	"channel-number": 90,
	"display-name": 80,
	"normalized-name": 60,
	"stream-metadata-name": 55,
	"channel-number-prefix": 40
};

export interface RankedEpgCandidate {
	epgChannel: MatchableEpgChannel;
	/** Highest-confidence strategy that produced this candidate. */
	strategy: MatchStrategy;
	/** 0–100 confidence score; higher is better. */
	score: number;
}

/**
 * Normalize a free-form channel name for fuzzy comparison: lowercase,
 * strip diacritics, drop spaces and non-alphanumeric characters. A pair
 * of strings is considered "the same channel" when their normalized
 * forms are non-empty and equal.
 *
 * Examples:
 *   "ESPN HD"    → "espnhd"
 *   "ESPN-HD"    → "espnhd"
 *   "Channel 5+1"→ "channel51"
 *   "Café TV"    → "cafetv"
 */
export function normalizeName(value: string | null | undefined): string {
	if (!value) return "";
	return (
		value
			.normalize("NFKD")
			// Strip combining marks (diacritics) without touching the base letter.
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "")
	);
}

/**
 * Remove trailing IPTV stream metadata that describes delivery rather than
 * channel identity. Keeping this separate from {@link normalizeName} avoids
 * weakening ordinary exact and normalized-name comparisons.
 */
export function stripStreamMetadata(value: string | null | undefined): string {
	if (!value) return "";
	let stripped = value.trim();
	let previous: string;
	do {
		previous = stripped;
		stripped = stripped
			.replace(/\s*\[(?:geo-?blocked|not\s+24\/7)\]\s*$/i, "")
			.replace(/\s*\((?:\d{3,4}p|[248]k|uhd|fhd|hd|sd)\)\s*$/i, "")
			.trim();
	} while (stripped !== previous);
	return stripped;
}

/**
 * Extract the numeric prefix of a channel number. e.g. "5.1" → "5",
 * "23-2" → "23", "11" → "11". Returns `""` when there's no leading
 * digit run, in which case the prefix strategy is skipped.
 */
export function channelNumberPrefix(value: string | null | undefined): string {
	if (!value) return "";
	const match = /^(\d+)/.exec(value.trim());
	return match ? (match[1] ?? "") : "";
}

/**
 * Rank EPG channels as candidates for the given tuner channel. Each EPG
 * channel appears at most once, tagged with the strongest strategy that
 * matched it. Results are sorted by score (desc) and then by EPG display
 * name (asc) for deterministic ordering.
 *
 * The five strategies, in confidence order:
 *   1. `tvg-id`               — channel.tvgId === epg.externalId
 *   2. `channel-number`        — full tuner number equals an XMLTV alias
 *   3. `display-name`         — case-sensitive equality on names
 *   4. `normalized-name`      — equality on {@link normalizeName} forms
 *   5. `stream-metadata-name` — normalized equality after known stream
 *                               metadata such as `(1080p)` is removed
 *   6. `channel-number-prefix`— EPG display-name starts with the channel's
 *                                numeric prefix (e.g. "5.1" → matches
 *                                "5 News", "5HD", ...)
 */
export function rankEpgCandidates(
	channel: MatchableChannel,
	epgChannels: readonly MatchableEpgChannel[]
): RankedEpgCandidate[] {
	const channelNorm = normalizeName(channel.name);
	const streamMetadataNameNorm = normalizeName(
		stripStreamMetadata(channel.name)
	);
	const channelPrefix = channelNumberPrefix(channel.number);
	const seen = new Map<string, RankedEpgCandidate>();
	const matchesStreamMetadataName = (epg: MatchableEpgChannel): boolean => {
		const displayNames =
			epg.displayNames.length > 0 ? epg.displayNames : [epg.displayName];
		return displayNames.some(
			(name) =>
				normalizeName(stripStreamMetadata(name)) === streamMetadataNameNorm
		);
	};
	// Decorative-name matching is safe only when it identifies one guide row.
	const uniqueStreamMetadataNameMatch =
		streamMetadataNameNorm && streamMetadataNameNorm !== channelNorm
			? epgChannels.filter(matchesStreamMetadataName)
			: [];

	const consider = (
		epg: MatchableEpgChannel,
		strategy: MatchStrategy
	): void => {
		const score = STRATEGY_SCORES[strategy];
		const existing = seen.get(epg.id);
		if (!existing || existing.score < score) {
			seen.set(epg.id, { epgChannel: epg, strategy, score });
		}
	};

	for (const epg of epgChannels) {
		const displayNames =
			epg.displayNames.length > 0 ? epg.displayNames : [epg.displayName];

		if (channel.tvgId && epg.externalId === channel.tvgId) {
			consider(epg, "tvg-id");
			// Continue: a single EPG row can't match anything stronger than
			// tvg-id, but we still need to evaluate every OTHER epg row below.
			continue;
		}

		const channelNumber = channel.number.trim();
		if (
			channelNumber &&
			displayNames.some((name) => name.trim() === channelNumber)
		) {
			consider(epg, "channel-number");
			continue;
		}

		if (channel.name && displayNames.includes(channel.name)) {
			consider(epg, "display-name");
			continue;
		}

		if (
			channelNorm &&
			displayNames.some((name) => normalizeName(name) === channelNorm)
		) {
			consider(epg, "normalized-name");
			continue;
		}

		if (
			uniqueStreamMetadataNameMatch.length === 1 &&
			uniqueStreamMetadataNameMatch[0]?.id === epg.id
		) {
			consider(epg, "stream-metadata-name");
			continue;
		}

		if (channelPrefix) {
			// Match when an alias starts with the prefix and the next character
			// is non-numeric, so "5" matches "5 News" but not "55 News".
			for (const displayName of displayNames) {
				const trimmed = displayName.trim();
				if (!trimmed.startsWith(channelPrefix)) continue;

				const next = trimmed.charAt(channelPrefix.length);
				if (next === "" || !/\d/.test(next)) {
					consider(epg, "channel-number-prefix");
					break;
				}
			}
		}
	}

	return [...seen.values()].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.epgChannel.displayName.localeCompare(b.epgChannel.displayName);
	});
}
