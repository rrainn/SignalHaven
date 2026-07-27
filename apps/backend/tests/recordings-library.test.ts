import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventBus, type PublishedEvent } from "../src/events/event-bus";
import {
	RecordingProtectedError,
	RecordingsService,
	RECORDING_EVENT,
	type RecordingsConfigResolver
} from "../src/recordings/recordings.service";
import type { RecordingPlaybackService } from "../src/recordings/recording-playback.service";
import type {
	RecordingListPage,
	RecordingRecord,
	UpdateRecordingInput
} from "../src/repositories/recordings.repository";
import { Scheduler } from "../src/scheduler/scheduler";
import { TunerAllocator } from "../src/tuners/tuner-allocator";

/**
 * In-memory `RecordingsRepository` stand-in covering the surface area
 * exercised by the library-management tests (filtered listing, quota
 * eviction, library scan, mark-as-watched). Methods unrelated to the
 * tests in this file return harmless defaults rather than throwing,
 * matching the shape of the real repository.
 */
class FakeRecordingsRepo {
	readonly rows = new Map<string, RecordingRecord>();

	add(row: RecordingRecord): RecordingRecord {
		this.rows.set(row.id, row);
		return row;
	}

	async getById(id: string): Promise<RecordingRecord | null> {
		return this.rows.get(id) ?? null;
	}

	async list(): Promise<RecordingRecord[]> {
		return [...this.rows.values()];
	}

	async listPage(options: {
		search?: string;
		status?: string;
		channelId?: string;
		seriesRuleId?: string;
		from?: Date;
		to?: Date;
		limit?: number;
		offset?: number;
		cursor?: { value: Date | null; id: string };
		sort?: "scheduledStart" | "actualStart" | "createdAt";
		direction?: "asc" | "desc";
	}): Promise<RecordingListPage> {
		let rows = [...this.rows.values()];
		if (options.search) {
			const search = options.search.toLowerCase();
			rows = rows.filter((row) => row.title.toLowerCase().includes(search));
		}
		if (options.status) rows = rows.filter((r) => r.status === options.status);
		if (options.channelId)
			rows = rows.filter((r) => r.channelId === options.channelId);
		if (options.seriesRuleId)
			rows = rows.filter((r) => r.seriesRuleId === options.seriesRuleId);
		if (options.from)
			rows = rows.filter(
				(r) => r.scheduledStart.getTime() >= (options.from as Date).getTime()
			);
		if (options.to)
			rows = rows.filter(
				(r) => r.scheduledStart.getTime() < (options.to as Date).getTime()
			);
		const sortKey = options.sort ?? "scheduledStart";
		const direction = options.direction ?? "desc";
		rows.sort((a, b) => {
			const av = (a as unknown as Record<string, Date | null>)[sortKey];
			const bv = (b as unknown as Record<string, Date | null>)[sortKey];
			const at = av ? av.getTime() : 0;
			const bt = bv ? bv.getTime() : 0;
			if (at !== bt) return direction === "asc" ? at - bt : bt - at;
			return a.id.localeCompare(b.id);
		});
		const total = rows.length;
		const totalSize = rows.reduce((sum, row) => sum + (row.fileSize ?? 0), 0);
		const limit = options.limit ?? 50;
		const offset = options.offset ?? 0;
		if (options.cursor) {
			const cursor = options.cursor;
			rows = rows.filter((row) => {
				const value = (row as unknown as Record<string, Date | null>)[sortKey];
				const time = value?.getTime() ?? Number.NEGATIVE_INFINITY;
				const cursorTime = cursor.value?.getTime() ?? Number.NEGATIVE_INFINITY;
				if (time !== cursorTime) {
					return direction === "asc" ? time > cursorTime : time < cursorTime;
				}
				return row.id.localeCompare(cursor.id) > 0;
			});
		}
		const pageRows = rows.slice(
			options.cursor ? 0 : offset,
			(options.cursor ? 0 : offset) + limit
		);
		const representedSeriesIds = new Set(
			pageRows.flatMap((row) => (row.seriesRuleId ? [row.seriesRuleId] : []))
		);
		const seriesGroups = [...representedSeriesIds].map((seriesRuleId) => {
			const members = [...this.rows.values()].filter(
				(row) =>
					row.seriesRuleId === seriesRuleId &&
					(!options.search ||
						row.title.toLowerCase().includes(options.search.toLowerCase())) &&
					(!options.status || row.status === options.status) &&
					(!options.channelId || row.channelId === options.channelId)
			);
			return {
				seriesRuleId,
				title: members[0]?.title ?? "Series",
				recordingCount: members.length,
				totalSize: members.reduce(
					(sum, member) => sum + (member.fileSize ?? 0),
					0
				)
			};
		});
		const includesOneOff = pageRows.some((row) => row.seriesRuleId === null);
		const oneOffMembers = includesOneOff
			? [...this.rows.values()].filter(
					(row) =>
						row.seriesRuleId === null &&
						(!options.search ||
							row.title.toLowerCase().includes(options.search.toLowerCase())) &&
						(!options.status || row.status === options.status) &&
						(!options.channelId || row.channelId === options.channelId)
				)
			: [];
		return {
			items: pageRows,
			total,
			totalSize,
			limit,
			offset,
			hasMore: rows.length > (options.cursor ? 0 : offset) + limit,
			seriesGroups,
			oneOffGroup: includesOneOff
				? {
						recordingCount: oneOffMembers.length,
						totalSize: oneOffMembers.reduce(
							(sum, member) => sum + (member.fileSize ?? 0),
							0
						)
					}
				: null
		};
	}

