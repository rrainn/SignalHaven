import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { TunerLineupChannel } from "@signalhaven/shared";

import type {
	ChannelRecord,
	CreateChannelInput,
	ChannelsRepository
} from "../src/repositories/channels.repository";
import type { TunerProvider } from "../src/tuners/provider";
import { TunerLineupSyncService } from "../src/tuners/tuner-lineup-sync.service";
import type { TunersService } from "../src/tuners/tuners.service";

/** Provides the mutable channel persistence needed to exercise reconciliation. */
class InMemoryChannelsRepository {
	readonly rows = new Map<string, ChannelRecord>();

	async create(input: CreateChannelInput): Promise<ChannelRecord> {
		const id = randomUUID();
		const row = {
			id,
			logicalChannelId: id,
			...input,
			providerChannelId: input.providerChannelId ?? null,
			logoUrl: input.logoUrl ?? null,
			tvgId: input.tvgId ?? null,
			sourceStatus: "active",
			sourcePriority: 0,
			lineupMissingCount: 0
		} as ChannelRecord;
		this.rows.set(row.id, row);
		return row;
	}

	async listByTunerId(tunerId: string): Promise<ChannelRecord[]> {
		return [...this.rows.values()].filter((row) => row.tunerId === tunerId);
	}

	async update(
		id: string,
		patch: {
			number?: string;
			providerChannelId?: string | null;
			name?: string;
			logoUrl?: string | null;
			tvgId?: string | null;
			sortOrder?: number;
			sourceStatus?: "active" | "missing" | "unavailable";
			lineupMissingCount?: number;
		}
	): Promise<ChannelRecord | null> {
		const current = this.rows.get(id);
		if (!current) return null;
		const updated = { ...current, ...patch } as ChannelRecord;
		this.rows.set(id, updated);
		return updated;
	}

	async deleteById(id: string): Promise<void> {
		this.rows.delete(id);
	}
}

/** Builds a provider whose fresh-lineup hook can be asserted independently. */
function providerWithLineup(lineup: TunerLineupChannel[]) {
	let refreshes = 0;
	const provider = {
		id: "tuner-1",
		kind: "hdhomerun",
		refreshLineup: () => {
			refreshes += 1;
		},
		getLineup: async () => lineup
	} as unknown as TunerProvider;
	return { provider, refreshes: () => refreshes };
}

/** Creates the service with small in-memory collaborators for behavior tests. */
function buildHarness(lineup: TunerLineupChannel[], removalThreshold = 3) {
	const channels = new InMemoryChannelsRepository();
	const current = providerWithLineup(lineup);
	const syncStates: Array<{ status: "success" | "error"; error?: string }> = [];
	const tuners = {
		getProviderById: async () => current.provider,
		list: async () => [{ id: "tuner-1", lastLineupSyncAt: null }],
		recordLineupSync: async (
			_id: string,
			state: { status: "success" | "error"; error?: string }
		) => {
			syncStates.push(state);
		}
	} as unknown as TunersService;
	const service = new TunerLineupSyncService({
		channels: channels as unknown as ChannelsRepository,
		tuners,
		resolveRemovalThreshold: async () => removalThreshold
	});
	return { channels, current, service, syncStates };
}

test("manual lineup sync forces a provider refresh before importing", async () => {
	const { current, service } = buildHarness([
		{ channelId: "one", number: "5.1", name: "Five" }
	]);

	const result = await service.syncTuner("tuner-1", { forceRefresh: true });

	assert.equal(current.refreshes(), 1);
	assert.equal(result.added, 1);
});

test("lineup sync persists and refreshes IPTV tvg-id values", async () => {
	const lineup: TunerLineupChannel[] = [
		{
			channelId: "one",
			number: "1",
			name: "News",
			tvgId: "news.example"
		}
	];
	const { channels, service } = buildHarness(lineup);

	await service.syncTuner("tuner-1");
	const [created] = [...channels.rows.values()];
	assert.equal(created?.tvgId, "news.example");

	lineup[0] = { ...lineup[0]!, tvgId: "news.updated" };
	await service.syncTuner("tuner-1");

	assert.equal(channels.rows.get(created!.id)?.tvgId, "news.updated");
});

