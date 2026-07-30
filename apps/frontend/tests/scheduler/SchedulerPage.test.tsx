import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
	Recording,
	RecordingConflict,
	SeriesRule
} from "@signalhaven/shared";

import { SchedulerPage } from "../../app/_scheduler/SchedulerPage";

/**
 * Wiring smoke tests for the U9 scheduler page. Pure reducer + selector
 * logic is covered in `state.test.ts`; this file verifies the dispatch
 * wiring (cancel, drop conflict, accept conflict, edit rule) and the
 * test seams used by the e2e mock.
 */

const REC_BASE = {
	programId: null,
	scheduledStart: "2025-03-10T20:00:00Z",
	scheduledEnd: "2025-03-10T21:00:00Z",
	actualStart: null,
	actualEnd: null,
	startReason: null,
	filePath: null,
	fileSize: null,
	durationSeconds: null,
	errorMessage: null,
	manuallyProtected: false,
	watchedAt: null,
	resumePositionSeconds: null,
	seriesRuleId: null
} as const;

function rec(overrides: Partial<Recording>): Recording {
	return {
		id: "00000000-0000-4000-8000-000000000000",
		channelId: "00000000-0000-4000-8000-000000000aaa",
		title: "Untitled",
		status: "scheduled",
		...REC_BASE,
		...overrides
	};
}

const RULE_BASE = {
	channelId: null,
	epgChannelId: null,
	keepCount: 5,
	episodePolicy: "all",
	newOnly: false,
	priority: 0,
	retentionDays: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-01T00:00:00Z"
} as const;

function rule(overrides: Partial<SeriesRule>): SeriesRule {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		title: "Existing show",
		...RULE_BASE,
		...overrides
	};
}

function conflict(overrides: Partial<RecordingConflict>): RecordingConflict {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		seriesRuleId: null,
		programId: null,
		channelId: "00000000-0000-4000-8000-000000000aaa",
		title: "Big game",
		scheduledStart: "2025-03-10T20:00:00Z",
		scheduledEnd: "2025-03-10T22:00:00Z",
		reason: "tuner_capacity",
		message: "Tuner capacity exceeded by 1 at 20:00",
		conflictsWith: [],
		detectedAt: "2025-01-01T00:00:00Z",
		...overrides
	};
}