	async update(
		id: string,
		patch: UpdateRecordingInput
	): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row) return null;
		Object.assign(row, patch, { updatedAt: new Date() });
		return row;
	}

	async transitionStatus(): Promise<RecordingRecord | null> {
		return null;
	}

	async recoverInProgress(): Promise<string[]> {
		return [];
	}

	async listByStatuses(statuses: string[]): Promise<RecordingRecord[]> {
		return [...this.rows.values()].filter((r) => statuses.includes(r.status));
	}

	async listScheduledWithProgram(): Promise<RecordingRecord[]> {
		return [];
	}

	async delete(id: string): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row) return null;
		this.rows.delete(id);
		return row;
	}

	async sumCompletedSize(): Promise<number> {
		let total = 0;
		for (const row of this.rows.values()) {
			if (row.status === "completed" && row.fileSize) total += row.fileSize;
		}
		return total;
	}

	async listEvictionCandidates(): Promise<RecordingRecord[]> {
		return [...this.rows.values()]
			.filter((r) => r.status === "completed" && !r.manuallyProtected)
			.sort((a, b) => {
				const av = a.actualStart ?? a.scheduledStart;
				const bv = b.actualStart ?? b.scheduledStart;
				return av.getTime() - bv.getTime();
			});
	}

	async listWithFilePath(): Promise<RecordingRecord[]> {
		return [...this.rows.values()].filter((r) => r.filePath !== null);
	}
}

class InMemoryJobsRepo {
	readonly rows = new Map<string, { id: string; status: string }>();
	async create() {
		const row = { id: randomUUID(), status: "pending" };
		this.rows.set(row.id, row);
		return row;
	}
	async getById(id: string) {
		return this.rows.get(id) ?? null;
	}
	async listDue() {
		return [];
	}
	async findNextPendingRunAt() {
		return null;
	}
	async claim() {
		return null;
	}
	async markCompleted() {
		return false;
	}
	async markFailed() {
		return false;
	}
	async reschedule() {
		return false;
	}
	async cancel(id: string) {
		const row = this.rows.get(id);
		if (!row) return false;
		row.status = "cancelled";
		return true;
	}
	async recoverStuckRunning() {
		return 0;
	}
}

function staticConfig(
	recordingsDir: string,
	quotaBytes: number | null = null
): RecordingsConfigResolver {
	return {
		resolve: async () => ({
			recordingsDir,
			paddingBeforeSec: 0,
			paddingAfterSec: 0,
			quotaBytes
		})
	};
}

