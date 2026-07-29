import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { EventBus, type PublishedEvent } from "../src/events/event-bus";
import { RECORDING_EVENT } from "../src/recordings/recordings.service";
import type {
	ChannelRecord,
	ChannelsRepository
} from "../src/repositories/channels.repository";
import type {
	EpgProgramRecord,
	EpgProgramsRepository
} from "../src/repositories/epg-programs.repository";
import type {
	RecordingRecord,
	RecordingsRepository
} from "../src/repositories/recordings.repository";
import type {
	SeriesRuleRecord,
	SeriesRulesRepository
} from "../src/repositories/series-rules.repository";
import type { ChannelEpgMapRepository } from "../src/repositories/channel-epg-map.repository";
import { SeriesRulesService } from "../src/series/series-rules.service";

// ---------- in-memory repository fakes ----------
//
// Mirrors the subset of each repository the service touches. Centralising
// the fakes keeps the individual scenarios short and focused.

class FakeRulesRepo {
	readonly rows = new Map<string, SeriesRuleRecord>();
	add(
		rule: Omit<SeriesRuleRecord, "createdAt" | "updatedAt" | "retentionDays"> &
			Partial<Pick<SeriesRuleRecord, "retentionDays">>
	): SeriesRuleRecord {
		const now = new Date();
		const row: SeriesRuleRecord = {
			retentionDays: null,
			...rule,
			createdAt: now,
			updatedAt: now
		};
		this.rows.set(row.id, row);
		return row;
	}
	async list(): Promise<SeriesRuleRecord[]> {
		return [...this.rows.values()];
	}
	async getById(id: string): Promise<SeriesRuleRecord | null> {
		return this.rows.get(id) ?? null;
	}
	async create(input: {
		title: string;
		channelId?: string | null;
		epgChannelId?: string | null;
		keepCount: number;
		newOnly: boolean;
		priority: number;
		retentionDays?: number | null;
	}): Promise<SeriesRuleRecord> {
		return this.add({
			id: randomUUID(),
			title: input.title,
			channelId: input.channelId ?? null,
			epgChannelId: input.epgChannelId ?? null,
			keepCount: input.keepCount,
			newOnly: input.newOnly,
			priority: input.priority,
			retentionDays: input.retentionDays ?? null
		});
	}
	async update(
		id: string,
		patch: Partial<
			Pick<
				SeriesRuleRecord,
				| "title"
				| "channelId"
				| "epgChannelId"
				| "keepCount"
				| "newOnly"
				| "priority"
				| "retentionDays"
			>
		>
	): Promise<SeriesRuleRecord | null> {
		const current = this.rows.get(id);
		if (!current) return null;
		const updated = { ...current, ...patch, updatedAt: new Date() };
		this.rows.set(id, updated);
		return updated;
	}
	async delete(): Promise<boolean> {
		return false;
	}
}

class FakeEpgProgramsRepo {
	readonly rows: EpgProgramRecord[] = [];
	add(
		input: Partial<EpgProgramRecord> & {
			title: string;
			epgChannelId: string;
			start: Date;
			stop: Date;
		}
	): EpgProgramRecord {
		const row: EpgProgramRecord = {
			id: input.id ?? randomUUID(),
			epgChannelId: input.epgChannelId,
			start: input.start,
			stop: input.stop,
			title: input.title,
			subtitle: input.subtitle ?? null,
			description: input.description ?? null,
			episode: input.episode ?? null,
			season: input.season ?? null,
			categories: input.categories ?? null
		} as EpgProgramRecord;
		this.rows.push(row);
		return row;
	}
	async findUpcomingByTitle(input: {
		title: string;
		epgChannelId?: string;
		after: Date;
	}): Promise<EpgProgramRecord[]> {
		return this.rows
			.filter(
				(r) =>
					r.title.toLowerCase() === input.title.toLowerCase() &&
					r.start.getTime() >= input.after.getTime() &&
					(input.epgChannelId === undefined ||
						r.epgChannelId === input.epgChannelId)
			)
			.sort((a, b) => a.start.getTime() - b.start.getTime());
	}
	async hasPriorAiring(program: EpgProgramRecord): Promise<boolean> {
		return this.rows.some(
			(r) =>
				r.id !== program.id &&
				r.title.toLowerCase() === program.title.toLowerCase() &&
				r.start.getTime() < program.start.getTime() &&
				(program.season === null ||
					program.episode === null ||
					(r.season === program.season && r.episode === program.episode))
		);
	}
	async create(): Promise<EpgProgramRecord> {
		throw new Error("not used");
	}
	async getById(id: string): Promise<EpgProgramRecord | null> {
		return this.rows.find((r) => r.id === id) ?? null;
	}
}

