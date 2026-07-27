import type { ChannelsSettings } from "@signalhaven/shared";

/** Minimal shape shared by channel-list and EPG-grid channel records. */
export type PreferenceChannel = {
	id: string;
	enabled?: boolean;
	sortOrder?: number;
};

export type ChannelPreferenceOptions = {
	/** Hidden channels are only included by explicit management views. */
	includeHidden?: boolean;
	/** Disabled channels remain manageable but are excluded from navigation. */
	includeDisabled?: boolean;
};

/**
 * Applies the product-wide channel visibility and ordering contract.
 *
 * Manual order is the stable base order. Favorites form a higher-priority
 * rank without changing that base order inside the favorite/non-favorite
 * groups. Missing preference entries fall back to the server's canonical
 * `sortOrder`, then to source order for EPG rows that do not carry it.
 */
export function selectPreferredChannels<T extends PreferenceChannel>(
	channels: readonly T[],
	preferences: ChannelsSettings,
	options: ChannelPreferenceOptions = {}
): T[] {
	const hidden = new Set(preferences.hidden);
	const favorites = new Set(preferences.favorites);
	const manualIndex = firstIndexById(preferences.order);
	const sourceIndex = new Map<string, number>();

	const visible: T[] = [];
	for (const channel of channels) {
		if (!sourceIndex.has(channel.id)) {
			sourceIndex.set(channel.id, sourceIndex.size);
		}
		if (!options.includeDisabled && channel.enabled === false) continue;
		if (!options.includeHidden && hidden.has(channel.id)) continue;
		visible.push(channel);
	}

	return visible.sort((left, right) => {
		const favoriteRank =
			Number(favorites.has(right.id)) - Number(favorites.has(left.id));
		if (favoriteRank !== 0) return favoriteRank;

		const leftManual = manualIndex.get(left.id);
		const rightManual = manualIndex.get(right.id);
		if (leftManual !== undefined || rightManual !== undefined) {
			if (leftManual === undefined) return 1;
			if (rightManual === undefined) return -1;
			if (leftManual !== rightManual) return leftManual - rightManual;
		}

		const canonical =
			canonicalOrder(left, sourceIndex) - canonicalOrder(right, sourceIndex);
		if (canonical !== 0) return canonical;

		// Preserve API order when canonical ranks tie; an ID tie-breaker only
		// protects deterministic output for duplicate source records.
		const source =
			sourceOrder(left, sourceIndex) - sourceOrder(right, sourceIndex);
		if (source !== 0) return source;
		return left.id.localeCompare(right.id);
	});
}

/** Keeps the first occurrence so malformed duplicate settings stay stable. */
function firstIndexById(ids: readonly string[]): Map<string, number> {
	const indexes = new Map<string, number>();
	for (const [index, id] of ids.entries()) {
		if (!indexes.has(id)) indexes.set(id, index);
	}
	return indexes;
}

/** EPG rows inherit their canonical rank from the API's source order. */
function canonicalOrder<T extends PreferenceChannel>(
	channel: T,
	sourceIndex: ReadonlyMap<string, number>
): number {
	return (
		channel.sortOrder ?? sourceIndex.get(channel.id) ?? Number.MAX_SAFE_INTEGER
	);
}

/** Returns the original API rank used to resolve equal canonical positions. */
function sourceOrder<T extends PreferenceChannel>(
	channel: T,
	sourceIndex: ReadonlyMap<string, number>
): number {
	return sourceIndex.get(channel.id) ?? Number.MAX_SAFE_INTEGER;
}
