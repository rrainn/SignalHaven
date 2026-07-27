"use client";

import type {
	Recording,
	RecordingListItem,
	RecordingListDirection,
	RecordingListSort,
	RecordingStatus
} from "@signalhaven/shared";

/**
 * Pure state + reducer for the U8-recordings library page.
 *
 * The reducer is the single source of truth for every user-driven
 * decoration on top of the server-provided recordings list:
 *
 *   * view mode (grid vs. list) and the optional series grouping;
 *   * search + filters (status, channel, scheduled-after / -before);
 *   * the multi-select set that drives the bulk delete toolbar.
 *
 * Keeping this as a pure (state, action) -> state function means the
 * tests can drive every code path without React, and the page
 * component subscribes via plain `useReducer`.
 *
 * Acceptance criteria mapping (rrainn/SignalHaven U8):
 *   - Grid/list toggle; group by series; filter by status/channel/date;
 *     search.    — see {@link RecordingsFilters} + selectors below.
 *   - Bulk delete                       — `toggle-selection`,
 *     `select-all`, `clear-selection` actions feed the toolbar; the
 *     page itself wires the DELETE calls.
 */

export type RecordingsViewMode = "grid" | "list";

/** `series` collapses entries produced by the same `seriesRuleId`. */
export type RecordingsGroupBy = "none" | "series";

export interface RecordingsFilters {
	/** Free-text search; matched case-insensitively against title. */
	search: string;
	/** Lifecycle status to scope to, or `null` for all statuses. */
	status: RecordingStatus | null;
	/** Channel UUID to scope to, or `null` for all channels. */
	channelId: string | null;
	/**
	 * Inclusive lower bound on `scheduledStart`, ISO 8601 (date or
	 * datetime). `null` disables the lower bound.
	 */
	from: string | null;
	/**
	 * Strict upper bound on `scheduledStart`, ISO 8601 (date or
	 * datetime). `null` disables the upper bound.
	 */
	to: string | null;
}

export interface RecordingsState {
	/** Source list as returned by the API. */
	recordings: RecordingListItem[];
	view: RecordingsViewMode;
	groupBy: RecordingsGroupBy;
	filters: RecordingsFilters;
	/** Server-backed sort shared by every loaded page. */
	sort: RecordingListSort;
	direction: RecordingListDirection;
	/** Recording ids currently checked in the bulk toolbar. */
	selection: ReadonlySet<string>;
}

export type RecordingsAction =
	| { type: "set-recordings"; recordings: RecordingListItem[] }
	| { type: "upsert-recording"; recording: RecordingListItem }
	| {
			type: "patch-recordings";
			recordingIds: string[];
			patch: Partial<Recording>;
	  }
	| { type: "set-view"; view: RecordingsViewMode }
	| { type: "set-group-by"; groupBy: RecordingsGroupBy }
	| { type: "set-search"; search: string }
	| { type: "set-status"; status: RecordingStatus | null }
	| { type: "set-channel"; channelId: string | null }
	| { type: "set-from"; from: string | null }
	| { type: "set-to"; to: string | null }
	| { type: "set-sort"; sort: RecordingListSort }
	| { type: "set-direction"; direction: RecordingListDirection }
	| { type: "clear-filters" }
	| { type: "toggle-selection"; recordingId: string }
	| { type: "select-all"; recordingIds: string[] }
	| { type: "clear-selection" }
	| { type: "remove-recordings"; recordingIds: string[] };

export const initialRecordingsState: RecordingsState = {
	recordings: [],
	view: "grid",
	groupBy: "none",
	sort: "scheduledStart",
	direction: "desc",
	filters: {
		search: "",
		status: null,
		channelId: null,
		from: null,
		to: null
	},
	selection: new Set<string>()
};

/* ── Selectors (also exported for tests) ───────────────────────────── */

export function filterRecordings(
	recordings: RecordingListItem[],
	filters: RecordingsFilters
): RecordingListItem[] {
	const search = filters.search.trim().toLowerCase();
	const fromMs = filters.from ? Date.parse(filters.from) : null;
	const toMs = filters.to ? Date.parse(filters.to) : null;

	return recordings.filter((r) => {
		if (filters.status !== null && r.status !== filters.status) return false;
		if (filters.channelId !== null && r.channelId !== filters.channelId) {
			return false;
		}
		if (fromMs !== null && !Number.isNaN(fromMs)) {
			if (Date.parse(r.scheduledStart) < fromMs) return false;
		}
		if (toMs !== null && !Number.isNaN(toMs)) {
			if (Date.parse(r.scheduledStart) >= toMs) return false;
		}
		if (search.length > 0) {
			if (!r.title.toLowerCase().includes(search)) return false;
		}
		return true;
	});
}

/**
 * Newest-first sort for the library view, matching the server's
 * default ordering on `scheduledStart desc`. Stable on title for
 * recordings with identical timestamps so the render order doesn't
 * flicker between fetches.
 */