class FakeRecordingsRepo {
	readonly rows = new Map<string, RecordingRecord>();
	add(
		input: Omit<RecordingRecord, "watchedAt" | "resumePositionSeconds"> &
			Partial<Pick<RecordingRecord, "watchedAt" | "resumePositionSeconds">>
	): RecordingRecord {
		const row: RecordingRecord = {
			watchedAt: null,
			resumePositionSeconds: null,
			...input
		};
		this.rows.set(row.id, row);
		return row;
	}
	async findActiveByProgramId(
		programId: string
	): Promise<RecordingRecord | null> {
		for (const row of this.rows.values()) {
			if (
				row.programId === programId &&
				(row.status === "scheduled" || row.status === "recording")
			) {
				return row;
			}
		}
		return null;
	}
	async findExistingForSeriesEpisode(input: {
		seriesRuleId?: string | null;
		title: string;
		season: number | null;
		episode: number | null;
	}): Promise<RecordingRecord | null> {
		if (input.season === null || input.episode === null) return null;
		for (const row of this.rows.values()) {
			if (
				row.status !== "scheduled" &&
				row.status !== "recording" &&
				row.status !== "completed"
			) {
				continue;
			}
			const epId = row.programId;
			if (!epId) continue;
			const ep = epRowsById.get(epId);
			if (!ep) continue;
			if (ep.season !== input.season || ep.episode !== input.episode) continue;
			if (input.seriesRuleId && row.seriesRuleId === input.seriesRuleId) {
				return row;
			}
			if (row.title.toLowerCase() === input.title.toLowerCase()) {
				return row;
			}
		}
		return null;
	}
	async listCompletedBySeriesRule(
		seriesRuleId: string
	): Promise<RecordingRecord[]> {
		return [...this.rows.values()]
			.filter(
				(r) => r.seriesRuleId === seriesRuleId && r.status === "completed"
			)
			.sort(
				(a, b) =>
					(a.actualStart?.getTime() ?? a.scheduledStart.getTime()) -
					(b.actualStart?.getTime() ?? b.scheduledStart.getTime())
			);
	}
	async listScheduledStartingAfter(after: Date): Promise<RecordingRecord[]> {
		return [...this.rows.values()]
			.filter(
				(r) =>
					r.status === "scheduled" && r.scheduledEnd.getTime() > after.getTime()
			)
			.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
	}
	async delete(id: string): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row) return null;
		this.rows.delete(id);
		return row;
	}
}

class FakeChannelsRepo {
	readonly rows = new Map<string, ChannelRecord>();
	add(row: ChannelRecord): ChannelRecord {
		this.rows.set(row.id, row);
		return row;
	}
	async getById(id: string): Promise<ChannelRecord | null> {
		return this.rows.get(id) ?? null;
	}
}

class FakeChannelEpgMap {
	readonly byChannel = new Map<string, string>();
	readonly byEpgChannel = new Map<string, string>();
	link(channelId: string, epgChannelId: string): void {
		this.byChannel.set(channelId, epgChannelId);
		this.byEpgChannel.set(epgChannelId, channelId);
	}
	async getByChannelId(channelId: string) {
		const epgChannelId = this.byChannel.get(channelId);
		return epgChannelId ? { channelId, epgChannelId, manual: false } : null;
	}
	async getByEpgChannelId(epgChannelId: string) {
		const channelId = this.byEpgChannel.get(epgChannelId);
		return channelId ? { channelId, epgChannelId, manual: false } : null;
	}
}

