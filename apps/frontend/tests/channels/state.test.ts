import { describe, expect, it } from "vitest";

import { buildChannelsFixture } from "../../app/_channels/fixtures";
import {
	channelsReducer,
	compareChannelNumber,
	filterChannels,
	groupChannels,
	initialChannelsState,
	reorderList,
	selectVisibleChannels,
	sortChannels,
	type ChannelsAction,
	type ChannelsState
} from "../../app/_channels/state";

/**
 * Component tests for the U5-channels reducer (per the issue's "Testing"
 * acceptance criterion). Covers every action plus the pure selectors so
 * the page only has to render correctly given the state shape.
 */

const FIXTURE = buildChannelsFixture();

function freshState(): ChannelsState {
	return {
		...initialChannelsState,
		channels: FIXTURE,
		selection: new Set<string>()
	};
}

function apply(state: ChannelsState, ...actions: ChannelsAction[]) {
	return actions.reduce(channelsReducer, state);
}

describe("channelsReducer", () => {
	describe("filters", () => {
		it("set-search filters by name (case-insensitive)", () => {
			const next = apply(freshState(), {
				type: "set-search",
				search: " ESPN "
			});
			const visible = selectVisibleChannels(next);
			expect(visible.map((c) => c.name)).toEqual(["ESPN"]);
		});

		it("set-search also matches the channel number", () => {
			const next = apply(freshState(), { type: "set-search", search: "5.1" });
			expect(selectVisibleChannels(next).map((c) => c.name)).toEqual(["FOX"]);
		});

		it("set-tuner scopes to a single tuner", () => {
			const tunerId = FIXTURE[0]!.tunerId;
			const next = apply(freshState(), { type: "set-tuner", tunerId });
			const visible = selectVisibleChannels(next);
			expect(visible.length).toBeGreaterThan(0);
			expect(visible.every((c) => c.tunerId === tunerId)).toBe(true);
		});

		it("visibility=favorites limits to favorited channels", () => {
			const id = FIXTURE[0]!.id;
			const next = apply(
				freshState(),
				{ type: "toggle-favorite", channelId: id },
				{ type: "set-visibility", visibility: "favorites" }
			);
			expect(selectVisibleChannels(next).map((c) => c.id)).toEqual([id]);
		});

		it("hidden channels are excluded by default but shown under visibility=hidden", () => {
			const id = FIXTURE[0]!.id;
			const hidden = apply(freshState(), {
				type: "toggle-hidden",
				channelId: id
			});
			expect(
				selectVisibleChannels(hidden).find((c) => c.id === id)
			).toBeUndefined();

			const showHidden = apply(hidden, {
				type: "set-visibility",
				visibility: "hidden"
			});
			expect(selectVisibleChannels(showHidden).map((c) => c.id)).toEqual([id]);
		});
	});

	describe("favorites", () => {
		it("toggle-favorite adds and removes the channel from prefs.favorites", () => {
			const id = FIXTURE[0]!.id;
			const added = apply(freshState(), {
				type: "toggle-favorite",
				channelId: id
			});
			expect(added.prefs.favorites).toEqual([id]);

			const removed = apply(added, { type: "toggle-favorite", channelId: id });
			expect(removed.prefs.favorites).toEqual([]);
		});
	});

	describe("sort", () => {
		it("sort=name orders alphabetically", () => {
			const sorted = sortChannels(FIXTURE, "name", initialChannelsState.prefs);
			const names = sorted.map((c) => c.name);
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		});

		it("sort=number uses natural numeric order", () => {
			const sorted = sortChannels(
				FIXTURE,
				"number",
				initialChannelsState.prefs
			);
			const numbers = sorted.map((c) => c.number);
			// 2.1 < 4.1 < 5.1 < 7.1 < 11.1 < 13.1 < 100 < 101 < 102 < 103
			expect(numbers).toEqual([
				"2.1",
				"4.1",
				"5.1",
				"7.1",
				"11.1",
				"13.1",
				"100",
				"101",
				"102",
				"103"
			]);
		});

		it("sort=favorites-first bubbles favorited channels to the top", () => {
			const fav1 = FIXTURE[5]!.id;
			const fav2 = FIXTURE[2]!.id;
			const sorted = sortChannels(FIXTURE, "favorites-first", {
				favorites: [fav1, fav2],
				hidden: [],
				order: []
			});
			expect(
				sorted
					.slice(0, 2)
					.map((c) => c.id)
					.sort()
			).toEqual([fav1, fav2].sort());
		});

		it("sort=manual honors prefs.order, falling back to canonical for unlisted ids", () => {
			const a = FIXTURE[3]!.id;
			const b = FIXTURE[1]!.id;
			const sorted = sortChannels(FIXTURE, "manual", {
				favorites: [],
				hidden: [],
				order: [a, b]
			});
			// The two ordered ids appear first, in the requested order.
			expect(sorted.slice(0, 2).map((c) => c.id)).toEqual([a, b]);
			// Remaining channels are appended in canonical sortOrder.
			const tail = sorted.slice(2);
			const tailOrders = tail.map((c) => c.sortOrder);
			expect(tailOrders).toEqual([...tailOrders].sort((x, y) => x - y));
		});
	});

	describe("compareChannelNumber", () => {
		it("orders dotted numbers by major then minor", () => {
			expect(compareChannelNumber("5.1", "10.1")).toBeLessThan(0);
			expect(compareChannelNumber("5.10", "5.2")).toBeGreaterThan(0);
			expect(compareChannelNumber("100", "100")).toBe(0);
		});
	});

	describe("selection + bulk actions", () => {
		it("toggle-selection adds and removes ids from the selection set", () => {
			const id = FIXTURE[0]!.id;
			let s = apply(freshState(), { type: "toggle-selection", channelId: id });
			expect(s.selection.has(id)).toBe(true);
			s = apply(s, { type: "toggle-selection", channelId: id });
			expect(s.selection.has(id)).toBe(false);
		});

		it("select-all replaces the selection with the provided ids", () => {
			const ids = FIXTURE.slice(0, 3).map((c) => c.id);
			const s = apply(freshState(), { type: "select-all", channelIds: ids });
			expect(Array.from(s.selection).sort()).toEqual([...ids].sort());
		});

		it("bulk-hide hides every selected id and clears the selection", () => {
			const ids = FIXTURE.slice(0, 3).map((c) => c.id);
			const s = apply(freshState(), { type: "bulk-hide", channelIds: ids });
			expect(s.prefs.hidden).toEqual(ids);
			expect(s.selection.size).toBe(0);
		});

		it("bulk-hide is idempotent — already-hidden ids are not duplicated", () => {
			const ids = [FIXTURE[0]!.id, FIXTURE[1]!.id];
			const s = apply(
				freshState(),
				{ type: "bulk-hide", channelIds: ids },
				{ type: "bulk-hide", channelIds: [ids[0]!, FIXTURE[2]!.id] }
			);
			expect(s.prefs.hidden).toEqual([ids[0], ids[1], FIXTURE[2]!.id]);
		});

		it("bulk-unhide removes ids from prefs.hidden and clears the selection", () => {
			const ids = FIXTURE.slice(0, 3).map((c) => c.id);
			const s = apply(
				freshState(),
				{ type: "bulk-hide", channelIds: ids },
				{ type: "select-all", channelIds: ids },
				{ type: "bulk-unhide", channelIds: [ids[0]!, ids[2]!] }
			);
			expect(s.prefs.hidden).toEqual([ids[1]]);
			expect(s.selection.size).toBe(0);
		});
	});

	describe("reorder / drag", () => {
		it("reorderList moves a channel before the target", () => {
			const order = ["a", "b", "c", "d"];
			expect(reorderList(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
		});

		it("reorderList(null) moves the channel to the end", () => {
			const order = ["a", "b", "c"];
			expect(reorderList(order, "a", null)).toEqual(["b", "c", "a"]);
		});

		it("reorderList is a no-op when channelId === beforeId", () => {
			const order = ["a", "b", "c"];
			expect(reorderList(order, "a", "a")).toBe(order);
		});

		it("reorderList appends both ids when the target is unknown, with the moved id first", () => {
			// Drag onto a channel that hasn't been customised yet — a ends up
			// immediately before z.
			expect(reorderList(["a"], "a", "z")).toEqual(["a", "z"]);
		});

		it("reduce: reorder switches sort to manual and updates prefs.order", () => {
			const a = FIXTURE[5]!.id;
			const b = FIXTURE[1]!.id;
			const next = apply(freshState(), {
				type: "reorder",
				channelId: a,
				beforeId: b
			});
			expect(next.sort).toBe("manual");
			expect(next.prefs.order.indexOf(a)).toBeLessThan(
				next.prefs.order.indexOf(b)
			);
		});
	});

	describe("grouping", () => {
		it("groupBy=tuner groups channels by tunerId", () => {
			const groups = groupChannels(FIXTURE, "tuner");
			expect(groups.length).toBe(2);
			const allChannels = groups.flatMap((g) => g.channels);
			expect(allChannels.length).toBe(FIXTURE.length);
			// Every group's channels share a tuner.
			for (const group of groups) {
				const tunerIds = new Set(group.channels.map((c) => c.tunerId));
				expect(tunerIds.size).toBe(1);
			}
		});

		it("groupBy=none returns a single group with every channel", () => {
			const groups = groupChannels(FIXTURE, "none");
			expect(groups).toHaveLength(1);
			expect(groups[0]!.channels).toEqual(FIXTURE);
		});
	});

	describe("filterChannels — sanity", () => {
		it("returns the full list when filters are empty", () => {
			expect(
				filterChannels(
					FIXTURE,
					initialChannelsState.filters,
					initialChannelsState.prefs
				)
			).toEqual(FIXTURE);
		});
	});

	describe("set-prefs", () => {
		it("replaces the entire prefs document (used when settings load)", () => {
			const id = FIXTURE[0]!.id;
			const s = apply(freshState(), {
				type: "set-prefs",
				prefs: { favorites: [id], hidden: [], order: [] }
			});
			expect(s.prefs.favorites).toEqual([id]);
		});
	});
});