describe("SchedulerPage", () => {
	it("lists upcoming recordings sorted with quick-cancel buttons", () => {
		render(
			<SchedulerPage
				initialRecordings={[
					rec({
						id: "a",
						title: "Sherlock",
						scheduledStart: "2025-03-08T20:00:00Z"
					}),
					rec({
						id: "b",
						title: "Doctor Who",
						scheduledStart: "2025-03-10T20:00:00Z"
					}),
					rec({ id: "c", title: "Done", status: "completed" })
				]}
				enableWebSocket={false}
			/>
		);

		const list = screen.getByTestId("scheduler-upcoming-list");
		const items = within(list).getAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]?.textContent).toContain("Sherlock");
		expect(items[1]?.textContent).toContain("Doctor Who");
	});

	it("cancel button asks for confirmation, then invokes onCancelRecording", async () => {
		const user = userEvent.setup();
		const onCancelRecording = vi.fn().mockResolvedValue(undefined);
		render(
			<SchedulerPage
				initialRecordings={[rec({ id: "a", title: "Sherlock" })]}
				onCancelRecording={onCancelRecording}
				enableWebSocket={false}
			/>
		);
		await user.click(screen.getByTestId("scheduler-upcoming-cancel-a"));
		expect(screen.getByTestId("scheduler-cancel-confirm")).toBeInTheDocument();
		await user.click(screen.getByTestId("scheduler-cancel-confirm-button"));
		expect(onCancelRecording).toHaveBeenCalledWith("a");
		expect(
			screen.queryByTestId("scheduler-upcoming-a")
		).not.toBeInTheDocument();
	});

	it("creates a series rule from the editor modal", async () => {
		const user = userEvent.setup();
		const created = rule({
			id: "r1",
			title: "Sherlock",
			keepCount: 5,
			episodePolicy: "all",
			priority: 0
		});
		const onCreateSeriesRule = vi.fn().mockResolvedValue(created);
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[]}
				initialConflicts={[]}
				onCreateSeriesRule={onCreateSeriesRule}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-series"));
		await user.click(screen.getByTestId("scheduler-new-rule"));
		await user.type(screen.getByTestId("series-rule-title"), "Sherlock");
		await user.click(screen.getByTestId("series-rule-submit"));

		expect(onCreateSeriesRule).toHaveBeenCalledWith({
			title: "Sherlock",
			channelId: null,
			keepCount: 5,
			retentionDays: null,
			episodePolicy: "all",
			priority: 0
		});
		// The newly-created rule appears in the list.
		expect(
			await screen.findByTestId("scheduler-series-r1")
		).toBeInTheDocument();
	});

	it("opens the editor pre-seeded when editing an existing rule", async () => {
		const user = userEvent.setup();
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[
					rule({
						id: "r1",
						title: "Editme",
						keepCount: 7,
						retentionDays: 30
					})
				]}
				initialConflicts={[]}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-series"));
		await user.click(screen.getByTestId("scheduler-series-edit-r1"));
		expect(screen.getByTestId("series-rule-title")).toHaveValue("Editme");
		expect(screen.getByTestId("series-rule-keep-count")).toHaveValue(7);
		expect(screen.getByTestId("series-rule-retention-days")).toHaveValue(30);
	});

	it("summarizes count-only and age-limited retention policies", async () => {
		const user = userEvent.setup();
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[
					rule({ id: "r1", title: "Count only", keepCount: 7 }),
					rule({
						id: "r2",
						title: "Age limited",
						keepCount: 3,
						retentionDays: 30
					})
				]}
				initialConflicts={[]}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-series"));
		expect(screen.getByTestId("scheduler-series-r1")).toHaveTextContent(
			"No age limit"
		);
		expect(screen.getByTestId("scheduler-series-r2")).toHaveTextContent(
			"Delete after 30 days"
		);
	});

	it("preserves the existing rule when an edit fails", async () => {
		const user = userEvent.setup();
		const onUpdateSeriesRule = vi
			.fn()
			.mockRejectedValue(new Error("Could not save retention policy"));
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[
					rule({ id: "r1", title: "Editme", retentionDays: null })
				]}
				initialConflicts={[]}
				onUpdateSeriesRule={onUpdateSeriesRule}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-series"));
		await user.click(screen.getByTestId("scheduler-series-edit-r1"));
		await user.type(screen.getByTestId("series-rule-retention-days"), "30");
		await user.click(screen.getByTestId("series-rule-submit"));

		expect(
			await screen.findByText("Could not save retention policy")
		).toBeInTheDocument();
		expect(screen.getByTestId("series-rule-retention-days")).toHaveValue(30);
		expect(screen.getByTestId("scheduler-series-r1")).toHaveTextContent(
			"No age limit"
		);
	});

	it("deletes a series rule after confirmation", async () => {
		const user = userEvent.setup();
		const onDeleteSeriesRule = vi.fn().mockResolvedValue(undefined);
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[rule({ id: "r1", title: "Sherlock" })]}
				initialConflicts={[]}
				onDeleteSeriesRule={onDeleteSeriesRule}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-series"));
		await user.click(screen.getByTestId("scheduler-series-delete-r1"));
		await user.click(
			screen.getByTestId("scheduler-delete-rule-confirm-button")
		);
		expect(onDeleteSeriesRule).toHaveBeenCalledWith("r1");
		expect(screen.queryByTestId("scheduler-series-r1")).not.toBeInTheDocument();
	});

	it("renders conflicts with drop + accept controls", async () => {
		const user = userEvent.setup();
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[]}
				initialConflicts={[conflict({ id: "c1" })]}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-conflicts"));
		expect(screen.getByTestId("scheduler-conflict-c1")).toBeInTheDocument();
		expect(screen.getByTestId("scheduler-conflicts-count")).toHaveTextContent(
			"1"
		);

		await user.click(screen.getByTestId("scheduler-conflict-accept-c1"));
		expect(
			screen.queryByTestId("scheduler-conflict-c1")
		).not.toBeInTheDocument();
	});

	it("conflict drop cancels the linked recording", async () => {
		const user = userEvent.setup();
		const onCancelRecording = vi.fn().mockResolvedValue(undefined);
		render(
			<SchedulerPage
				initialRecordings={[rec({ id: "a", programId: "prog-1" })]}
				initialSeriesRules={[]}
				initialConflicts={[conflict({ id: "c1", programId: "prog-1" })]}
				onCancelRecording={onCancelRecording}
				enableWebSocket={false}
			/>
		);

		await user.click(screen.getByTestId("scheduler-tab-conflicts"));
		await user.click(screen.getByTestId("scheduler-conflict-drop-c1"));
		expect(onCancelRecording).toHaveBeenCalledWith("a");
		expect(
			screen.queryByTestId("scheduler-conflict-c1")
		).not.toBeInTheDocument();
	});

	it("shows the empty state when nothing is upcoming", () => {
		render(
			<SchedulerPage
				initialRecordings={[]}
				initialSeriesRules={[]}
				initialConflicts={[]}
				enableWebSocket={false}
			/>
		);
		expect(screen.getByTestId("scheduler-upcoming-empty")).toBeInTheDocument();
	});
});