// Cross-fake lookup table so FakeRecordingsRepo can resolve program rows
// without requiring callers to thread the EPG repo through directly.
const epRowsById = new Map<string, EpgProgramRecord>();

function captureEvents(bus: EventBus): PublishedEvent[] {
	const events: PublishedEvent[] = [];
	bus.subscribe("recordings", (event) => {
		events.push(event);
	});
	return events;
}

function makeService(opts: {
	rules: FakeRulesRepo;
	recordings: FakeRecordingsRepo;
	epgPrograms: FakeEpgProgramsRepo;
	channels: FakeChannelsRepo;
	channelEpgMap: FakeChannelEpgMap;
	schedule?: ConstructorParameters<typeof SeriesRulesService>[0]["schedule"];
	capacity?: (providerId: string) => Promise<number | null>;
	bus?: EventBus;
	now?: () => Date;
}) {
	return new SeriesRulesService({
		rules: opts.rules as unknown as SeriesRulesRepository,
		recordings: opts.recordings as unknown as RecordingsRepository,
		epgPrograms: opts.epgPrograms as unknown as EpgProgramsRepository,
		channels: opts.channels as unknown as ChannelsRepository,
		channelEpgMap: opts.channelEpgMap as unknown as ChannelEpgMapRepository,
		schedule:
			opts.schedule ??
			(async (input) => {
				const id = randomUUID();
				const row: RecordingRecord = {
					id,
					channelId: input.channelId,
					programId: input.programId,
					title: input.title,
					status: "scheduled",
					scheduledStart: input.start,
					scheduledEnd: input.end,
					actualStart: null,
					actualEnd: null,
					startReason: null,
					filePath: null,
					fileSize: null,
					durationSeconds: null,
					errorMessage: null,
					schedulerJobId: null,
					seriesRuleId: input.seriesRuleId,
					manuallyProtected: false,
					watchedAt: null,
					resumePositionSeconds: null,
					createdAt: new Date(),
					updatedAt: new Date()
				};
				opts.recordings.add(row);
				return row;
			}),
		...(opts.capacity ? { capacity: opts.capacity } : {}),
		...(opts.bus !== undefined ? { bus: opts.bus } : {}),
		...(opts.now ? { now: opts.now } : {})
	});
}

// ---------- tests ----------

test("create(): immediately evaluates the new rule", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const start = new Date(Date.now() + 60 * 60 * 1000);

	channels.add({
		id: channelId,
		tunerId: randomUUID(),
		number: "5.1",
		name: "Five",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	map.link(channelId, epgChannelId);
	epg.add({
		title: "News Hour",
		epgChannelId,
		start,
		stop: new Date(start.getTime() + 30 * 60 * 1000)
	});

	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map
	});
	const created = await service.create({
		title: "News Hour",
		channelId,
		keepCount: 5,
		newOnly: false,
		priority: 0
	});

	assert.equal(recordings.rows.size, 1);
	assert.equal([...recordings.rows.values()][0]?.seriesRuleId, created.id);
});

test("update(): immediately evaluates the changed rule", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const start = new Date(Date.now() + 60 * 60 * 1000);
	const existing = rules.add({
		id: randomUUID(),
		title: "Old Title",
		channelId,
		epgChannelId: null,
		keepCount: 5,
		newOnly: false,
		priority: 0
	});

	channels.add({
		id: channelId,
		tunerId: randomUUID(),
		number: "5.1",
		name: "Five",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	map.link(channelId, epgChannelId);
	epg.add({
		title: "New Title",
		epgChannelId,
		start,
		stop: new Date(start.getTime() + 30 * 60 * 1000)
	});

	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map
	});
	const updated = await service.update(existing.id, { title: "New Title" });

	assert.equal(updated?.title, "New Title");
	assert.equal(recordings.rows.size, 1);
	assert.equal([...recordings.rows.values()][0]?.seriesRuleId, existing.id);
});