test("lineup sync preserves channel UUIDs when provider positions change", async () => {
	const lineup: TunerLineupChannel[] = [
		{ channelId: "news", number: "1", name: "News" },
		{ channelId: "sports", number: "2", name: "Sports" }
	];
	const { channels, service } = buildHarness(lineup);

	await service.syncTuner("tuner-1");
	const favorite = [...channels.rows.values()].find(
		(channel) => channel.name === "Sports"
	);
	assert.ok(favorite);

	// Providers may insert entries without preserving synthesized position numbers.
	lineup.splice(
		0,
		lineup.length,
		{ channelId: "local", number: "1", name: "Local" },
		{ channelId: "news", number: "2", name: "News" },
		{ channelId: "sports", number: "3", name: "Sports" }
	);
	await service.syncTuner("tuner-1");

	assert.equal(channels.rows.get(favorite.id)?.name, "Sports");
	assert.equal(channels.rows.get(favorite.id)?.number, "3");
	assert.equal(
		[...channels.rows.values()].filter((channel) => channel.name === "Sports")
			.length,
		1
	);
});

test("lineup sync preserves source identity when a provider rotates its id", async () => {
	const lineup: TunerLineupChannel[] = [
		{
			channelId: "news-old",
			number: "5.1",
			name: "News",
			tvgId: "news.example"
		}
	];
	const { channels, service } = buildHarness(lineup);

	await service.syncTuner("tuner-1");
	const [existing] = [...channels.rows.values()];
	assert.ok(existing);

	// A unique guide identity is strong enough to recognize a provider-side move.
	lineup[0] = {
		channelId: "news-new",
		number: "12.4",
		name: "News",
		tvgId: "news.example"
	};
	await service.syncTuner("tuner-1");

	assert.equal(channels.rows.size, 1);
	assert.equal(channels.rows.get(existing.id)?.providerChannelId, "news-new");
	assert.equal(channels.rows.get(existing.id)?.number, "12.4");
});

test("lineup sync safely backfills provider identities for legacy channels", async () => {
	const lineup: TunerLineupChannel[] = [
		{ channelId: "local", number: "1", name: "Local" },
		{ channelId: "news", number: "2", name: "News" },
		{ channelId: "sports", number: "3", name: "Sports" }
	];
	const { channels, service } = buildHarness(lineup);
	const news = await channels.create({
		tunerId: "tuner-1",
		number: "1",
		name: "News",
		enabled: true,
		sortOrder: 0
	});
	const sports = await channels.create({
		tunerId: "tuner-1",
		number: "2",
		name: "Sports",
		enabled: true,
		sortOrder: 1
	});

	await service.syncTuner("tuner-1");

	assert.equal(channels.rows.get(news.id)?.providerChannelId, "news");
	assert.equal(channels.rows.get(news.id)?.number, "2");
	assert.equal(channels.rows.get(sports.id)?.providerChannelId, "sports");
	assert.equal(channels.rows.get(sports.id)?.number, "3");
});

test("lineup sync does not transfer a UUID to a replacement in the same slot", async () => {
	const lineup: TunerLineupChannel[] = [
		{ channelId: "news", number: "1", name: "News" }
	];
	const { channels, service } = buildHarness(lineup);

	await service.syncTuner("tuner-1");
	const favorite = [...channels.rows.values()][0]!;
	lineup[0] = { channelId: "movies", number: "1", name: "Movies" };
	await service.syncTuner("tuner-1");

	assert.equal(channels.rows.get(favorite.id)?.name, "News");
	assert.equal(channels.rows.get(favorite.id)?.lineupMissingCount, 1);
	const replacement = [...channels.rows.values()].find(
		(channel) => channel.providerChannelId === "movies"
	);
	assert.ok(replacement);
	assert.notEqual(replacement.id, favorite.id);
});

test("lineup sync re-evaluates guide mappings after metadata is stored", async () => {
	const channels = new InMemoryChannelsRepository();
	const current = providerWithLineup([
		{
			channelId: "one",
			number: "1",
			name: "News",
			tvgId: "news.example"
		}
	]);
	let mappedTvgId: string | null = null;
	const tuners = {
		getProviderById: async () => current.provider,
		recordLineupSync: async () => undefined
	} as unknown as TunersService;
	const service = new TunerLineupSyncService({
		channels: channels as unknown as ChannelsRepository,
		tuners,
		onSyncComplete: async () => {
			mappedTvgId = [...channels.rows.values()][0]?.tvgId ?? null;
		}
	});

	await service.syncTuner("tuner-1");

	assert.equal(mappedTvgId, "news.example");
});