export function sortRecordings(
	recordings: RecordingListItem[]
): RecordingListItem[] {
	const list = [...recordings];
	list.sort((a, b) => {
		const ad = Date.parse(a.scheduledStart);
		const bd = Date.parse(b.scheduledStart);
		if (ad !== bd) return bd - ad;
		return a.title.localeCompare(b.title);
	});
	return list;
}

/** Selector — returns the visible (filtered + sorted) recordings. */
export function selectVisibleRecordings(
	state: RecordingsState
): RecordingListItem[] {
	return sortRecordings(filterRecordings(state.recordings, state.filters));
}

export interface RecordingsGroup {
	/** Stable group key — the series-rule id, or `"__none__"` for one-offs. */
	key: string;
	/** Display label. For series-grouped rows this is the series title. */
	label: string;
	/** Whether this group represents a real series (has a seriesRuleId). */
	isSeries: boolean;
	recordings: RecordingListItem[];
	/** Sum of `fileSize` across all recordings in the group, in bytes. */
	totalSize: number;
}

/**
 * Group recordings by their series rule when `groupBy === "series"`.
 * Recordings without a `seriesRuleId` (one-off) are kept in a single
 * `__none__` bucket so the UI can still surface them. When
 * `groupBy === "none"` the entire list is returned in one bucket.
 */
export function groupRecordings(
	recordings: RecordingListItem[],
	groupBy: RecordingsGroupBy
): RecordingsGroup[] {
	if (groupBy === "none") {
		return [
			{
				key: "all",
				label: "All recordings",
				isSeries: false,
				recordings,
				totalSize: sumFileSize(recordings)
			}
		];
	}
	const groups = new Map<string, RecordingsGroup>();
	for (const r of recordings) {
		const key = r.seriesRuleId ?? "__none__";
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				label: r.seriesRuleId ? r.title : "One-off recordings",
				isSeries: r.seriesRuleId !== null,
				recordings: [],
				totalSize: 0
			};
			groups.set(key, g);
		}
		g.recordings.push(r);
		g.totalSize += r.fileSize ?? 0;
	}
	return Array.from(groups.values()).sort((a, b) => {
		if (a.isSeries !== b.isSeries) return a.isSeries ? -1 : 1;
		return a.label.localeCompare(b.label);
	});
}

function sumFileSize(recordings: RecordingListItem[]): number {
	return recordings.reduce((acc, r) => acc + (r.fileSize ?? 0), 0);
}

/* ── Reducer ──────────────────────────────────────────────────────── */

export function recordingsReducer(
	state: RecordingsState,
	action: RecordingsAction
): RecordingsState {
	switch (action.type) {
		case "set-recordings":
			return { ...state, recordings: action.recordings };
		case "upsert-recording": {
			const existing = state.recordings.findIndex(
				(recording) => recording.id === action.recording.id
			);
			const recordings = [...state.recordings];
			if (existing >= 0) recordings[existing] = action.recording;
			else recordings.push(action.recording);
			return { ...state, recordings };
		}
		case "patch-recordings": {
			const ids = new Set(action.recordingIds);
			return {
				...state,
				recordings: state.recordings.map((recording) =>
					ids.has(recording.id) ? { ...recording, ...action.patch } : recording
				)
			};
		}
		case "set-view":
			return { ...state, view: action.view };
		case "set-group-by":
			return { ...state, groupBy: action.groupBy };
		case "set-search":
			return { ...state, filters: { ...state.filters, search: action.search } };
		case "set-status":
			return { ...state, filters: { ...state.filters, status: action.status } };
		case "set-channel":
			return {
				...state,
				filters: { ...state.filters, channelId: action.channelId }
			};
		case "set-from":
			return { ...state, filters: { ...state.filters, from: action.from } };
		case "set-to":
			return { ...state, filters: { ...state.filters, to: action.to } };
		case "set-sort":
			return { ...state, sort: action.sort };
		case "set-direction":
			return { ...state, direction: action.direction };
		case "clear-filters":
			return { ...state, filters: { ...initialRecordingsState.filters } };
		case "toggle-selection": {
			const next = new Set(state.selection);
			if (next.has(action.recordingId)) next.delete(action.recordingId);
			else next.add(action.recordingId);
			return { ...state, selection: next };
		}
		case "select-all":
			return { ...state, selection: new Set(action.recordingIds) };
		case "clear-selection":
			return { ...state, selection: new Set<string>() };
		case "remove-recordings": {
			const drop = new Set(action.recordingIds);
			const recordings = state.recordings.filter((r) => !drop.has(r.id));
			const selection = new Set<string>();
			for (const id of state.selection) {
				if (!drop.has(id)) selection.add(id);
			}
			return { ...state, recordings, selection };
		}
		default:
			return state;
	}
}

/* ── Display helpers ──────────────────────────────────────────────── */

/**
 * Compact human-readable byte size. Falls back to `"—"` when the size
 * isn't yet known (the recording is still in flight or has no file on
 * disk).
 */
export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || bytes <= 0) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
	return `${rounded} ${units[unit]}`;
}

/** Compact `H:MM:SS` / `M:SS` formatter for durations in seconds. */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined || seconds <= 0) return "—";
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) {
		return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	}
	return `${m}:${s.toString().padStart(2, "0")}`;
}
