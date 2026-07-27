import type { ChannelListItem } from "@signalhaven/shared";

/**
 * Deterministic fixture for the channel-centric list view.
 *
 * The values are hand-written rather than generated so the dev preview
 * shows recognizable channel names and the test snapshots stay stable.
 * Two tuners are used so the grouping / tuner-filter UI has something
 * meaningful to show in the dev preview.
 */

const TUNER_ANTENNA = "11111111-1111-4111-8111-111111111111";
const TUNER_IPTV = "22222222-2222-4222-8222-222222222222";

interface Seed {
	number: string;
	name: string;
	tunerId: string;
	tvgId: string | null;
	hasMapping: boolean;
}

const SEEDS: Seed[] = [
	{
		number: "2.1",
		name: "Local News",
		tunerId: TUNER_ANTENNA,
		tvgId: "wcbs.tv",
		hasMapping: true
	},
	{
		number: "4.1",
		name: "NBC",
		tunerId: TUNER_ANTENNA,
		tvgId: "nbc.tv",
		hasMapping: true
	},
	{
		number: "5.1",
		name: "FOX",
		tunerId: TUNER_ANTENNA,
		tvgId: "fox.tv",
		hasMapping: true
	},
	{
		number: "7.1",
		name: "ABC",
		tunerId: TUNER_ANTENNA,
		tvgId: null,
		hasMapping: false
	},
	{
		number: "11.1",
		name: "PBS",
		tunerId: TUNER_ANTENNA,
		tvgId: "pbs.tv",
		hasMapping: true
	},
	{
		number: "13.1",
		name: "CW",
		tunerId: TUNER_ANTENNA,
		tvgId: "cw.tv",
		hasMapping: true
	},
	{
		number: "100",
		name: "Discovery",
		tunerId: TUNER_IPTV,
		tvgId: "discovery.us",
		hasMapping: true
	},
	{
		number: "101",
		name: "ESPN",
		tunerId: TUNER_IPTV,
		tvgId: "espn.us",
		hasMapping: true
	},
	{
		number: "102",
		name: "Cartoon Network",
		tunerId: TUNER_IPTV,
		tvgId: "cn.us",
		hasMapping: true
	},
	{
		number: "103",
		name: "BBC World News",
		tunerId: TUNER_IPTV,
		tvgId: null,
		hasMapping: false
	}
];

export function buildChannelsFixture(): ChannelListItem[] {
	return SEEDS.map((seed, index) => ({
		id: fakeUuid(index),
		number: seed.number,
		name: seed.name,
		logoUrl: null,
		tvgId: seed.tvgId,
		tunerId: seed.tunerId,
		tunerName:
			seed.tunerId === TUNER_ANTENNA ? "Antenna (HDHomeRun)" : "IPTV Provider",
		tunerKind: seed.tunerId === TUNER_ANTENNA ? "hdhomerun" : "iptv",
		enabled: true,
		sortOrder: index,
		hasMapping: seed.hasMapping
	}));
}

/**
 * Build a stable UUIDv4-shaped string from `index`. Only used by the
 * fixture so the values pass `z.string().uuid()` while remaining
 * reproducible across runs.
 */
function fakeUuid(index: number): string {
	const hex = index.toString(16).padStart(2, "0");
	return `${hex.repeat(4)}-${hex}${hex}-4${hex}${hex.charAt(0)}-8${hex}${hex.charAt(0)}-${hex.repeat(6)}`;
}