test("evaluate(): schedules upcoming matching programs", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();

	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	channels.add({
		id: channelId,
		tunerId: randomUUID(),
		number: "5.1",
		name: "Five",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	map.link(channelId, epgChannelId);

	rules.add({
		id: randomUUID(),
		title: "News Hour",
		channelId,
		epgChannelId: null,
		keepCount: 5,
		newOnly: false,
		priority: 0
	});
	const future = new Date(Date.now() + 60 * 60 * 1000);
	epg.add({
		id: randomUUID(),
		title: "News Hour",
		epgChannelId,
		start: future,
		stop: new Date(future.getTime() + 30 * 60 * 1000),
		season: 1,
		episode: 1
	});

	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map
	});
	const result = await service.evaluate();
	assert.equal(result.scheduled, 1);
	assert.equal(recordings.rows.size, 1);
});

test("evaluate(): newOnly skips re-airings detected via prior airdate", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();

	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	channels.add({
		id: channelId,
		tunerId: randomUUID(),
		number: "5.1",
		name: "Five",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	map.link(channelId, epgChannelId);

	rules.add({
		id: randomUUID(),
		title: "Daily Show",
		channelId,
		epgChannelId: null,
		keepCount: 5,
		newOnly: true,
		priority: 0
	});

	// Original airing — in the past, so not a candidate but reachable
	// via the prior-airdate query.
	epg.add({
		id: randomUUID(),
		title: "Daily Show",
		epgChannelId,
		start: new Date(Date.now() - 24 * 60 * 60 * 1000),
		stop: new Date(Date.now() - 23.5 * 60 * 60 * 1000),
		season: 7,
		episode: 42
	});
	// Future re-airing of the same episode.
	const future = new Date(Date.now() + 60 * 60 * 1000);
	epg.add({
		id: randomUUID(),
		title: "Daily Show",
		epgChannelId,
		start: future,
		stop: new Date(future.getTime() + 30 * 60 * 1000),
		season: 7,
		episode: 42
	});
	// Future first airing of a different episode — this one should run.
	const future2 = new Date(Date.now() + 2 * 60 * 60 * 1000);
	epg.add({
		id: randomUUID(),
		title: "Daily Show",
		epgChannelId,
		start: future2,
		stop: new Date(future2.getTime() + 30 * 60 * 1000),
		season: 7,
		episode: 43
	});

	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map
	});
	const result = await service.evaluate();
	// Only the new episode (S7E43) is scheduled; the re-air is dropped.
	assert.equal(result.scheduled, 1);
	assert.equal(result.skippedNotNew, 1);
	const scheduled = [...recordings.rows.values()];
	assert.equal(scheduled[0]?.scheduledStart.getTime(), future2.getTime());
});

