"use client";

import type { ChannelListItem, ChannelsSettings } from "@signalhaven/shared";

import { selectPreferredChannels } from "../_preferences/channel-preferences";

/**
 * Pure state + reducer for the U5-channels list view.
 *
 * The reducer is the single source of truth for *every* user-driven
 * decoration on top of the server-provided channel list:
 *
 *   * sort order (canonical, by-number, by-name, favorites-first, manual)
 *   * filters (search, tuner, group, favorited / hidden visibility)
 *   * favorites / hidden / manual order — the persisted preferences that
 *     get round-tripped through the settings API.
 *   * bulk hide/unhide + the selection set that drives the bulk toolbar.
 *
 * Keeping it as a pure (state, action) -> state function lets the tests
 * exhaustively cover every code path without React, and lets the page
 * subscribe selectors via plain `useReducer`.
 *
 * Acceptance criteria mapping (rrainn/SignalHaven U5):
 *   - Sortable, filterable channel list (by group, tuner, favorited)
 *       — see {@link ChannelsFilters} + {@link sortChannels}.
 *   - Favorite toggle persisted via settings API
 *       — `toggle-favorite` writes `favorites`; the page wraps the
 *         resulting prefs in a `settings.channels` PATCH.
 *   - Bulk hide/unhide channels
 *       — `toggle-selection` + `bulk-hide` / `bulk-unhide` actions.
 *   - Drag-to-reorder for sort order
 *       — `reorder` action; `sort = "manual"` honors the user `order`.
 */

export type ChannelsSort =
	| "canonical"
	| "number"
	| "name"
	| "favorites-first"
	| "manual";

/** "All", "Favorites only", or "Hidden only" — mutually exclusive. */
export type ChannelsVisibility = "all" | "favorites" | "hidden";

/** Group rows on the list by which axis. `none` = flat list. */
export type ChannelsGroupBy = "none" | "tuner";

export interface ChannelsFilters {
	/** Free-text search; matched case-insensitively against name + number. */
	search: string;
	/** Tuner UUID to scope to, or `null` for all tuners. */
	tunerId: string | null;
	visibility: ChannelsVisibility;
}

/**
 * Persisted preferences. Mirrors `channelsSettingsSchema` from
 * `@signalhaven/shared` so the same object can be PATCHed back to the
 * settings API without translation.
 */
export type ChannelsPrefs = ChannelsSettings;

export interface ChannelsState {
	/** Source list as returned by the API (canonical order). */
	channels: ChannelListItem[];
	filters: ChannelsFilters;
	groupBy: ChannelsGroupBy;
	sort: ChannelsSort;
	prefs: ChannelsPrefs;
	/** Channel IDs currently checked in the bulk toolbar. */
	selection: ReadonlySet<string>;
}

export type ChannelsAction =
	| { type: "set-channels"; channels: ChannelListItem[] }
	| { type: "set-prefs"; prefs: ChannelsPrefs }
	| { type: "set-search"; search: string }
	| { type: "set-tuner"; tunerId: string | null }
	| { type: "set-visibility"; visibility: ChannelsVisibility }
	| { type: "set-group-by"; groupBy: ChannelsGroupBy }
	| { type: "set-sort"; sort: ChannelsSort }
	| { type: "toggle-favorite"; channelId: string }
	| { type: "toggle-hidden"; channelId: string }
	| { type: "toggle-selection"; channelId: string }
	| { type: "select-all"; channelIds: string[] }
	| { type: "clear-selection" }
	| { type: "bulk-hide"; channelIds: string[] }
	| { type: "bulk-unhide"; channelIds: string[] }
	| {
			type: "reorder";
			/** ID of the channel being moved. */
			channelId: string;
			/** ID of the channel to insert *before*; `null` = move to end. */
			beforeId: string | null;
	  };

