import type {
	ChannelListItem,
	ChannelsSettings,
	EpgGridProgram
} from "@signalhaven/shared";

import { selectPreferredChannels } from "../_preferences/channel-preferences";

/**
 * Pure helpers for the U7-watch live watch page. Kept React-free so the
 * tests can exercise the navigation + EPG selection logic directly.
 */

/**
 * Order channels for the channel switcher / PgUp/PgDn navigation.
 *
 * Favorites come first while manual order remains stable inside both
 * preference ranks. Hidden/disabled channels are dropped entirely so the
 * user can never land on them via Page Up/Down.
 */
export function orderForSwitcher(
	channels: ChannelListItem[],
	favorites: readonly string[],
	hidden: readonly string[],
	order: readonly string[] = []
): ChannelListItem[] {
	const preferences: ChannelsSettings = {
		favorites: [...favorites],
		hidden: [...hidden],
		order: [...order]
	};
	return selectPreferredChannels(channels, preferences);
}

/** Wrap-around step through `ordered` from `currentId` by `delta` (±1, ±N). */
export function stepChannel(
	ordered: readonly ChannelListItem[],
	currentId: string,
	delta: number
): ChannelListItem | null {
	if (ordered.length === 0) return null;
	const idx = ordered.findIndex((c) => c.id === currentId);
	if (idx === -1) return ordered[0] ?? null;
	const len = ordered.length;
	const next = (((idx + delta) % len) + len) % len;
	return ordered[next] ?? null;
}

/**
 * Pick the program currently airing on `channelId` from the supplied
 * EPG slice. Programs are scanned linearly; callers typically pass a
 * narrow per-channel slice so this stays cheap.
 */
export function selectNowProgram(
	programs: readonly EpgGridProgram[],
	channelId: string,
	now: Date
): EpgGridProgram | null {
	const ts = now.getTime();
	for (const p of programs) {
		if (p.channelId !== channelId) continue;
		const start = Date.parse(p.start);
		const stop = Date.parse(p.stop);
		if (
			Number.isFinite(start) &&
			Number.isFinite(stop) &&
			start <= ts &&
			ts < stop
		) {
			return p;
		}
	}
	return null;
}

/**
 * Return up to `limit` programs whose stop is in the future for
 * `channelId`, sorted by start ascending. Used by the mini-guide and
 * the "Up next" panel; the currently-airing program is included as the
 * first entry so the same list can drive both views.
 */
export function selectUpcoming(
	programs: readonly EpgGridProgram[],
	channelId: string,
	now: Date,
	limit: number
): EpgGridProgram[] {
	const ts = now.getTime();
	const next: EpgGridProgram[] = [];
	for (const p of programs) {
		if (p.channelId !== channelId) continue;
		const stop = Date.parse(p.stop);
		if (Number.isFinite(stop) && stop > ts) next.push(p);
	}
	next.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
	return next.slice(0, limit);
}