test("evaluate(): dedupes by (series-id, season, episode)", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();

	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	channels.add({
		id: channelId,
		tunerId: randomUUID(),
		number: "5.1",
		name: "Five",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	map.link(channelId, epgChannelId);

	const rule = rules.add({
		id: randomUUID(),
		title: "Quiz Night",
		channelId,
		epgChannelId: null,
		keepCount: 5,
		newOnly: false,
		priority: 0
	});
	const future1 = new Date(Date.now() + 60 * 60 * 1000);
	const futureEp = epg.add({
		id: randomUUID(),
		title: "Quiz Night",
		epgChannelId,
		start: future1,
		stop: new Date(future1.getTime() + 30 * 60 * 1000),
		season: 2,
		episode: 5
	});
	// A second airing of the same S2E5 (e.g. timeshifted feed). Should
	// be deduped against the recording scheduled for `futureEp`.
	const future2 = new Date(Date.now() + 3 * 60 * 60 * 1000);
	epg.add({
		id: randomUUID(),
		title: "Quiz Night",
		epgChannelId,
		start: future2,
		stop: new Date(future2.getTime() + 30 * 60 * 1000),
		season: 2,
		episode: 5
	});

	// Pre-seed an existing recording for the first airing, simulating
	// a previous evaluation pass.
	epRowsById.set(futureEp.id, futureEp);
	recordings.add({
		id: randomUUID(),
		channelId,
		programId: futureEp.id,
		title: "Quiz Night",
		status: "scheduled",
		scheduledStart: future1,
		scheduledEnd: new Date(future1.getTime() + 30 * 60 * 1000),
		actualStart: null,
		actualEnd: null,
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: null,
		errorMessage: null,
		schedulerJobId: null,
		seriesRuleId: rule.id,
		manuallyProtected: false,
		createdAt: new Date(),
		updatedAt: new Date()
	});

	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map
	});
	const result = await service.evaluate();
	// The first airing already has a recording (active program-id
	// match); the second is deduped via (series, season, episode).
	assert.equal(result.scheduled, 0);
	assert.ok(
		result.skippedDuplicate >= 1,
		`expected at least 1 dedupe skip, got ${result.skippedDuplicate}`
	);
	// Cleanup the cross-test global to keep tests independent.
	epRowsById.delete(futureEp.id);
});

test("evaluate(): conflict resolver drops lowest-priority candidate when capacity is full", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();

	const tunerId = randomUUID();
	const channelHigh = randomUUID();
	const channelLow = randomUUID();
	const epgHigh = randomUUID();
	const epgLow = randomUUID();
	channels.add({
		id: channelHigh,
		tunerId,
		number: "5.1",
		name: "Five",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	channels.add({
		id: channelLow,
		tunerId,
		number: "9.1",
		name: "Nine",
		logoUrl: null,
		tvgId: null,
		enabled: true,
		sortOrder: 0
	} as ChannelRecord);
	map.link(channelHigh, epgHigh);
	map.link(channelLow, epgLow);

	const ruleHigh = rules.add({
		id: randomUUID(),
		title: "Big Show",
		channelId: channelHigh,
		epgChannelId: null,
		keepCount: 5,
		newOnly: false,
		priority: 50
	});
	const ruleLow = rules.add({
		id: randomUUID(),
		title: "Small Show",
		channelId: channelLow,
		epgChannelId: null,
		keepCount: 5,
		newOnly: false,
		priority: 5
	});

	const start = new Date(Date.now() + 60 * 60 * 1000);
	const end = new Date(start.getTime() + 30 * 60 * 1000);
	epg.add({
		id: randomUUID(),
		title: "Big Show",
		epgChannelId: epgHigh,
		start,
		stop: end,
		season: 1,
		episode: 1
	});
	epg.add({
		id: randomUUID(),
		title: "Small Show",
		epgChannelId: epgLow,
		start,
		stop: end,
		season: 1,
		episode: 1
	});

	const bus = new EventBus();
	const events = captureEvents(bus);
	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map,
		capacity: async () => 1,
		bus
	});
	const result = await service.evaluate();
	assert.equal(result.scheduled, 1);
	assert.equal(result.conflicts.length, 1);
	// The lower-priority show was dropped.
	const dropped = result.conflicts[0];
	assert.equal(dropped?.seriesRuleId, ruleLow.id);
	assert.equal(dropped?.reason, "tuner_capacity");
	// The kept recording belongs to the higher-priority rule.
	const scheduled = [...recordings.rows.values()];
	assert.equal(scheduled[0]?.seriesRuleId, ruleHigh.id);
	// The conflict was published to the WS bus and is queryable.
	assert.ok(events.some((e) => e.event === "recording.conflict"));
	assert.equal(service.getConflicts().length, 1);
});