export const initialChannelsState: ChannelsState = {
	channels: [],
	filters: {
		search: "",
		tunerId: null,
		visibility: "all"
	},
	groupBy: "none",
	sort: "manual",
	prefs: {
		favorites: [],
		hidden: [],
		order: []
	},
	selection: new Set<string>()
};

/* ── Helpers (also exported for tests) ─────────────────────────────── */

function toggleInArray(list: string[], id: string): string[] {
	const idx = list.indexOf(id);
	if (idx === -1) return [...list, id];
	return list.filter((entry) => entry !== id);
}

function uniqueAppend(list: string[], ids: string[]): string[] {
	const set = new Set(list);
	const next = [...list];
	for (const id of ids) {
		if (!set.has(id)) {
			set.add(id);
			next.push(id);
		}
	}
	return next;
}

function removeAll(list: string[], ids: string[]): string[] {
	const drop = new Set(ids);
	return list.filter((entry) => !drop.has(entry));
}

/**
 * Reorder `order` so `channelId` appears immediately before `beforeId`,
 * or at the tail when `beforeId` is `null`. Both ids are appended to the
 * order list when missing — that's how the first drag of a channel out
 * of canonical order persists into the manual order.
 */
export function reorderList(
	order: string[],
	channelId: string,
	beforeId: string | null
): string[] {
	if (channelId === beforeId) return order;
	const without = order.filter((id) => id !== channelId);
	if (beforeId === null) return [...without, channelId];
	const idx = without.indexOf(beforeId);
	if (idx === -1) {
		// beforeId not in order yet — append channelId then beforeId so the
		// moved channel ends up immediately *before* the target, matching
		// the "drop on" semantics used by the drag handlers.
		return [...without, channelId, beforeId];
	}
	return [...without.slice(0, idx), channelId, ...without.slice(idx)];
}

/**
 * Apply sort to `channels`. `prefs.order` is consulted only when
 * `sort === "manual"`; favorites-first piggybacks on canonical otherwise.
 */
export function sortChannels(
	channels: ChannelListItem[],
	sort: ChannelsSort,
	prefs: ChannelsPrefs
): ChannelListItem[] {
	const list = [...channels];
	switch (sort) {
		case "number":
			list.sort((a, b) => compareChannelNumber(a.number, b.number));
			return list;
		case "name":
			list.sort((a, b) => a.name.localeCompare(b.name));
			return list;
		case "favorites-first": {
			return selectPreferredChannels(list, prefs, {
				includeHidden: true,
				includeDisabled: true
			});
		}
		case "manual": {
			return selectPreferredChannels(list, prefs, {
				includeHidden: true,
				includeDisabled: true
			});
		}
		case "canonical":
		default:
			list.sort((a, b) => a.sortOrder - b.sortOrder);
			return list;
	}
}

/**
 * Natural numeric sort for dotted channel numbers. Splits on the first
 * non-digit run so "5.1" sorts before "10.1" and "5.10" sorts after
 * "5.2". Falls back to `localeCompare` when the strings aren't numeric.
 */
export function compareChannelNumber(a: string, b: string): number {
	const partsA = a.split(/[.-]/).map((s) => Number.parseInt(s, 10));
	const partsB = b.split(/[.-]/).map((s) => Number.parseInt(s, 10));
	for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
		const av = partsA[i];
		const bv = partsB[i];
		if (av === undefined) return -1;
		if (bv === undefined) return 1;
		if (Number.isNaN(av) || Number.isNaN(bv)) return a.localeCompare(b);
		if (av !== bv) return av - bv;
	}
	return 0;
}