function buildService(opts: {
	repo: FakeRecordingsRepo;
	tmp: string;
	bus?: EventBus;
	quotaBytes?: number | null;
	seriesRules?: { list(): Promise<unknown[]> };
	playbackService?: RecordingPlaybackService;
	epgPrograms?: {
		listByIds(ids: string[]): Promise<
			Array<{
				id: string;
				subtitle: string | null;
				description: string | null;
				episode: number | null;
				season: number | null;
				categories: string[];
				artworkUrl: string | null;
			}>
		>;
	};
}): RecordingsService {
	const bus = opts.bus ?? new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const scheduler = new Scheduler({
		bus,
		jobsRepository: jobsRepo as never
	});
	return new RecordingsService({
		repository: opts.repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => ({}) as never },
		config: staticConfig(opts.tmp, opts.quotaBytes ?? null),
		bus,
		...(opts.playbackService ? { playbackService: opts.playbackService } : {}),
		...(opts.seriesRules ? { seriesRules: opts.seriesRules as never } : {}),
		...(opts.epgPrograms ? { epgPrograms: opts.epgPrograms as never } : {})
	});
}

function makeRow(input: Partial<RecordingRecord> = {}): RecordingRecord {
	const now = new Date();
	return {
		id: randomUUID(),
		channelId: randomUUID(),
		programId: null,
		title: "Show",
		status: "completed",
		scheduledStart: now,
		scheduledEnd: new Date(now.getTime() + 60_000),
		actualStart: now,
		actualEnd: new Date(now.getTime() + 60_000),
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: null,
		errorMessage: null,
		schedulerJobId: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		createdAt: now,
		updatedAt: now,
		...input
	};
}

// ---------- listPage ----------

