import { describe, expect, it } from "vitest";
import type {
	Recording,
	RecordingConflict,
	SeriesRule
} from "@signalhaven/shared";

import {
	draftFromSeriesRule,
	initialSchedulerState,
	initialSeriesRuleDraft,
	schedulerReducer,
	selectSortedConflicts,
	selectSortedSeriesRules,
	selectUpcomingRecordings,
	validateSeriesRuleDraft
} from "../../app/_scheduler/state";

/**
 * Pure-state coverage for the U9 scheduler reducer + selectors. The
 * page-level wiring is exercised in `SchedulerPage.test.tsx`.
 */

const REC_BASE: Omit<Recording, "id" | "title" | "channelId" | "status"> = {
	programId: null,
	scheduledStart: "2025-01-01T00:00:00Z",
	scheduledEnd: "2025-01-01T01:00:00Z",
	actualStart: null,
	actualEnd: null,
	startReason: null,
	filePath: null,
	fileSize: null,
	durationSeconds: null,
	errorMessage: null,
	seriesRuleId: null,
	manuallyProtected: false,
	watchedAt: null,
	resumePositionSeconds: null
};

function rec(overrides: Partial<Recording>): Recording {
	return {
		id: "00000000-0000-4000-8000-000000000000",
		title: "Untitled",
		channelId: "00000000-0000-4000-8000-000000000aaa",
		status: "scheduled",
		...REC_BASE,
		...overrides
	};
}

const RULE_BASE: Omit<SeriesRule, "id" | "title"> = {
	channelId: null,
	epgChannelId: null,
	keepCount: 5,
	newOnly: false,
	priority: 0,
	retentionDays: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-01T00:00:00Z"
};

function rule(overrides: Partial<SeriesRule>): SeriesRule {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		title: "Untitled",
		...RULE_BASE,
		...overrides
	};
}

const CONFLICT_BASE: Omit<RecordingConflict, "id" | "detectedAt"> = {
	seriesRuleId: null,
	programId: null,
	channelId: "00000000-0000-4000-8000-000000000aaa",
	title: "Conflicted",
	scheduledStart: "2025-01-01T00:00:00Z",
	scheduledEnd: "2025-01-01T01:00:00Z",
	reason: "tuner_capacity",
	message: "Tuner capacity exceeded",
	conflictsWith: []
};

function conflict(overrides: Partial<RecordingConflict>): RecordingConflict {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		detectedAt: "2025-01-01T00:00:00Z",
		...CONFLICT_BASE,
		...overrides
	};
}

describe("schedulerReducer", () => {
	it("upsert-recording adds new and replaces existing rows by id", () => {
		let state = schedulerReducer(initialSchedulerState, {
			type: "upsert-recording",
			recording: rec({ id: "a" })
		});
		expect(state.recordings).toHaveLength(1);
		state = schedulerReducer(state, {
			type: "upsert-recording",
			recording: rec({ id: "a", title: "Updated" })
		});
		expect(state.recordings).toHaveLength(1);
		expect(state.recordings[0]?.title).toBe("Updated");
	});

	it("remove-recording filters by id", () => {
		const state = schedulerReducer(
			{
				...initialSchedulerState,
				recordings: [rec({ id: "a" }), rec({ id: "b" })]
			},
			{ type: "remove-recording", recordingId: "a" }
		);
		expect(state.recordings.map((r) => r.id)).toEqual(["b"]);
	});

	it("upsert-series-rule replaces an existing rule with the same id", () => {
		let state = schedulerReducer(initialSchedulerState, {
			type: "upsert-series-rule",
			rule: rule({ id: "a", title: "Sherlock" })
		});
		state = schedulerReducer(state, {
			type: "upsert-series-rule",
			rule: rule({ id: "a", title: "Sherlock", keepCount: 99 })
		});
		expect(state.seriesRules).toHaveLength(1);
		expect(state.seriesRules[0]?.keepCount).toBe(99);
	});

	it("add-conflict prepends, but dedupes by id", () => {
		let state = schedulerReducer(initialSchedulerState, {
			type: "add-conflict",
			conflict: conflict({ id: "a" })
		});
		state = schedulerReducer(state, {
			type: "add-conflict",
			conflict: conflict({ id: "b" })
		});
		state = schedulerReducer(state, {
			type: "add-conflict",
			conflict: conflict({ id: "a" })
		});
		expect(state.conflicts.map((c) => c.id)).toEqual(["b", "a"]);
	});

	it("resolve-conflict drops the matching id", () => {
		const state = schedulerReducer(
			{
				...initialSchedulerState,
				conflicts: [conflict({ id: "a" }), conflict({ id: "b" })]
			},
			{ type: "resolve-conflict", conflictId: "a" }
		);
		expect(state.conflicts.map((c) => c.id)).toEqual(["b"]);
	});

	it("set-tab updates the active tab", () => {
		const state = schedulerReducer(initialSchedulerState, {
			type: "set-tab",
			tab: "conflicts"
		});
		expect(state.tab).toBe("conflicts");
	});
});

