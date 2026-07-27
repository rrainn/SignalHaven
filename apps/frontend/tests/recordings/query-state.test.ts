import { describe, expect, it } from "vitest";

import {
	parseRecordingsUrlState,
	safeRecordingsReturnPath,
	serializeRecordingsUrlState,
	toRecordingListQuery
} from "../../app/_recordings/query-state";

describe("recordings URL state", () => {
	it("round-trips filters, sorting, display, and loaded pages", () => {
		const parsed = parseRecordingsUrlState(
			new URLSearchParams({
				search: "mountain news",
				status: "completed",
				channel: "11111111-1111-4111-8111-111111111111",
				from: "2026-01-01",
				to: "2026-02-01",
				sort: "actualStart",
				direction: "asc",
				view: "list",
				group: "series",
				pages: "3"
			})
		);

		expect(parsed.pageCount).toBe(3);
		expect(parsed.filters.status).toBe("completed");
		expect(serializeRecordingsUrlState(parsed)).toContain("pages=3");
		const query = toRecordingListQuery(parsed);
		expect(query).toEqual(
			expect.objectContaining({
				search: "mountain news",
				status: "completed",
				sort: "actualStart",
				direction: "asc"
			})
		);
		expect(query.from).toMatch(/^2026-01-01T/);
	});

	it("rejects invalid or external navigation state", () => {
		const parsed = parseRecordingsUrlState(
			new URLSearchParams({
				status: "unknown",
				channel: "not-a-uuid",
				from: "not-a-date",
				sort: "unknown",
				pages: "999999"
			})
		);
		expect(parsed.filters.status).toBeNull();
		expect(parsed.filters.channelId).toBeNull();
		expect(parsed.filters.from).toBeNull();
		expect(parsed.sort).toBe("scheduledStart");
		expect(parsed.pageCount).toBe(1_000);
		expect(safeRecordingsReturnPath("https://example.com")).toBe("/recordings");
		expect(safeRecordingsReturnPath("//example.com")).toBe("/recordings");
	});
});
