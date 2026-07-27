/** Channels exposed by the Lighthouse guide fixture. */
export const epgGridChannels = [
	{
		id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000000",
		number: "100",
		name: "SignalHaven Demo 1",
		logoUrl: null,
		hasMapping: true
	},
	{
		id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
		number: "101",
		name: "SignalHaven Demo 2",
		logoUrl: null,
		hasMapping: true
	}
];

/** Give each channel and half-hour slot an identity that survives range expansion. */
function programId(channelIndex, startMs) {
	const slot = Math.floor(startMs / (30 * 60_000));
	const token = `${channelIndex.toString(16).padStart(4, "0")}${slot
		.toString(16)
		.padStart(8, "0")}`;
	return `bbbbbbbb-bbbb-4bbb-8bbb-${token}`;
}

/** Build guide data whose overlapping programs stay identical across requests. */
export function buildEpgGrid(fromIso, toIso) {
	const fromDate = new Date(fromIso);
	const toDate = new Date(toIso);
	const from = Number.isNaN(fromDate.getTime())
		? new Date(Date.now() - 60 * 60_000)
		: fromDate;
	const to = Number.isNaN(toDate.getTime())
		? new Date(from.getTime() + 24 * 60 * 60_000)
		: toDate;

	const programs = [];
	for (const [channelIndex, ch] of epgGridChannels.entries()) {
		let cursor = from.getTime();
		while (cursor < to.getTime()) {
			const stop = new Date(cursor + 30 * 60_000);
			const slotOfDay = Math.floor(
				(cursor % (24 * 60 * 60_000)) / (30 * 60_000)
			);
			programs.push({
				id: programId(channelIndex, cursor),
				channelId: ch.id,
				start: new Date(cursor).toISOString(),
				stop: stop.toISOString(),
				title: `Program ${channelIndex * 48 + slotOfDay + 1}`,
				subtitle: null,
				description: "Lighthouse mock fixture.",
				categories: ["News"],
				recordingId: null,
				recordingStatus: null
			});
			cursor = stop.getTime();
		}
	}

	return {
		from: from.toISOString(),
		to: to.toISOString(),
		channels: epgGridChannels,
		programs
	};
}
