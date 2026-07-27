import { describe, expect, it } from "vitest";
import type { RecordingListItem } from "@signalhaven/shared";

import {
	filterRecordings,
	formatBytes,
	formatDuration,
	groupRecordings,
	initialRecordingsState,
	recordingsReducer,
	selectVisibleRecordings,
	sortRecordings
} from "../../app/_recordings/state";

/**
 * Pure-state coverage for the U8 recordings reducer + selectors. The
 * page-level wiring is exercised in `RecordingsPage.test.tsx`.
 */

const REC_BASE: Omit<RecordingListItem, "id" | "title" | "channelId"> = {
	programId: null,
	status: "completed",
	scheduledStart: "2025-01-01T00:00:00Z",
	scheduledEnd: "2025-01-01T01:00:00Z",
	actualStart: null,
	actualEnd: null,
	startReason: null,
	filePath: null,
	fileSize: 1_000_000,
	durationSeconds: 1800,
	errorMessage: null,
	seriesRuleId: null,
	manuallyProtected: false,
	watchedAt: null,
	resumePositionSeconds: null,
	metadata: null
};

function rec(overrides: Partial<RecordingListItem>): RecordingListItem {
	return {
		id: overrides.id ?? "00000000-0000-4000-8000-000000000000",
		title: overrides.title ?? "Untitled",
		channelId: overrides.channelId ?? "00000000-0000-4000-8000-000000000aaa",
		...REC_BASE,
		...overrides
	};
}

describe("recordingsReducer", () => {
	it("set-recordings replaces the source list", () => {
		const next = recordingsReducer(initialRecordingsState, {
			type: "set-recordings",
			recordings: [rec({ id: "r1", title: "A" })]
		});
		expect(next.recordings).toHaveLength(1);
		expect(next.recordings[0]?.id).toBe("r1");
	});

	it("toggle-selection adds and removes ids", () => {
		let state = recordingsReducer(initialRecordingsState, {
			type: "toggle-selection",
			recordingId: "r1"
		});
		expect(state.selection.has("r1")).toBe(true);
		state = recordingsReducer(state, {
			type: "toggle-selection",
			recordingId: "r1"
		});
		expect(state.selection.has("r1")).toBe(false);
	});

	it("remove-recordings drops rows AND clears them from the selection", () => {
		const seeded = recordingsReducer(initialRecordingsState, {
			type: "set-recordings",
			recordings: [rec({ id: "r1", title: "A" }), rec({ id: "r2", title: "B" })]
		});
		const selected = recordingsReducer(
			recordingsReducer(seeded, {
				type: "toggle-selection",
				recordingId: "r1"
			}),
			{ type: "toggle-selection", recordingId: "r2" }
		);
		const next = recordingsReducer(selected, {
			type: "remove-recordings",
			recordingIds: ["r1"]
		});
		expect(next.recordings.map((r) => r.id)).toEqual(["r2"]);
		expect(next.selection.has("r1")).toBe(false);
		expect(next.selection.has("r2")).toBe(true);
	});

	it("clear-filters resets every filter to defaults", () => {
		let state = recordingsReducer(initialRecordingsState, {
			type: "set-search",
			search: "news"
		});
		state = recordingsReducer(state, { type: "set-status", status: "failed" });
		state = recordingsReducer(state, { type: "clear-filters" });
		expect(state.filters).toEqual(initialRecordingsState.filters);
	});
});

describe("filterRecordings + selectVisibleRecordings", () => {
	const rows = [
		rec({
			id: "r1",
			title: "Soccer Final",
			status: "completed",
			channelId: "ch-a",
			scheduledStart: "2025-03-01T10:00:00Z"
		}),
		rec({
			id: "r2",
			title: "Evening News",
			status: "scheduled",
			channelId: "ch-b",
			scheduledStart: "2025-03-02T20:00:00Z"
		}),
		rec({
			id: "r3",
			title: "Soccer Recap",
			status: "completed",
			channelId: "ch-a",
			scheduledStart: "2025-04-10T10:00:00Z"
		})
	];

	it("filters by status, channel, search and date range", () => {
		expect(
			filterRecordings(rows, {
				...initialRecordingsState.filters,
				search: "soccer"
			}).map((r) => r.id)
		).toEqual(["r1", "r3"]);

		expect(
			filterRecordings(rows, {
				...initialRecordingsState.filters,
				status: "scheduled"
			}).map((r) => r.id)
		).toEqual(["r2"]);

		expect(
			filterRecordings(rows, {
				...initialRecordingsState.filters,
				channelId: "ch-a"
			}).map((r) => r.id)
		).toEqual(["r1", "r3"]);

		expect(
			filterRecordings(rows, {
				...initialRecordingsState.filters,
				from: "2025-04-01",
				to: "2025-05-01"
			}).map((r) => r.id)
		).toEqual(["r3"]);
	});

	it("sortRecordings orders newest-first by scheduledStart", () => {
		const sorted = sortRecordings(rows);
		expect(sorted.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
	});

	it("selectVisibleRecordings composes filter + sort", () => {
		const seeded = recordingsReducer(initialRecordingsState, {
			type: "set-recordings",
			recordings: rows
		});
		const next = recordingsReducer(seeded, {
			type: "set-search",
			search: "soccer"
		});
		expect(selectVisibleRecordings(next).map((r) => r.id)).toEqual([
			"r3",
			"r1"
		]);
	});
});

describe("groupRecordings", () => {
	const rows = [
		rec({
			id: "r1",
			title: "Sherlock S01E01",
			seriesRuleId: "series-a",
			fileSize: 1_000_000_000
		}),
		rec({
			id: "r2",
			title: "Sherlock S01E02",
			seriesRuleId: "series-a",
			fileSize: 2_000_000_000
		}),
		rec({
			id: "r3",
			title: "One-off Movie",
			seriesRuleId: null,
			fileSize: 3_000_000_000
		})
	];

	it("returns a single bucket when groupBy === 'none'", () => {
		const groups = groupRecordings(rows, "none");
		expect(groups).toHaveLength(1);
		expect(groups[0]?.recordings).toHaveLength(3);
	});

	it("buckets by seriesRuleId and surfaces totalSize", () => {
		const groups = groupRecordings(rows, "series");
		expect(groups).toHaveLength(2);
		const series = groups.find((g) => g.key === "series-a");
		expect(series?.isSeries).toBe(true);
		expect(series?.recordings).toHaveLength(2);
		expect(series?.totalSize).toBe(3_000_000_000);
		const oneoff = groups.find((g) => g.key === "__none__");
		expect(oneoff?.isSeries).toBe(false);
		expect(oneoff?.totalSize).toBe(3_000_000_000);
	});

	it("orders series groups before the one-off bucket", () => {
		const groups = groupRecordings(rows, "series");
		expect(groups[0]?.isSeries).toBe(true);
		expect(groups[groups.length - 1]?.isSeries).toBe(false);
	});
});

describe("formatters", () => {
	it("formatBytes scales through the unit ladder", () => {
		expect(formatBytes(0)).toBe("—");
		expect(formatBytes(null)).toBe("—");
		expect(formatBytes(900)).toBe("900 B");
		expect(formatBytes(1500)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
		expect(formatBytes(1024 * 1024 * 1024 * 50)).toBe("50 GB");
	});

	it("formatDuration switches between m:ss and h:mm:ss", () => {
		expect(formatDuration(null)).toBe("—");
		expect(formatDuration(0)).toBe("—");
		expect(formatDuration(75)).toBe("1:15");
		expect(formatDuration(3661)).toBe("1:01:01");
	});
});
