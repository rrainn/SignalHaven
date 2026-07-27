"use client";

import {
	seriesRuleCreateSchema,
	type Recording,
	type RecordingConflict,
	type RecordingStatus,
	type SeriesRule
} from "@signalhaven/shared";

/**
 * Pure state + reducer for the U9-scheduler page.
 *
 * The reducer owns the three lists surfaced by the page (upcoming
 * recordings, series rules, recording conflicts) plus the active tab.
 * Keeping the state pure means the page-level wiring tests can drive
 * every code path without React.
 *
 * Acceptance criteria mapping (rrainn/SignalHaven U9):
 *   - Upcoming recordings list (chronological) with status badges and
 *     quick cancel — see {@link selectUpcomingRecordings} +
 *     `remove-recording` / `upsert-recording`.
 *   - Series rules manager (create/edit/delete + keepCount, newOnly,
 *     priority) — see `set-series-rules`, `upsert-series-rule`,
 *     `remove-series-rule` + the editor validation below.
 *   - Conflict view: `set-conflicts`, `add-conflict` (driven by the WS
 *     `recording.conflict` event), `resolve-conflict`.
 */

export type SchedulerTab = "upcoming" | "series" | "conflicts";

/** Lifecycle states that count as "upcoming" in the scheduler view. */
export const UPCOMING_STATUSES: ReadonlySet<RecordingStatus> = new Set([
	"scheduled",
	"recording"
]);

export interface SchedulerState {
	/** All recordings as returned by the API (any status). */
	recordings: Recording[];
	/** Series rules currently configured. */
	seriesRules: SeriesRule[];
	/** Conflicts surfaced by the evaluator (newest first). */
	conflicts: RecordingConflict[];
	/** Active top-level tab. */
	tab: SchedulerTab;
}

export type SchedulerAction =
	| { type: "set-recordings"; recordings: Recording[] }
	| { type: "upsert-recording"; recording: Recording }
	| { type: "remove-recording"; recordingId: string }
	| { type: "set-series-rules"; rules: SeriesRule[] }
	| { type: "upsert-series-rule"; rule: SeriesRule }
	| { type: "remove-series-rule"; ruleId: string }
	| { type: "set-conflicts"; conflicts: RecordingConflict[] }
	| { type: "add-conflict"; conflict: RecordingConflict }
	| { type: "resolve-conflict"; conflictId: string }
	| { type: "set-tab"; tab: SchedulerTab };

export const initialSchedulerState: SchedulerState = {
	recordings: [],
	seriesRules: [],
	conflicts: [],
	tab: "upcoming"
};

/* ── Selectors ────────────────────────────────────────────────────── */

/**
 * Upcoming recordings sorted chronologically (soonest first). Anything
 * already finished, failed, or cancelled is filtered out — those rows
 * belong in the recordings library (U8), not the scheduler.
 */
export function selectUpcomingRecordings(state: SchedulerState): Recording[] {
	const list = state.recordings.filter((r) => UPCOMING_STATUSES.has(r.status));
	list.sort((a, b) => {
		const ad = Date.parse(a.scheduledStart);
		const bd = Date.parse(b.scheduledStart);
		if (ad !== bd) return ad - bd;
		return a.title.localeCompare(b.title);
	});
	return list;
}

/** Sorted view of the series rules: by priority desc then by title. */
export function selectSortedSeriesRules(state: SchedulerState): SeriesRule[] {
	const list = [...state.seriesRules];
	list.sort((a, b) => {
		if (a.priority !== b.priority) return b.priority - a.priority;
		return a.title.localeCompare(b.title);
	});
	return list;
}

/** Conflicts sorted newest first (most recently detected first). */
export function selectSortedConflicts(
	state: SchedulerState
): RecordingConflict[] {
	const list = [...state.conflicts];
	list.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
	return list;
}

/* ── Reducer ──────────────────────────────────────────────────────── */