describe("selectUpcomingRecordings", () => {
	it("filters out completed/failed/cancelled rows and sorts ascending", () => {
		const state = {
			...initialSchedulerState,
			recordings: [
				rec({ id: "a", scheduledStart: "2025-03-10T20:00:00Z" }),
				rec({ id: "b", scheduledStart: "2025-03-08T20:00:00Z" }),
				rec({ id: "c", status: "completed" }),
				rec({ id: "d", status: "failed" }),
				rec({ id: "e", status: "cancelled" }),
				rec({
					id: "f",
					status: "recording",
					scheduledStart: "2025-03-09T20:00:00Z"
				})
			]
		};
		const upcoming = selectUpcomingRecordings(state);
		expect(upcoming.map((r) => r.id)).toEqual(["b", "f", "a"]);
	});
});

describe("selectSortedSeriesRules", () => {
	it("sorts by priority desc, then title asc", () => {
		const state = {
			...initialSchedulerState,
			seriesRules: [
				rule({ id: "a", title: "Zeta", priority: 5 }),
				rule({ id: "b", title: "Alpha", priority: 5 }),
				rule({ id: "c", title: "Mid", priority: 10 })
			]
		};
		expect(selectSortedSeriesRules(state).map((r) => r.id)).toEqual([
			"c",
			"b",
			"a"
		]);
	});
});

describe("selectSortedConflicts", () => {
	it("sorts by detectedAt newest first", () => {
		const state = {
			...initialSchedulerState,
			conflicts: [
				conflict({ id: "a", detectedAt: "2025-01-01T01:00:00Z" }),
				conflict({ id: "b", detectedAt: "2025-01-01T03:00:00Z" }),
				conflict({ id: "c", detectedAt: "2025-01-01T02:00:00Z" })
			]
		};
		expect(selectSortedConflicts(state).map((c) => c.id)).toEqual([
			"b",
			"c",
			"a"
		]);
	});
});

describe("validateSeriesRuleDraft", () => {
	it("requires a non-empty title", () => {
		const r = validateSeriesRuleDraft({ ...initialSeriesRuleDraft, title: "" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.title).toBeTruthy();
	});

	it("rejects keepCount outside 1..1000", () => {
		const tooLow = validateSeriesRuleDraft({
			...initialSeriesRuleDraft,
			title: "Sherlock",
			keepCount: "0"
		});
		expect(tooLow.ok).toBe(false);
		if (!tooLow.ok) expect(tooLow.errors.keepCount).toBeTruthy();
		const tooHigh = validateSeriesRuleDraft({
			...initialSeriesRuleDraft,
			title: "Sherlock",
			keepCount: "1001"
		});
		expect(tooHigh.ok).toBe(false);
		const nonInt = validateSeriesRuleDraft({
			...initialSeriesRuleDraft,
			title: "Sherlock",
			keepCount: "1.5"
		});
		expect(nonInt.ok).toBe(false);
		const empty = validateSeriesRuleDraft({
			...initialSeriesRuleDraft,
			title: "Sherlock",
			keepCount: ""
		});
		expect(empty.ok).toBe(false);
	});

	it("rejects priority outside -100..100", () => {
		const r = validateSeriesRuleDraft({
			...initialSeriesRuleDraft,
			title: "Sherlock",
			priority: "200"
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.priority).toBeTruthy();
	});

	it("accepts a blank age limit and rejects invalid retention days", () => {
		const noAgeLimit = validateSeriesRuleDraft({
			...initialSeriesRuleDraft,
			title: "Sherlock",
			retentionDays: ""
		});
		expect(noAgeLimit.ok).toBe(true);
		if (noAgeLimit.ok) expect(noAgeLimit.value.retentionDays).toBeNull();

		for (const retentionDays of ["-1", "1.5", "36501"]) {
			const result = validateSeriesRuleDraft({
				...initialSeriesRuleDraft,
				title: "Sherlock",
				retentionDays
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errors.retentionDays).toBeTruthy();
		}
	});

	it("returns coerced numeric values when valid", () => {
		const r = validateSeriesRuleDraft({
			title: "  Sherlock  ",
			channelId: "00000000-0000-4000-8000-000000000001",
			keepCount: "10",
			retentionDays: "30",
			newOnly: true,
			priority: "-3"
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toEqual({
				title: "Sherlock",
				channelId: "00000000-0000-4000-8000-000000000001",
				keepCount: 10,
				retentionDays: 30,
				newOnly: true,
				priority: -3
			});
		}
	});
});

describe("draftFromSeriesRule", () => {
	it("populates the draft from an existing rule", () => {
		const draft = draftFromSeriesRule(
			rule({
				title: "X",
				keepCount: 7,
				retentionDays: 30,
				priority: -2,
				newOnly: true
			})
		);
		expect(draft).toEqual({
			title: "X",
			channelId: null,
			keepCount: "7",
			retentionDays: "30",
			priority: "-2",
			newOnly: true
		});
	});
});
