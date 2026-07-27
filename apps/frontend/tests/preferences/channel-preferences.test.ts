import type { ChannelListItem } from "@signalhaven/shared";
import { describe, expect, it } from "vitest";

import { selectPreferredChannels } from "../../app/_preferences/channel-preferences";

function channel(id: string, sortOrder: number): ChannelListItem {
	return {
		id,
		number: String(sortOrder),
		name: `Channel ${sortOrder}`,
		logoUrl: null,
		tvgId: null,
		tunerId: "11111111-1111-4111-8111-111111111111",
		tunerName: "Tuner",
		tunerKind: "hdhomerun",
		enabled: true,
		sortOrder,
		hasMapping: true
	};
}

describe("selectPreferredChannels", () => {
	const channels = [
		channel("a", 1),
		channel("b", 2),
		channel("c", 3),
		channel("d", 4)
	];

	it("excludes hidden and disabled channels from normal navigation", () => {
		const disabled = { ...channels[3]!, enabled: false };
		const selected = selectPreferredChannels(
			[...channels.slice(0, 3), disabled],
			{
				favorites: [],
				hidden: ["b"],
				order: []
			}
		);

		expect(selected.map((item) => item.id)).toEqual(["a", "c"]);
	});

	it("honors manual order and appends missing entries in source order", () => {
		const selected = selectPreferredChannels(channels, {
			favorites: [],
			hidden: [],
			order: ["c", "a", "missing"]
		});

		expect(selected.map((item) => item.id)).toEqual(["c", "a", "b", "d"]);
	});

	it("ranks favorites first while preserving manual order within each rank", () => {
		const selected = selectPreferredChannels(channels, {
			favorites: ["a", "c"],
			hidden: [],
			order: ["d", "c", "b", "a"]
		});

		// The favorites array is membership-only; manual order remains authoritative.
		expect(selected.map((item) => item.id)).toEqual(["c", "a", "d", "b"]);
	});

	it("handles duplicate and unknown preference entries deterministically", () => {
		const selected = selectPreferredChannels(channels, {
			favorites: ["c", "c", "unknown"],
			hidden: ["unknown"],
			order: ["b", "b", "unknown", "a"]
		});

		expect(selected.map((item) => item.id)).toEqual(["c", "b", "a", "d"]);
	});

	it("preserves source order when canonical ranks tie", () => {
		const tied = [channel("z", 1), channel("a", 1), channel("m", 1)];
		const selected = selectPreferredChannels(tied, {
			favorites: [],
			hidden: [],
			order: []
		});

		expect(selected.map((item) => item.id)).toEqual(["z", "a", "m"]);
	});
});
