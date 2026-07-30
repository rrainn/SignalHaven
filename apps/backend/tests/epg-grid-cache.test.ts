import assert from "node:assert/strict";
import test from "node:test";

import { EpgGridService } from "../src/epg/epg-grid.service";
import type { LogicalChannelEpgMapRepository } from "../src/repositories/logical-channel-epg-map.repository";
import type { ChannelsRepository } from "../src/repositories/channels.repository";
import type { EpgProgramsRepository } from "../src/repositories/epg-programs.repository";

/** Creates a deferred value so query ordering can be observed without timers. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

test("getGrid loads channel and mapping snapshots concurrently", async () => {
	const channelRows = deferred<never[]>();
	const mappingRows = deferred<never[]>();
	let channelCalls = 0;
	let mappingCalls = 0;
	const channels = {
		listEnabledForGrid: async () => {
			channelCalls += 1;
			return channelRows.promise;
		}
	};
	const mappings = {
		listForGrid: async () => {
			mappingCalls += 1;
			return mappingRows.promise;
		}
	};
	const programs = {
		listInWindow: async () => []
	};
	const service = new EpgGridService({
		channels: channels as unknown as ChannelsRepository,
		channelEpgMap: mappings as unknown as LogicalChannelEpgMapRepository,
		epgPrograms: programs as unknown as EpgProgramsRepository
	});

	const gridPromise = service.getGrid(
		new Date("2026-01-01T00:00:00.000Z"),
		new Date("2026-01-01T01:00:00.000Z")
	);
	await Promise.resolve();

	// Both snapshots must begin before either database request completes.
	assert.equal(channelCalls, 1);
	assert.equal(mappingCalls, 1);

	channelRows.resolve([]);
	mappingRows.resolve([]);
	await gridPromise;
});

test("getGrid reuses snapshots until they are explicitly invalidated", async () => {
	let channelCalls = 0;
	let mappingCalls = 0;
	const channels = {
		listEnabledForGrid: async () => {
			channelCalls += 1;
			return [];
		}
	};
	const mappings = {
		listForGrid: async () => {
			mappingCalls += 1;
			return [];
		}
	};
	const programs = {
		listInWindow: async () => []
	};
	const service = new EpgGridService({
		channels: channels as unknown as ChannelsRepository,
		channelEpgMap: mappings as unknown as LogicalChannelEpgMapRepository,
		epgPrograms: programs as unknown as EpgProgramsRepository
	});
	const from = new Date("2026-01-01T00:00:00.000Z");
	const to = new Date("2026-01-01T01:00:00.000Z");

	await service.getGrid(from, to);
	await service.getGrid(from, to);

	assert.equal(channelCalls, 1);
	assert.equal(mappingCalls, 1);

	service.invalidateSnapshot();
	await service.getGrid(from, to);

	assert.equal(channelCalls, 2);
	assert.equal(mappingCalls, 2);
});