test("listPage(): filters by status + channel and paginates", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-list-"));
	const svc = buildService({ repo, tmp });

	const ch1 = randomUUID();
	const ch2 = randomUUID();
	const base = new Date("2026-01-01T00:00:00Z");
	for (let i = 0; i < 5; i++) {
		repo.add(
			makeRow({
				channelId: i < 3 ? ch1 : ch2,
				status: i % 2 === 0 ? "completed" : "scheduled",
				scheduledStart: new Date(base.getTime() + i * 86_400_000),
				scheduledEnd: new Date(base.getTime() + i * 86_400_000 + 60_000)
			})
		);
	}

	// status filter narrows the result set.
	const completed = await svc.listPage({
		status: "completed",
		limit: 50,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(completed.total, 3);
	assert.ok(completed.items.every((r) => r.status === "completed"));

	// channel filter applies on top.
	const ch1Page = await svc.listPage({
		channelId: ch1,
		limit: 50,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(ch1Page.total, 3);
	assert.ok(ch1Page.items.every((r) => r.channelId === ch1));

	// pagination: limit=2 + offset=2 returns the third row.
	const paged = await svc.listPage({
		channelId: ch1,
		limit: 2,
		offset: 2,
		sort: "scheduledStart",
		direction: "asc"
	});
	assert.equal(paged.total, 3);
	assert.equal(paged.items.length, 1);

	await rm(tmp, { recursive: true, force: true });
});

test("listPage(): batch-loads rich metadata for the bounded page", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-metadata-"));
	const programId = randomUUID();
	const row = repo.add(makeRow({ programId }));
	const listByIds = async (ids: string[]) => {
		assert.deepEqual(ids, [programId]);
		return [
			{
				id: programId,
				subtitle: "Pilot",
				description: "The first episode.",
				episode: 1,
				season: 1,
				categories: ["Drama"],
				artworkUrl: "https://example.com/pilot.jpg"
			}
		];
	};
	const svc = buildService({
		repo,
		tmp,
		epgPrograms: { listByIds }
	});

	const page = await svc.listPage({
		limit: 24,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});

	assert.equal(page.items[0]?.id, row.id);
	assert.deepEqual(page.items[0]?.metadata, {
		subtitle: "Pilot",
		description: "The first episode.",
		episode: 1,
		season: 1,
		categories: ["Drama"],
		artworkUrl: "https://example.com/pilot.jpg"
	});

	await rm(tmp, { recursive: true, force: true });
});

test("listPage(): searches and reports complete metadata beyond the first page", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-complete-list-"));
	const svc = buildService({ repo, tmp });
	const seriesRuleId = randomUUID();
	const channelId = randomUUID();
	const base = new Date("2026-01-01T00:00:00Z");

	// More than the default page size proves totals and aggregates come from
	// the full filtered query instead of the materialized browser page.
	for (let index = 0; index < 65; index += 1) {
		repo.add(
			makeRow({
				channelId,
				title: index % 2 === 0 ? `Mountain News ${index}` : `Other ${index}`,
				status: index % 3 === 0 ? "scheduled" : "completed",
				seriesRuleId: index % 2 === 0 ? seriesRuleId : null,
				fileSize: 1_000 + index,
				scheduledStart: new Date(base.getTime() + index * 60_000),
				scheduledEnd: new Date(base.getTime() + (index + 1) * 60_000)
			})
		);
	}

	const page = await svc.listPage({
		search: "mountain news",
		status: "completed",
		limit: 10,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});

	const expected = [...repo.rows.values()].filter(
		(row) =>
			row.status === "completed" &&
			row.title.toLowerCase().includes("mountain news")
	);
	assert.ok(expected.length > page.items.length);
	assert.equal(page.total, expected.length);
	assert.equal(
		page.totalSize,
		expected.reduce((total, row) => total + (row.fileSize ?? 0), 0)
	);
	assert.ok(page.nextCursor);
	assert.equal(page.seriesGroups[0]?.recordingCount, expected.length);

	await rm(tmp, { recursive: true, force: true });
});

test("listPage(): cursor pagination stays deterministic across mutations", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-stable-list-"));
	const svc = buildService({ repo, tmp });
	const tiedStart = new Date("2026-02-01T12:00:00Z");

	for (let index = 0; index < 6; index += 1) {
		repo.add(
			makeRow({
				title: `Tied ${index}`,
				scheduledStart: tiedStart,
				scheduledEnd: new Date(tiedStart.getTime() + 60_000)
			})
		);
	}

	const first = await svc.listPage({
		limit: 2,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.ok(first.nextCursor);

	// A newer insert and a deletion ahead of the cursor must not duplicate or
	// skip the remaining tied rows.
	repo.add(
		makeRow({
			title: "Inserted ahead",
			scheduledStart: new Date(tiedStart.getTime() + 60_000)
		})
	);
	await repo.delete(first.items[0]!.id);

	const second = await svc.listPage({
		limit: 2,
		offset: first.items.length,
		cursor: first.nextCursor!,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(
		new Set([...first.items, ...second.items].map((row) => row.id)).size,
		first.items.length + second.items.length
	);
	assert.ok(second.items.every((row) => row.title !== "Inserted ahead"));

	await rm(tmp, { recursive: true, force: true });
});

// ---------- delete ----------

test("delete(): removes file + row by default and emits deleted event", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-del-"));
	const filePath = join(tmp, "show.mkv");
	await writeFile(filePath, Buffer.from("video"));
	const row = repo.add(makeRow({ filePath, fileSize: 5 }));
	const bus = new EventBus();
	const events: PublishedEvent[] = [];
	bus.subscribe("recordings", (e) => events.push(e));
	const svc = buildService({ repo, tmp, bus });

	await svc.delete(row.id);

	assert.equal(repo.rows.size, 0);
	await assert.rejects(
		rm(filePath, { recursive: false }),
		/ENOENT/,
		"file should have been unlinked"
	);
	assert.ok(events.some((e) => e.event === RECORDING_EVENT.deleted));

	await rm(tmp, { recursive: true, force: true });
});

test("delete({keepFile:true}): removes row but preserves on-disk file", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-keep-"));
	const filePath = join(tmp, "keep.mkv");
	await writeFile(filePath, Buffer.from("video"));
	const row = repo.add(makeRow({ filePath, fileSize: 5 }));
	const svc = buildService({ repo, tmp });

	await svc.delete(row.id, { keepFile: true });

	assert.equal(repo.rows.size, 0);
	// File still exists.
	await rm(filePath); // throws if missing
	await rm(tmp, { recursive: true, force: true });
});

test("delete(): requires an explicit override for a protected recording", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-protected-del-"));
	const row = repo.add(makeRow({ manuallyProtected: true }));
	const svc = buildService({ repo, tmp });

	await assert.rejects(
		svc.delete(row.id),
		(error: unknown) =>
			error instanceof RecordingProtectedError && error.recordingId === row.id
	);
	assert.equal(repo.rows.has(row.id), true);

	await svc.delete(row.id, { overrideProtection: true });
	assert.equal(repo.rows.has(row.id), false);

	await rm(tmp, { recursive: true, force: true });
});

test("delete(): hides the row before stopping playback and unlinking", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-playback-del-"));
	const filePath = join(tmp, "playing.mkv");
	await writeFile(filePath, Buffer.from("video"));
	const row = repo.add(makeRow({ filePath, fileSize: 5 }));
	let rowWasHiddenWhenStopped = false;
	let sourceExistedWhenStopped = false;
	const playbackService = {
		stop: async (recordingId: string) => {
			assert.equal(recordingId, row.id);
			// New manifest requests must not rediscover the row during cleanup.
			rowWasHiddenWhenStopped = (await repo.getById(row.id)) === null;
			sourceExistedWhenStopped = (await stat(filePath)).isFile();
		},
		stopAll: async () => undefined,
		getActiveSessionCount: () => 0
	} as unknown as RecordingPlaybackService;
	const svc = buildService({ repo, tmp, playbackService });

	await svc.delete(row.id);

	assert.equal(rowWasHiddenWhenStopped, true);
	assert.equal(sourceExistedWhenStopped, true);
	await assert.rejects(stat(filePath), /ENOENT/);
	await rm(tmp, { recursive: true, force: true });
});

