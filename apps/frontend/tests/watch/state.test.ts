import { describe, expect, it } from "vitest";
import type { ChannelListItem, EpgGridProgram } from "@signalhaven/shared";

import {
	orderForSwitcher,
	selectNowProgram,
	selectUpcoming,
	stepChannel
} from "../../app/_watch/state";

function ch(
	id: string,
	number: string,
	overrides: Partial<ChannelListItem> = {}
): ChannelListItem {
	return {
		id,
		number,
		name: `Ch ${number}`,
		logoUrl: null,
		tvgId: null,
		tunerId: "11111111-1111-4111-8111-111111111111",
		tunerName: "Tuner",
		tunerKind: "hdhomerun",
		enabled: true,
		sortOrder: Number.parseInt(number, 10),
		hasMapping: true,
		...overrides
	};
}

function prog(
	id: string,
	channelId: string,
	start: string,
	stop: string,
	title = `Program ${id}`
): EpgGridProgram {
	return {
		id,
		channelId,
		start,
		stop,
		title,
		subtitle: null,
		recordingId: null,
		recordingStatus: null
	};
}

describe("watch/state", () => {
	describe("orderForSwitcher", () => {
		it("places favorites first while retaining canonical order", () => {
			const channels = [ch("a", "5"), ch("b", "10"), ch("c", "7")];
			const ordered = orderForSwitcher(channels, ["c", "a"], []);
			expect(ordered.map((c) => c.id)).toEqual(["a", "c", "b"]);
		});

		it("drops hidden channels entirely", () => {
			const channels = [ch("a", "5"), ch("b", "10"), ch("c", "7")];
			const ordered = orderForSwitcher(channels, [], ["b"]);
			expect(ordered.map((c) => c.id)).toEqual(["a", "c"]);
		});

		it("uses the server canonical order when no manual order exists", () => {
			const channels = [ch("a", "100"), ch("b", "5.10"), ch("c", "5.2")];
			const ordered = orderForSwitcher(channels, [], []);
			expect(ordered.map((c) => c.id)).toEqual(["b", "c", "a"]);
		});

		it("preserves manual order among equally ranked channels", () => {
			const channels = [ch("a", "5"), ch("b", "10"), ch("c", "7")];
			const ordered = orderForSwitcher(
				channels,
				["a", "c"],
				[],
				["b", "c", "a"]
			);
			expect(ordered.map((c) => c.id)).toEqual(["c", "a", "b"]);
		});

		it("ignores favorites that point at unknown channels", () => {
			const channels = [ch("a", "5")];
			const ordered = orderForSwitcher(channels, ["zzz", "a"], []);
			expect(ordered.map((c) => c.id)).toEqual(["a"]);
		});
	});

	describe("stepChannel", () => {
		const ordered = [ch("a", "1"), ch("b", "2"), ch("c", "3")];

		it("walks forward and wraps", () => {
			expect(stepChannel(ordered, "a", 1)?.id).toBe("b");
			expect(stepChannel(ordered, "c", 1)?.id).toBe("a");
		});

		it("walks backward and wraps", () => {
			expect(stepChannel(ordered, "b", -1)?.id).toBe("a");
			expect(stepChannel(ordered, "a", -1)?.id).toBe("c");
		});

		it("falls back to the first channel when the current id is unknown", () => {
			expect(stepChannel(ordered, "missing", 1)?.id).toBe("a");
		});

		it("returns null for an empty list", () => {
			expect(stepChannel([], "a", 1)).toBeNull();
		});
	});

	describe("EPG selectors", () => {
		const NOW = new Date("2026-01-01T12:00:00Z");
		const programs: EpgGridProgram[] = [
			prog("p1", "a", "2026-01-01T11:00:00Z", "2026-01-01T12:00:00Z", "Past"),
			prog("p2", "a", "2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z", "Now"),
			prog("p3", "a", "2026-01-01T13:00:00Z", "2026-01-01T14:00:00Z", "Next"),
			prog("p4", "b", "2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z", "Other")
		];

		it("selectNowProgram returns the program containing `now`", () => {
			expect(selectNowProgram(programs, "a", NOW)?.id).toBe("p2");
		});

		it("selectNowProgram returns null when nothing is airing", () => {
			expect(
				selectNowProgram(programs, "a", new Date("2026-01-01T15:00:00Z"))
			).toBeNull();
		});

		it("selectUpcoming returns ascending future-or-current entries for channel", () => {
			const next = selectUpcoming(programs, "a", NOW, 5);
			expect(next.map((p) => p.id)).toEqual(["p2", "p3"]);
		});

		it("selectUpcoming respects the limit", () => {
			const next = selectUpcoming(programs, "a", NOW, 1);
			expect(next.map((p) => p.id)).toEqual(["p2"]);
		});

		it("selectUpcoming filters by channel", () => {
			const next = selectUpcoming(programs, "b", NOW, 5);
			expect(next.map((p) => p.id)).toEqual(["p4"]);
		});
	});
});