test("enforceKeepCount(): applies alongside age retention and respects manuallyProtected", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();

	const rule = rules.add({
		id: randomUUID(),
		title: "Archive Show",
		channelId: null,
		epgChannelId: null,
		keepCount: 2,
		newOnly: false,
		priority: 0,
		retentionDays: 7
	});

	const channelId = randomUUID();
	const seriesRuleId = rule.id;
	const baseTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
	const ids: string[] = [];
	for (let i = 0; i < 5; i++) {
		const id = randomUUID();
		ids.push(id);
		recordings.add({
			id,
			channelId,
			programId: null,
			title: "Archive Show",
			status: "completed",
			scheduledStart: new Date(baseTime + i * 24 * 60 * 60 * 1000),
			scheduledEnd: new Date(baseTime + i * 24 * 60 * 60 * 1000 + 60_000),
			actualStart: new Date(baseTime + i * 24 * 60 * 60 * 1000),
			actualEnd: new Date(baseTime + i * 24 * 60 * 60 * 1000 + 60_000),
			startReason: null,
			filePath: null,
			fileSize: null,
			durationSeconds: null,
			errorMessage: null,
			schedulerJobId: null,
			seriesRuleId,
			// Mark the *oldest* recording as manually protected; it should
			// survive eviction even though it would otherwise be the first
			// victim.
			manuallyProtected: i === 0,
			createdAt: new Date(),
			updatedAt: new Date()
		});
	}

	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map
	});
	const { deleted } = await service.enforceKeepCount(rule.id);
	// 5 total, keepCount=2, but the oldest is protected → 4 evictable,
	// delete 2, keep latest 2.
	assert.equal(deleted, 2);
	assert.equal(recordings.rows.size, 3);
	// The protected row survives.
	assert.ok(recordings.rows.has(ids[0]!));
	// The two oldest non-protected (indices 1 and 2) were deleted.
	assert.ok(!recordings.rows.has(ids[1]!));
	assert.ok(!recordings.rows.has(ids[2]!));
	// The two newest survive.
	assert.ok(recordings.rows.has(ids[3]!));
	assert.ok(recordings.rows.has(ids[4]!));
});

test("attachBus(): recording.completed event triggers keepCount enforcement", async () => {
	const rules = new FakeRulesRepo();
	const recordings = new FakeRecordingsRepo();
	const epg = new FakeEpgProgramsRepo();
	const channels = new FakeChannelsRepo();
	const map = new FakeChannelEpgMap();

	const rule = rules.add({
		id: randomUUID(),
		title: "Daily",
		channelId: null,
		epgChannelId: null,
		keepCount: 1,
		newOnly: false,
		priority: 0
	});

	for (let i = 0; i < 3; i++) {
		recordings.add({
			id: randomUUID(),
			channelId: randomUUID(),
			programId: null,
			title: "Daily",
			status: "completed",
			scheduledStart: new Date(Date.now() - (3 - i) * 60_000),
			scheduledEnd: new Date(Date.now() - (3 - i) * 60_000 + 1000),
			actualStart: new Date(Date.now() - (3 - i) * 60_000),
			actualEnd: new Date(Date.now() - (3 - i) * 60_000 + 1000),
			startReason: null,
			filePath: null,
			fileSize: null,
			durationSeconds: null,
			errorMessage: null,
			schedulerJobId: null,
			seriesRuleId: rule.id,
			manuallyProtected: false,
			createdAt: new Date(),
			updatedAt: new Date()
		});
	}

	const bus = new EventBus();
	const service = makeService({
		rules,
		recordings,
		epgPrograms: epg,
		channels,
		channelEpgMap: map,
		bus
	});
	service.attachBus();

	bus.publish({
		topic: "recordings",
		event: RECORDING_EVENT.completed,
		data: {
			id: randomUUID(),
			channelId: randomUUID(),
			programId: null,
			title: "Daily",
			status: "completed",
			scheduledStart: new Date().toISOString(),
			scheduledEnd: new Date().toISOString(),
			actualStart: null,
			actualEnd: null,
			filePath: null,
			fileSize: null,
			durationSeconds: null,
			errorMessage: null,
			seriesRuleId: rule.id,
			manuallyProtected: false
		}
	});

	// Allow the microtask queue to drain so the async enforcement runs.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(recordings.rows.size, 1);
});