// ---------- patch (mark watched / resume position / protect) ----------

test("patch({watched:true}): sets watchedAt to now", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-watch-"));
	const row = repo.add(makeRow());
	const svc = buildService({ repo, tmp });

	const before = Date.now();
	const updated = await svc.patch(row.id, { watched: true });
	assert.ok(updated.watchedAt);
	assert.ok(
		(updated.watchedAt as Date).getTime() >= before &&
			(updated.watchedAt as Date).getTime() <= Date.now()
	);

	// watched:false clears it again.
	const cleared = await svc.patch(row.id, { watched: false });
	assert.equal(cleared.watchedAt, null);

	await rm(tmp, { recursive: true, force: true });
});

test("patch(): updates resumePositionSeconds + manuallyProtected", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-patch-"));
	const row = repo.add(makeRow());
	const svc = buildService({ repo, tmp });

	const updated = await svc.patch(row.id, {
		resumePositionSeconds: 120,
		manuallyProtected: true
	});
	assert.equal(updated.resumePositionSeconds, 120);
	assert.equal(updated.manuallyProtected, true);

	await rm(tmp, { recursive: true, force: true });
});

// ---------- enforceStorageQuota ----------

test("enforceStorageQuota(): evicts oldest non-protected recordings until under quota", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-quota-"));
	// Quota = 2 KB. We seed three 1 KB completed recordings (total 3 KB)
	// so exactly one needs to be evicted to fit.
	const f = async (name: string): Promise<string> => {
		const p = join(tmp, name);
		await writeFile(p, Buffer.alloc(1024, 0));
		return p;
	};
	const oldest = repo.add(
		makeRow({
			title: "oldest",
			filePath: await f("oldest.mkv"),
			fileSize: 1024,
			actualStart: new Date("2025-01-01"),
			scheduledStart: new Date("2025-01-01"),
			scheduledEnd: new Date("2025-01-01")
		})
	);
	const middle = repo.add(
		makeRow({
			title: "middle",
			filePath: await f("middle.mkv"),
			fileSize: 1024,
			actualStart: new Date("2025-06-01"),
			scheduledStart: new Date("2025-06-01"),
			scheduledEnd: new Date("2025-06-01")
		})
	);
	const newest = repo.add(
		makeRow({
			title: "newest",
			filePath: await f("newest.mkv"),
			fileSize: 1024,
			actualStart: new Date("2026-01-01"),
			scheduledStart: new Date("2026-01-01"),
			scheduledEnd: new Date("2026-01-01")
		})
	);

	const svc = buildService({ repo, tmp, quotaBytes: 2048 });
	const result = await svc.enforceStorageQuota();

	assert.equal(result.deleted, 1);
	assert.equal(repo.rows.has(oldest.id), false, "oldest should be evicted");
	assert.equal(repo.rows.has(middle.id), true);
	assert.equal(repo.rows.has(newest.id), true);

	await rm(tmp, { recursive: true, force: true });
});