export function filterChannels(
	channels: ChannelListItem[],
	filters: ChannelsFilters,
	prefs: ChannelsPrefs
): ChannelListItem[] {
	const favSet = new Set(prefs.favorites);
	const hiddenSet = new Set(prefs.hidden);
	const search = filters.search.trim().toLowerCase();

	return channels.filter((channel) => {
		if (filters.tunerId !== null && channel.tunerId !== filters.tunerId) {
			return false;
		}
		if (filters.visibility === "favorites" && !favSet.has(channel.id)) {
			return false;
		}
		if (filters.visibility === "hidden") {
			if (!hiddenSet.has(channel.id)) return false;
		} else if (hiddenSet.has(channel.id)) {
			// "all" + "favorites" both exclude hidden channels by default.
			return false;
		}
		if (search.length > 0) {
			const hay = `${channel.number} ${channel.name}`.toLowerCase();
			if (!hay.includes(search)) return false;
		}
		return true;
	});
}

/**
 * Selector over {@link ChannelsState} — returns the channels the user
 * should see, fully sorted and filtered. Pure of any React APIs so the
 * tests can call it directly.
 */
export function selectVisibleChannels(state: ChannelsState): ChannelListItem[] {
	const filtered = filterChannels(state.channels, state.filters, state.prefs);
	return sortChannels(filtered, state.sort, state.prefs);
}

/** Group the visible channels by tuner — used when `groupBy === "tuner"`. */
export interface ChannelsGroup {
	/** Stable key for the group (tuner id, or `"all"` when ungrouped). */
	key: string;
	label: string;
	channels: ChannelListItem[];
}

export function groupChannels(
	channels: ChannelListItem[],
	groupBy: ChannelsGroupBy
): ChannelsGroup[] {
	if (groupBy === "none") {
		return [{ key: "all", label: "All channels", channels }];
	}
	const groups = new Map<string, ChannelsGroup>();
	for (const channel of channels) {
		const key = channel.tunerId;
		let g = groups.get(key);
		if (!g) {
			g = { key, label: channel.tunerName, channels: [] };
			groups.set(key, g);
		}
		g.channels.push(channel);
	}
	return Array.from(groups.values());
}

/* ── Reducer ──────────────────────────────────────────────────────── */

export function channelsReducer(
	state: ChannelsState,
	action: ChannelsAction
): ChannelsState {
	switch (action.type) {
		case "set-channels":
			return { ...state, channels: action.channels };
		case "set-prefs":
			return { ...state, prefs: action.prefs };
		case "set-search":
			return { ...state, filters: { ...state.filters, search: action.search } };
		case "set-tuner":
			return {
				...state,
				filters: { ...state.filters, tunerId: action.tunerId }
			};
		case "set-visibility":
			return {
				...state,
				filters: { ...state.filters, visibility: action.visibility }
			};
		case "set-group-by":
			return { ...state, groupBy: action.groupBy };
		case "set-sort":
			return { ...state, sort: action.sort };
		case "toggle-favorite":
			return {
				...state,
				prefs: {
					...state.prefs,
					favorites: toggleInArray(state.prefs.favorites, action.channelId)
				}
			};
		case "toggle-hidden":
			return {
				...state,
				prefs: {
					...state.prefs,
					hidden: toggleInArray(state.prefs.hidden, action.channelId)
				}
			};
		case "toggle-selection": {
			const next = new Set(state.selection);
			if (next.has(action.channelId)) next.delete(action.channelId);
			else next.add(action.channelId);
			return { ...state, selection: next };
		}
		case "select-all":
			return { ...state, selection: new Set(action.channelIds) };
		case "clear-selection":
			return { ...state, selection: new Set<string>() };
		case "bulk-hide":
			return {
				...state,
				prefs: {
					...state.prefs,
					hidden: uniqueAppend(state.prefs.hidden, action.channelIds)
				},
				selection: new Set<string>()
			};
		case "bulk-unhide":
			return {
				...state,
				prefs: {
					...state.prefs,
					hidden: removeAll(state.prefs.hidden, action.channelIds)
				},
				selection: new Set<string>()
			};
		case "reorder":
			return {
				...state,
				sort: "manual",
				prefs: {
					...state.prefs,
					order: reorderList(
						state.prefs.order,
						action.channelId,
						action.beforeId
					)
				}
			};
		default:
			return state;
	}
}