export function schedulerReducer(
	state: SchedulerState,
	action: SchedulerAction
): SchedulerState {
	switch (action.type) {
		case "set-recordings":
			return { ...state, recordings: action.recordings };
		case "upsert-recording": {
			const idx = state.recordings.findIndex(
				(r) => r.id === action.recording.id
			);
			const next = [...state.recordings];
			if (idx >= 0) next[idx] = action.recording;
			else next.push(action.recording);
			return { ...state, recordings: next };
		}
		case "remove-recording":
			return {
				...state,
				recordings: state.recordings.filter((r) => r.id !== action.recordingId)
			};
		case "set-series-rules":
			return { ...state, seriesRules: action.rules };
		case "upsert-series-rule": {
			const idx = state.seriesRules.findIndex((r) => r.id === action.rule.id);
			const next = [...state.seriesRules];
			if (idx >= 0) next[idx] = action.rule;
			else next.push(action.rule);
			return { ...state, seriesRules: next };
		}
		case "remove-series-rule":
			return {
				...state,
				seriesRules: state.seriesRules.filter((r) => r.id !== action.ruleId)
			};
		case "set-conflicts":
			return { ...state, conflicts: action.conflicts };
		case "add-conflict": {
			// Dedupe by id — the WS bus may replay an event the polling
			// endpoint already returned.
			if (state.conflicts.some((c) => c.id === action.conflict.id)) {
				return state;
			}
			return { ...state, conflicts: [action.conflict, ...state.conflicts] };
		}
		case "resolve-conflict":
			return {
				...state,
				conflicts: state.conflicts.filter((c) => c.id !== action.conflictId)
			};
		case "set-tab":
			return { ...state, tab: action.tab };
		default:
			return state;
	}
}

/* ── Series rule editor validation ─────────────────────────────────── */

/**
 * Draft state for the series-rule editor. Numeric inputs are kept as
 * strings so the form can render the user's raw text while validation
 * runs; {@link validateSeriesRuleDraft} converts the draft into the
 * `SeriesRuleCreate` shape consumed by the API.
 */
export interface SeriesRuleDraft {
	title: string;
	channelId: string | null;
	keepCount: string;
	retentionDays: string;
	newOnly: boolean;
	priority: string;
}

export const initialSeriesRuleDraft: SeriesRuleDraft = {
	title: "",
	channelId: null,
	keepCount: "5",
	retentionDays: "",
	newOnly: false,
	priority: "0"
};

export interface SeriesRuleValidationErrors {
	title?: string;
	keepCount?: string;
	retentionDays?: string;
	priority?: string;
}

export interface SeriesRuleValidationOk {
	ok: true;
	value: {
		title: string;
		channelId: string | null;
		keepCount: number;
		retentionDays: number | null;
		newOnly: boolean;
		priority: number;
	};
}

export interface SeriesRuleValidationFail {
	ok: false;
	errors: SeriesRuleValidationErrors;
}

/**
 * Validate the editor draft with the shared API schema. Numeric conversion
 * stays at this UI boundary while the canonical schema owns all bounds and
 * integer requirements.
 */
export function validateSeriesRuleDraft(
	draft: SeriesRuleDraft
): SeriesRuleValidationOk | SeriesRuleValidationFail {
	const keepCount = requiredDraftNumber(draft.keepCount);
	const priority = requiredDraftNumber(draft.priority);
	const trimmedRetentionDays = draft.retentionDays.trim();
	const candidate = {
		title: draft.title.trim(),
		channelId: draft.channelId,
		keepCount,
		retentionDays:
			trimmedRetentionDays.length > 0 ? Number(trimmedRetentionDays) : null,
		newOnly: draft.newOnly,
		priority
	};
	const parsed = seriesRuleCreateSchema.safeParse(candidate);
	if (!parsed.success) {
		const errors: SeriesRuleValidationErrors = {};
		for (const issue of parsed.error.issues) {
			const field = issue.path[0];
			if (field === "title" && !errors.title) {
				errors.title =
					candidate.title.length === 0
						? "Title is required"
						: "Title is too long";
			}
			if (field === "keepCount" && !errors.keepCount) {
				errors.keepCount =
					"Keep count must be a whole number between 1 and 1000";
			}
			if (field === "retentionDays" && !errors.retentionDays) {
				errors.retentionDays =
					"Retention days must be blank or a whole number between 1 and 36500";
			}
			if (field === "priority" && !errors.priority) {
				errors.priority =
					"Priority must be a whole number between -100 and 100";
			}
		}
		return { ok: false, errors };
	}

	return {
		ok: true,
		value: {
			title: parsed.data.title,
			channelId: parsed.data.channelId ?? null,
			keepCount: parsed.data.keepCount,
			retentionDays: parsed.data.retentionDays ?? null,
			newOnly: parsed.data.newOnly,
			priority: parsed.data.priority
		}
	};
}

/** Build a draft pre-filled from an existing rule (for editing). */
export function draftFromSeriesRule(rule: SeriesRule): SeriesRuleDraft {
	return {
		title: rule.title,
		channelId: rule.channelId,
		keepCount: String(rule.keepCount),
		retentionDays:
			rule.retentionDays !== null ? String(rule.retentionDays) : "",
		newOnly: rule.newOnly,
		priority: String(rule.priority)
	};
}

/** Preserve blank required inputs as invalid numbers for shared-schema errors. */
function requiredDraftNumber(value: string): number {
	return value.trim().length > 0 ? Number(value) : Number.NaN;
}
