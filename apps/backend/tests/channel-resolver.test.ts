import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { ChannelsRepository } from "../src/repositories/channels.repository";
import { DefaultChannelStreamResolver } from "../src/streaming/channel-resolver";
import type { TunersService } from "../src/tuners/tuners.service";

test("provider outages remain retryable when a channel has eligible sources", async () => {
	const channelId = randomUUID();
	const tunerId = randomUUID();
	const now = new Date();
	const source = {
		id: channelId,
		logicalChannelId: channelId,
		tunerId,
		number: "7",
		providerChannelId: "news.us",
		name: "News",
		logoUrl: null,
		tvgId: "news.us",
		enabled: true,
		sortOrder: 0,
		sourceStatus: "active",
		sourcePriority: 0,
		lineupMissingCount: 0
	};
	const logicalChannel = {
		id: channelId,
		number: "7",
		name: "News",
		logoUrl: null,
		enabled: true,
		sortOrder: 0,
		createdAt: now,
		updatedAt: now
	};
	const channels = {
		getById: async () => source,
		getLogicalChannelById: async () => logicalChannel,
		listSourcesByLogicalChannelId: async () => [source]
	} as unknown as ChannelsRepository;
	const tuners = {
		getProviderById: async () => ({
			getLineup: async () => {
				throw new Error("temporary playlist outage");
			},
			getStreamUrl: async () => {
				throw new Error("temporary playlist outage");
			}
		})
	} as unknown as TunersService;
	const resolver = new DefaultChannelStreamResolver(channels, tuners);

	await assert.rejects(
		() => resolver.resolveCandidates(channelId),
		/temporary playlist outage/
	);
});

test("resolved stream sources retain provider HTTP headers", async () => {
	const channelId = randomUUID();
	const tunerId = randomUUID();
	const now = new Date();
	const source = {
		id: channelId,
		logicalChannelId: channelId,
		tunerId,
		number: "512",
		providerChannelId: "freeform",
		name: "Freeform",
		logoUrl: null,
		tvgId: "freeform",
		enabled: true,
		sortOrder: 0,
		sourceStatus: "active",
		sourcePriority: 0,
		lineupMissingCount: 0
	};
	const logicalChannel = {
		id: channelId,
		number: "512",
		name: "Freeform",
		logoUrl: null,
		enabled: true,
		sortOrder: 0,
		createdAt: now,
		updatedAt: now
	};
	const channels = {
		getById: async () => source,
		getLogicalChannelById: async () => logicalChannel,
		listSourcesByLogicalChannelId: async () => [source]
	} as unknown as ChannelsRepository;
	const tuners = {
		getProviderById: async () => ({
			getLineup: async () => [
				{ channelId: "freeform", number: "512", name: "Freeform" }
			],
			getStreamUrl: async () => ({
				url: "https://stream.example/freeform.m3u8",
				httpHeaders: {
					userAgent: "SignalHaven Test Client",
					referer: "https://guide.example/watch"
				}
			})
		})
	} as unknown as TunersService;
	const resolver = new DefaultChannelStreamResolver(channels, tuners);

	const resolved = await resolver.resolve(channelId);

	assert.deepEqual(resolved.httpHeaders, {
		userAgent: "SignalHaven Test Client",
		referer: "https://guide.example/watch"
	});
});
