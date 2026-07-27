import assert from "node:assert/strict";
import test from "node:test";

import {
	channelNumberPrefix,
	normalizeName,
	rankEpgCandidates,
	type MatchableChannel,
	type MatchableEpgChannel
} from "../src/epg/channel-matching";

test("normalizeName lowercases, strips diacritics, drops non-alphanum", () => {
	assert.equal(normalizeName("ESPN HD"), "espnhd");
	assert.equal(normalizeName("ESPN-HD"), "espnhd");
	assert.equal(normalizeName(" Channel  5+1 "), "channel51");
	assert.equal(normalizeName("Café TV"), "cafetv");
	assert.equal(normalizeName("Ñew Network"), "newnetwork");
	assert.equal(normalizeName(null), "");
	assert.equal(normalizeName(""), "");
	assert.equal(normalizeName("!!!"), "");
});

test("channelNumberPrefix returns leading digit run only", () => {
	assert.equal(channelNumberPrefix("5.1"), "5");
	assert.equal(channelNumberPrefix("23-2"), "23");
	assert.equal(channelNumberPrefix("11"), "11");
	assert.equal(channelNumberPrefix("HD-5"), "");
	assert.equal(channelNumberPrefix(null), "");
	assert.equal(channelNumberPrefix(""), "");
});

const epg = (
	id: string,
	externalId: string,
	displayName: string,
	displayNames: string[] = [displayName]
): MatchableEpgChannel => ({
	id,
	sourceId: "src-1",
	externalId,
	displayName,
	displayNames
});

test("rankEpgCandidates: tvg-id beats every other strategy", () => {
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "5.1",
		name: "News 5",
		tvgId: "news5.example.com"
	};
	const candidates = [
		epg("e-a", "news5.example.com", "Some Other Name"),
		epg("e-b", "weather.example.com", "News 5") // exact name match
	];
	const ranked = rankEpgCandidates(channel, candidates);
	assert.equal(ranked.length, 2);
	assert.equal(ranked[0]?.epgChannel.id, "e-a");
	assert.equal(ranked[0]?.strategy, "tvg-id");
	assert.equal(ranked[1]?.epgChannel.id, "e-b");
	assert.equal(ranked[1]?.strategy, "display-name");
	assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("rankEpgCandidates: exact display-name beats normalized name", () => {
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "8.1",
		name: "ESPN HD",
		tvgId: null
	};
	const candidates = [
		epg("e-a", "ext-1", "espn-hd"), // normalized match
		epg("e-b", "ext-2", "ESPN HD") // exact match
	];
	const ranked = rankEpgCandidates(channel, candidates);
	assert.equal(ranked[0]?.epgChannel.id, "e-b");
	assert.equal(ranked[0]?.strategy, "display-name");
	assert.equal(ranked[1]?.epgChannel.id, "e-a");
	assert.equal(ranked[1]?.strategy, "normalized-name");
});

test("rankEpgCandidates: exact channel number matches an alternate display name", () => {
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "4.1",
		name: "KCNC-TV",
		tvgId: null
	};
	const candidates = [
		epg("e-a", "US19330.hdhomerun.com", "KCNCDT", ["KCNCDT", "4.1"])
	];

	const ranked = rankEpgCandidates(channel, candidates);

	assert.equal(ranked.length, 1);
	assert.equal(ranked[0]?.epgChannel.id, "e-a");
	assert.equal(ranked[0]?.strategy, "channel-number");
});

test("rankEpgCandidates: normalized name handles realistic name variants", () => {
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "12.1",
		name: "BBC One HD",
		tvgId: null
	};
	const candidates = [
		epg("e-a", "ext-1", "BBC ONE HD"),
		epg("e-b", "ext-2", "bbc-one-hd"),
		epg("e-c", "ext-3", "BBC Two")
	];
	const ranked = rankEpgCandidates(channel, candidates);
	// Both e-a and e-b normalize to the same value as the channel.
	assert.equal(ranked.length, 2);
	for (const entry of ranked) {
		assert.equal(entry.strategy, "normalized-name");
	}
	assert.deepEqual(ranked.map((c) => c.epgChannel.id).sort(), ["e-a", "e-b"]);
});

test("rankEpgCandidates: matches names with trailing stream metadata", () => {
	const channel: MatchableChannel = {
		id: "ch-news",
		number: "120",
		name: "Example News (1080p) [Geo-blocked]",
		tvgId: "provider.example-news@HD"
	};
	const ranked = rankEpgCandidates(channel, [
		epg("e-news", "guide-uuid-1", "Example News"),
		epg("e-news-world", "guide-uuid-2", "Example News World")
	]);

	assert.equal(ranked.length, 1);
	assert.equal(ranked[0]?.epgChannel.id, "e-news");
	assert.equal(ranked[0]?.strategy, "stream-metadata-name");
});

test("rankEpgCandidates: does not auto-match ambiguous decorated names", () => {
	const channel: MatchableChannel = {
		id: "ch-regional",
		number: "220",
		name: "Regional Network (720p)",
		tvgId: "provider.regional-network"
	};
	const ranked = rankEpgCandidates(channel, [
		epg("e-regional-east", "guide-uuid-east", "Regional Network"),
		epg("e-regional-west", "guide-uuid-west", "Regional Network")
	]);

	assert.deepEqual(ranked, []);
});

test("rankEpgCandidates: channel-number prefix is the weakest fallback", () => {
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "5.1",
		name: "Local 5",
		tvgId: null
	};
	const candidates = [
		epg("e-a", "ext-1", "5 News"), // matches "5" prefix
		epg("e-b", "ext-2", "5-HD"), // matches "5" prefix
		epg("e-c", "ext-3", "55 News"), // does NOT match (5 followed by digit)
		epg("e-d", "ext-4", "Movie Channel") // no match
	];
	const ranked = rankEpgCandidates(channel, candidates);
	assert.equal(ranked.length, 2);
	for (const entry of ranked) {
		assert.equal(entry.strategy, "channel-number-prefix");
	}
	// Deterministic order: by display name asc among equal scores.
	assert.equal(ranked[0]?.epgChannel.id, "e-a");
	assert.equal(ranked[1]?.epgChannel.id, "e-b");
});

test("rankEpgCandidates: returns empty when nothing matches", () => {
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "abc",
		name: "Mystery",
		tvgId: null
	};
	const ranked = rankEpgCandidates(channel, [
		epg("e-a", "ext-1", "Discovery"),
		epg("e-b", "ext-2", "History")
	]);
	assert.deepEqual(ranked, []);
});

test("rankEpgCandidates: each EPG channel appears at most once", () => {
	// The same EPG row matches by both name AND number prefix; we only
	// emit the strongest strategy, with no duplicates.
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "5.1",
		name: "5 News",
		tvgId: null
	};
	const candidates = [epg("e-a", "ext-1", "5 News")];
	const ranked = rankEpgCandidates(channel, candidates);
	assert.equal(ranked.length, 1);
	assert.equal(ranked[0]?.strategy, "display-name");
});

test("rankEpgCandidates: ignores empty channel name when computing matches", () => {
	// Empty/whitespace-only normalized forms must never collide.
	const channel: MatchableChannel = {
		id: "ch-1",
		number: "",
		name: "!!!",
		tvgId: null
	};
	const candidates = [epg("e-a", "ext-1", "***")];
	const ranked = rankEpgCandidates(channel, candidates);
	assert.deepEqual(ranked, []);
});
