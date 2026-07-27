import type {
	RecordingListDirection,
	RecordingListQuery,
	RecordingListSort,
	RecordingStatus
} from "@signalhaven/shared";

import type {
	RecordingsFilters,
	RecordingsGroupBy,
	RecordingsViewMode
} from "./state";

/** Bounded page size tuned for the recordings grid. */
export const RECORDINGS_PAGE_SIZE = 24;

/** URL-backed library state that should survive detail navigation. */
export interface RecordingsUrlState {
	filters: RecordingsFilters;
	sort: RecordingListSort;
	direction: RecordingListDirection;
	view: RecordingsViewMode;
	groupBy: RecordingsGroupBy;
	pageCount: number;
}

/** Canonical state used when a query parameter is absent or invalid. */
export const defaultRecordingsUrlState: RecordingsUrlState = {
	filters: {
		search: "",
		status: null,
		channelId: null,
		from: null,
		to: null
	},
	sort: "scheduledStart",
	direction: "desc",
	view: "grid",
	groupBy: "none",
	pageCount: 1
};

type SearchParamsInput =
	| URLSearchParams
	| Record<string, string | string[] | undefined>;

/** Parse untrusted query parameters into the finite library state machine. */
export function parseRecordingsUrlState(
	input: SearchParamsInput
): RecordingsUrlState {
	const read = (key: string): string | null => {
		if (input instanceof URLSearchParams) return input.get(key);
		const value = input[key];
		return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
	};
	const status = read("status");
	const sort = read("sort");
	const direction = read("direction");
	const view = read("view");
	const groupBy = read("group");
	const page = Number.parseInt(read("pages") ?? "1", 10);

	return {
		filters: {
			search: (read("search") ?? "").slice(0, 200),
			status: isRecordingStatus(status) ? status : null,
			channelId: isUuid(read("channel")) ? read("channel") : null,
			from: validDateInput(read("from")),
			to: validDateInput(read("to"))
		},
		sort: isRecordingSort(sort) ? sort : "scheduledStart",
		direction: direction === "asc" ? "asc" : "desc",
		view: view === "list" ? "list" : "grid",
		groupBy: groupBy === "series" ? "series" : "none",
		// A cap prevents a hostile URL from triggering an unbounded request loop.
		pageCount: Number.isFinite(page) ? Math.min(1_000, Math.max(1, page)) : 1
	};
}

/** Serialize only non-default values so copied library URLs stay readable. */
export function serializeRecordingsUrlState(state: RecordingsUrlState): string {
	const params = new URLSearchParams();
	if (state.filters.search) params.set("search", state.filters.search);
	if (state.filters.status) params.set("status", state.filters.status);
	if (state.filters.channelId) params.set("channel", state.filters.channelId);
	if (state.filters.from) params.set("from", state.filters.from);
	if (state.filters.to) params.set("to", state.filters.to);
	if (state.sort !== "scheduledStart") params.set("sort", state.sort);
	if (state.direction !== "desc") params.set("direction", state.direction);
	if (state.view !== "grid") params.set("view", state.view);
	if (state.groupBy !== "none") params.set("group", state.groupBy);
	if (state.pageCount > 1) params.set("pages", String(state.pageCount));
	return params.toString();
}

/** Convert date inputs and decorations into the backend listing contract. */
export function toRecordingListQuery(
	state: Pick<RecordingsUrlState, "filters" | "sort" | "direction">
): Partial<RecordingListQuery> {
	return {
		...(state.filters.search.trim()
			? { search: state.filters.search.trim() }
			: {}),
		...(state.filters.status ? { status: state.filters.status } : {}),
		...(state.filters.channelId ? { channelId: state.filters.channelId } : {}),
		...(state.filters.from
			? { from: localDateBoundary(state.filters.from) }
			: {}),
		...(state.filters.to ? { to: localDateBoundary(state.filters.to) } : {}),
		sort: state.sort,
		direction: state.direction
	};
}

/** Build a local return path; external destinations are intentionally rejected. */
export function safeRecordingsReturnPath(
	value: string | null | undefined,
	fallback = "/recordings"
): string {
	if (!value || !value.startsWith("/recordings") || value.startsWith("//")) {
		return fallback;
	}
	return value;
}

function localDateBoundary(value: string): string {
	return new Date(`${value}T00:00:00`).toISOString();
}

function validDateInput(value: string | null): string | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	return Number.isNaN(Date.parse(`${value}T00:00:00`)) ? null : value;
}

function isUuid(value: string | null): value is string {
	return Boolean(
		value &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value
		)
	);
}

function isRecordingStatus(value: string | null): value is RecordingStatus {
	return (
		value === "scheduled" ||
		value === "recording" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isRecordingSort(value: string | null): value is RecordingListSort {
	return (
		value === "scheduledStart" ||
		value === "actualStart" ||
		value === "createdAt"
	);
}