test("enforceStorageQuota(): skips manuallyProtected rows even when oldest", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-quota-prot-"));
	const f = async (name: string): Promise<string> => {
		const p = join(tmp, name);
		await writeFile(p, Buffer.alloc(1024, 0));
		return p;
	};
	// Oldest is protected — eviction must skip it and pick the next
	// candidate by age.
	const oldestProtected = repo.add(
		makeRow({
			title: "oldest_protected",
			filePath: await f("op.mkv"),
			fileSize: 1024,
			manuallyProtected: true,
			actualStart: new Date("2025-01-01"),
			scheduledStart: new Date("2025-01-01"),
			scheduledEnd: new Date("2025-01-01")
		})
	);
	const middle = repo.add(
		makeRow({
			title: "middle",
			filePath: await f("mid.mkv"),
			fileSize: 1024,
			actualStart: new Date("2025-06-01"),
			scheduledStart: new Date("2025-06-01"),
			scheduledEnd: new Date("2025-06-01")
		})
	);
	const newest = repo.add(
		makeRow({
			title: "newest",
			filePath: await f("new.mkv"),
			fileSize: 1024,
			actualStart: new Date("2026-01-01"),
			scheduledStart: new Date("2026-01-01"),
			scheduledEnd: new Date("2026-01-01")
		})
	);

	const svc = buildService({ repo, tmp, quotaBytes: 2048 });
	const result = await svc.enforceStorageQuota();

	assert.equal(result.deleted, 1);
	assert.ok(
		repo.rows.has(oldestProtected.id),
		"protected row must not be evicted"
	);
	// The non-protected `middle` is the next-oldest and gets evicted.
	assert.equal(repo.rows.has(middle.id), false);
	assert.equal(repo.rows.has(newest.id), true);

	await rm(tmp, { recursive: true, force: true });
});

test("enforceStorageQuota(): no-op when under quota or quota disabled", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-quota-noop-"));
	repo.add(makeRow({ fileSize: 1024 }));

	const svc1 = buildService({ repo, tmp, quotaBytes: 1_000_000 });
	assert.equal((await svc1.enforceStorageQuota()).deleted, 0);

	const svc2 = buildService({ repo, tmp, quotaBytes: null });
	assert.equal((await svc2.enforceStorageQuota()).deleted, 0);

	await rm(tmp, { recursive: true, force: true });
});

// ---------- enforceRetention ----------