test("missing sources retain their grouping and become unavailable at the threshold", async () => {
	const { channels, service } = buildHarness([], 3);
	const existing = await channels.create({
		tunerId: "tuner-1",
		number: "9.1",
		name: "Nine",
		enabled: true,
		sortOrder: 0
	});

	const first = await service.syncTuner("tuner-1", { forceRefresh: true });
	assert.equal(channels.rows.get(existing.id)?.sourceStatus, "missing");
	const second = await service.syncTuner("tuner-1", { forceRefresh: true });
	const third = await service.syncTuner("tuner-1", { forceRefresh: true });

	assert.equal(first.removed, 0);
	assert.equal(first.missing, 1);
	assert.equal(second.removed, 0);
	assert.equal(third.removed, 0);
	assert.equal(third.unavailable, 1);
	assert.equal(channels.rows.has(existing.id), true);
	assert.equal(channels.rows.get(existing.id)?.sourceStatus, "unavailable");
});

test("a channel returning to the lineup resets its consecutive miss count", async () => {
	const lineup: TunerLineupChannel[] = [];
	const { channels, service } = buildHarness(lineup, 3);
	const existing = await channels.create({
		tunerId: "tuner-1",
		number: "7.1",
		name: "Seven",
		enabled: true,
		sortOrder: 0
	});

	await service.syncTuner("tuner-1", { forceRefresh: true });
	lineup.push({ channelId: "seven", number: "7.1", name: "Seven" });
	await service.syncTuner("tuner-1", { forceRefresh: true });

	assert.equal(channels.rows.get(existing.id)?.lineupMissingCount, 0);
	assert.equal(channels.rows.get(existing.id)?.sourceStatus, "active");
});

test("overlapping sync requests share one reconciliation", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const { service, current } = buildHarness([]);
	current.provider.getLineup = async () => {
		calls += 1;
		await gate;
		return [];
	};

	const first = service.syncTuner("tuner-1", { forceRefresh: true });
	const second = service.syncTuner("tuner-1", { forceRefresh: true });
	await Promise.resolve();
	release?.();
	await Promise.all([first, second]);

	assert.equal(calls, 1);
});

test("failed lineup fetches record an error without mutating channels", async () => {
	const { channels, current, service, syncStates } = buildHarness([]);
	const existing = await channels.create({
		tunerId: "tuner-1",
		number: "11.1",
		name: "Eleven",
		enabled: true,
		sortOrder: 0
	});
	current.provider.getLineup = async () => {
		throw new Error("device offline at https://example.test/list?token=secret");
	};

	await assert.rejects(
		service.syncTuner("tuner-1", { forceRefresh: true }),
		/device offline/
	);

	assert.equal(channels.rows.get(existing.id)?.lineupMissingCount, 0);
	assert.equal(syncStates[syncStates.length - 1]?.status, "error");
	assert.doesNotMatch(syncStates[syncStates.length - 1]?.error ?? "", /secret/);
});

test("scheduled sync refreshes only tuners whose configured cadence is due", async () => {
	const channels = new InMemoryChannelsRepository();
	const refreshed: string[] = [];
	const providers = new Map(
		["due", "recent"].map((id) => [
			id,
			{
				id,
				kind: "hdhomerun",
				refreshLineup: () => refreshed.push(id),
				getLineup: async () => []
			} as unknown as TunerProvider
		])
	);
	const tuners = {
		list: async () => [
			{ id: "due", lastLineupSyncAt: "2026-01-01T00:00:00.000Z" },
			{ id: "recent", lastLineupSyncAt: "2026-01-02T11:00:00.000Z" }
		],
		getProviderById: async (id: string) => providers.get(id)!,
		recordLineupSync: async () => undefined
	} as unknown as TunersService;
	const service = new TunerLineupSyncService({
		channels: channels as unknown as ChannelsRepository,
		tuners,
		now: () => new Date("2026-01-02T12:00:00.000Z"),
		resolveSchedule: async () => ({ enabled: true, intervalHours: 24 })
	});

	await service.syncDueTuners();

	assert.deepEqual(refreshed, ["due"]);
});

test("scheduled sync does nothing when automatic imports are disabled", async () => {
	let listed = false;
	const tuners = {
		list: async () => {
			listed = true;
			return [];
		}
	} as unknown as TunersService;
	const service = new TunerLineupSyncService({
		channels: new InMemoryChannelsRepository() as unknown as ChannelsRepository,
		tuners,
		resolveSchedule: async () => ({ enabled: false, intervalHours: 24 })
	});

	await service.syncDueTuners();

	assert.equal(listed, false);
});