test("enforceRetention(): applies age limits without deleting protected or unlimited recordings", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-retention-"));
	const ruleId = randomUUID();
	const unlimitedRuleId = randomUUID();
	const seriesRules = {
		list: async () => [
			{
				id: ruleId,
				title: "X",
				retentionDays: 7,
				keepCount: 5,
				newOnly: false,
				priority: 0,
				channelId: null,
				epgChannelId: null,
				createdAt: new Date(),
				updatedAt: new Date()
			},
			{
				id: unlimitedRuleId,
				title: "Unlimited",
				retentionDays: null,
				keepCount: 5,
				newOnly: false,
				priority: 0,
				channelId: null,
				epgChannelId: null,
				createdAt: new Date(),
				updatedAt: new Date()
			}
		]
	};
	const f = async (name: string): Promise<string> => {
		const p = join(tmp, name);
		await writeFile(p, Buffer.alloc(10, 0));
		return p;
	};
	const oldEnough = repo.add(
		makeRow({
			seriesRuleId: ruleId,
			filePath: await f("old.mkv"),
			actualEnd: new Date(Date.now() - 30 * 86_400_000),
			scheduledEnd: new Date(Date.now() - 30 * 86_400_000)
		})
	);
	const fresh = repo.add(
		makeRow({
			seriesRuleId: ruleId,
			filePath: await f("fresh.mkv"),
			actualEnd: new Date(Date.now() - 1 * 86_400_000),
			scheduledEnd: new Date(Date.now() - 1 * 86_400_000)
		})
	);
	const protectedOld = repo.add(
		makeRow({
			seriesRuleId: ruleId,
			manuallyProtected: true,
			filePath: await f("protected-old.mkv"),
			actualEnd: new Date(Date.now() - 30 * 86_400_000),
			scheduledEnd: new Date(Date.now() - 30 * 86_400_000)
		})
	);
	const unlimitedOld = repo.add(
		makeRow({
			seriesRuleId: unlimitedRuleId,
			filePath: await f("unlimited-old.mkv"),
			actualEnd: new Date(Date.now() - 30 * 86_400_000),
			scheduledEnd: new Date(Date.now() - 30 * 86_400_000)
		})
	);

	const svc = buildService({ repo, tmp, seriesRules });
	const result = await svc.enforceRetention();

	assert.equal(result.deleted, 1);
	assert.equal(repo.rows.has(oldEnough.id), false);
	assert.equal(repo.rows.has(fresh.id), true);
	assert.equal(repo.rows.has(protectedOld.id), true);
	assert.equal(repo.rows.has(unlimitedOld.id), true);

	await rm(tmp, { recursive: true, force: true });
});

// ---------- scanLibrary ----------

test("scanLibrary(): detects missing files, refreshes resized rows, counts orphans", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-scan-"));
	await mkdir(tmp, { recursive: true });
	// One recording whose file exists with a different size than persisted.
	const resizedPath = join(tmp, "resized.mkv");
	await writeFile(resizedPath, Buffer.alloc(2048, 0));
	const resizedRow = repo.add(
		makeRow({ filePath: resizedPath, fileSize: 1024 })
	);

	// One recording whose file vanished out from under the row.
	const missingPath = join(tmp, "missing.mkv");
	const missingRow = repo.add(
		makeRow({ filePath: missingPath, fileSize: 999 })
	);

	// A stray file in the recordings dir not referenced by any row.
	await writeFile(join(tmp, "orphan.mkv"), Buffer.from("x"));

	const svc = buildService({ repo, tmp });
	const result = await svc.scanLibrary();

	assert.equal(result.scanned, 2);
	assert.equal(result.missingFiles, 1);
	assert.equal(result.orphanFiles, 1);
	assert.equal(result.resized, 1);

	assert.equal(repo.rows.get(resizedRow.id)?.fileSize, 2048);
	assert.equal(repo.rows.get(missingRow.id)?.fileSize, null);
	assert.equal(repo.rows.get(missingRow.id)?.errorMessage, "file_missing");

	await rm(tmp, { recursive: true, force: true });
});

// ---------- attachLibraryMaintenance ----------

test("attachLibraryMaintenance(): runs quota enforcement on recording.completed", async () => {
	const repo = new FakeRecordingsRepo();
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-lib-attach-"));
	const f = async (name: string): Promise<string> => {
		const p = join(tmp, name);
		await writeFile(p, Buffer.alloc(1024, 0));
		return p;
	};
	// Three completed rows totaling 3KB; quota = 2KB → 1 must be evicted.
	for (let i = 0; i < 3; i++) {
		repo.add(
			makeRow({
				filePath: await f(`row-${i}.mkv`),
				fileSize: 1024,
				actualStart: new Date(Date.UTC(2025, 0, 1 + i)),
				scheduledStart: new Date(Date.UTC(2025, 0, 1 + i)),
				scheduledEnd: new Date(Date.UTC(2025, 0, 1 + i))
			})
		);
	}
	const bus = new EventBus();
	const svc = buildService({ repo, tmp, bus, quotaBytes: 2048 });
	const detach = svc.attachLibraryMaintenance();

	bus.publish({
		topic: "recordings",
		event: RECORDING_EVENT.completed,
		data: {}
	});
	// Allow the queued microtask to drain.
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(repo.rows.size, 2);
	detach();
	await rm(tmp, { recursive: true, force: true });
});
