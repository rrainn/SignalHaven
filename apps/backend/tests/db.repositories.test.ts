import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer
} from "@testcontainers/postgresql";
import type { Pool } from "pg";

import {
	createDatabaseClient,
	createDatabasePool,
	type DatabaseClient
} from "../src/db/client";
import { resolveMigrationsFolder } from "../src/db/config";
import { runMigrations } from "../src/db/migrate";
import { EventBus } from "../src/events/event-bus";
import { RecordingsService } from "../src/recordings/recordings.service";
import { ChannelEpgMapRepository } from "../src/repositories/channel-epg-map.repository";
import { ChannelsRepository } from "../src/repositories/channels.repository";
import { EpgChannelsRepository } from "../src/repositories/epg-channels.repository";
import { EpgProgramsRepository } from "../src/repositories/epg-programs.repository";
import { EpgSourcesRepository } from "../src/repositories/epg-sources.repository";
import { RecordingsRepository } from "../src/repositories/recordings.repository";
import { ScheduledJobsRepository } from "../src/repositories/scheduled-jobs.repository";
import { SeriesRulesRepository } from "../src/repositories/series-rules.repository";
import { SettingsRepository } from "../src/repositories/settings.repository";
import { TunersRepository } from "../src/repositories/tuners.repository";
import { Scheduler } from "../src/scheduler/scheduler";
import { TunerAllocator } from "../src/tuners/tuner-allocator";

const migrationsFolder = resolveMigrationsFolder(process.cwd());
const downMigrationPath = path.join(
	migrationsFolder,
	"0000_initial_schema.down.sql"
);

let container: StartedPostgreSqlContainer;
let db: DatabaseClient;
let databaseUrl: string;
let pool: Pool;

before(async () => {
	container = await new PostgreSqlContainer("postgres:16-alpine")
		.withDatabase("signalhaven")
		.withUsername("signalhaven")
		.withPassword("signalhaven")
		.start();

	databaseUrl = container.getConnectionUri();
	pool = createDatabasePool({
		...process.env,
		SIGNALHAVEN_DATABASE_URL: databaseUrl
	});

	await runMigrations(pool, migrationsFolder);

	db = createDatabaseClient(pool);
});

after(async () => {
	if (pool) {
		await pool.end();
	}

	if (container) {
		await container.stop();
	}
});

beforeEach(async () => {
	await pool.query(`
    TRUNCATE TABLE
      channel_epg_map,
      recordings,
      series_rules,
      epg_programs,
      epg_channels,
      epg_sources,
      channels,
      settings,
      scheduled_jobs,
      tuners
    RESTART IDENTITY CASCADE
  `);
});

async function seedEpgSource() {
	const repository = new EpgSourcesRepository(db);
	return repository.create({
		kind: "xmltv",
		name: "Test XMLTV",
		url: "https://example.com/guide.xml"
	});
}

async function seedTunerAndChannel() {
	const tunersRepository = new TunersRepository(db);
	const channelsRepository = new ChannelsRepository(db);

	const tuner = await tunersRepository.create({
		kind: "hdhomerun",
		name: "Living Room Tuner",
		config: { host: "192.168.1.2" }
	});

	const channel = await channelsRepository.create({
		tunerId: tuner.id,
		number: "5.1",
		name: "News 5",
		enabled: true,
		sortOrder: 1
	});

	return { tuner, channel };
}

test("tuners repository CRUD round-trip", async () => {
	const repository = new TunersRepository(db);

	const created = await repository.create({
		kind: "hdhomerun",
		name: "Main Tuner",
		config: { location: "rack" }
	});

	const fetched = await repository.getById(created.id);

	assert.ok(fetched);
	assert.equal(fetched.name, "Main Tuner");
});

test("channels repository CRUD round-trip", async () => {
	const { tuner } = await seedTunerAndChannel();
	const repository = new ChannelsRepository(db);

	const created = await repository.create({
		tunerId: tuner.id,
		number: "10.1",
		providerChannelId: "sports-hd",
		name: "Sports Channel",
		enabled: true,
		sortOrder: 2
	});

	const fetched = await repository.getById(created.id);

	assert.ok(fetched);
	assert.equal(fetched.number, "10.1");
	assert.equal(fetched.providerChannelId, "sports-hd");
});

test("epg channels repository CRUD round-trip", async () => {
	const source = await seedEpgSource();
	const repository = new EpgChannelsRepository(db);

	const created = await repository.create({
		sourceId: source.id,
		externalId: "xmltv-5-1",
		displayName: "News 5 EPG"
	});

	const fetched = await repository.getById(created.id);

	assert.ok(fetched);
	assert.equal(fetched.externalId, "xmltv-5-1");
	assert.deepEqual(fetched.displayNames, ["News 5 EPG"]);
});

test("epg programs repository CRUD round-trip", async () => {
	const source = await seedEpgSource();
	const epgChannelsRepository = new EpgChannelsRepository(db);
	const programsRepository = new EpgProgramsRepository(db);

	const epgChannel = await epgChannelsRepository.create({
		sourceId: source.id,
		externalId: "xmltv-7-1",
		displayName: "Movie Guide"
	});

	const created = await programsRepository.create({
		epgChannelId: epgChannel.id,
		start: new Date("2026-01-01T01:00:00.000Z"),
		stop: new Date("2026-01-01T02:00:00.000Z"),
		title: "Night Movie",
		categories: ["Movie"]
	});

	const fetched = await programsRepository.getById(created.id);

	assert.ok(fetched);
	assert.equal(fetched.title, "Night Movie");
});

test("channel epg map repository round-trip", async () => {
	const { channel } = await seedTunerAndChannel();
	const source = await seedEpgSource();
	const epgChannelsRepository = new EpgChannelsRepository(db);
	const mapRepository = new ChannelEpgMapRepository(db);

	const epgChannel = await epgChannelsRepository.create({
		sourceId: source.id,
		externalId: "xmltv-9-1",
		displayName: "Kids Guide"
	});

	await mapRepository.upsert(channel.id, epgChannel.id);
	const fetched = await mapRepository.getByChannelId(channel.id);

	assert.ok(fetched);
	assert.equal(fetched.epgChannelId, epgChannel.id);

	// getByEpgChannelId resolves the reverse direction (used by DVR
	// record-by-program to resolve the tuner channel for a given EPG
	// channel).
	const reverse = await mapRepository.getByEpgChannelId(epgChannel.id);
	assert.ok(reverse);
	assert.equal(reverse.channelId, channel.id);

	const missing = await mapRepository.getByEpgChannelId(randomUUID());
	assert.equal(missing, null);
});

test("recordings repository CRUD round-trip", async () => {
	const { channel } = await seedTunerAndChannel();
	const source = await seedEpgSource();
	const epgChannelsRepository = new EpgChannelsRepository(db);
	const programsRepository = new EpgProgramsRepository(db);
	const recordingsRepository = new RecordingsRepository(db);
	const jobsRepository = new ScheduledJobsRepository(db);

	const epgChannel = await epgChannelsRepository.create({
		sourceId: source.id,
		externalId: "xmltv-11-1",
		displayName: "Drama Guide"
	});

	const program = await programsRepository.create({
		epgChannelId: epgChannel.id,
		start: new Date("2026-01-01T03:00:00.000Z"),
		stop: new Date("2026-01-01T04:00:00.000Z"),
		title: "Morning Drama",
		season: 1,
		episode: 2
	});

	const created = await recordingsRepository.create({
		channelId: channel.id,
		programId: program.id,
		title: "Morning Drama",
		status: "scheduled",
		scheduledStart: new Date("2026-01-01T03:00:00.000Z"),
		scheduledEnd: new Date("2026-01-01T04:00:00.000Z")
	});
	await recordingsRepository.update(created.id, {
		filePath: "/recordings/morning-drama.ts",
		fileSize: 1024
	});

	const fetched = await recordingsRepository.getById(created.id);

	assert.ok(fetched);
	assert.equal(fetched.status, "scheduled");
	assert.equal(fetched.startReason, null);

	// listScheduledWithProgram returns rows still in `scheduled` with a
	// non-null program link (used by the post-EPG-refresh reconciler in
	// rrainn/SignalHaven#R2-epg-record).
	const scheduledWithProgram =
		await recordingsRepository.listScheduledWithProgram();
	assert.ok(scheduledWithProgram.some((row) => row.id === created.id));

	// Rows without a program link are excluded.
	const unlinked = await recordingsRepository.create({
		channelId: channel.id,
		title: "Manual Recording",
		status: "scheduled",
		scheduledStart: new Date("2026-02-01T00:00:00.000Z"),
		scheduledEnd: new Date("2026-02-01T00:30:00.000Z")
	});
	const afterUnlinked = await recordingsRepository.listScheduledWithProgram();
	assert.ok(!afterUnlinked.some((row) => row.id === unlinked.id));

	const retryable = await recordingsRepository.createScheduledWithJob({
		channelId: channel.id,
		title: "Atomic Cancellation",
		scheduledStart: new Date("2026-02-02T00:00:00.000Z"),
		scheduledEnd: new Date("2026-02-02T00:30:00.000Z"),
		jobKind: "recording",
		runAt: new Date("2026-02-02T00:00:00.000Z"),
		maxAttempts: 3
	});
	const claimedJob = await jobsRepository.claim(
		retryable.recording.schedulerJobId!,
		new Date()
	);
	assert.equal(claimedJob?.status, "running");
	const cancelled = await recordingsRepository.cancelScheduled(
		retryable.recording.id
	);
	assert.equal(cancelled?.status, "cancelled");
	assert.equal(
		(await jobsRepository.getById(retryable.recording.schedulerJobId!))?.status,
		"cancelled"
	);

	// A failed capture must not suppress a later series-rule retry.
	await recordingsRepository.update(created.id, { status: "failed" });
	const failedAttempt = await recordingsRepository.findExistingForSeriesEpisode(
		{
			title: "Morning Drama",
			season: 1,
			episode: 2
		}
	);
	assert.equal(failedAttempt, null);
});

test("recordings migration indexes Guide lookups across every state", async () => {
	const result = await pool.query<{ indexdef: string }>(
		`
			SELECT indexdef
			FROM pg_indexes
			WHERE schemaname = 'public'
				AND indexname = 'recordings_program_updated_idx'
		`
	);

	assert.equal(result.rowCount, 1);
	assert.match(result.rows[0]!.indexdef, /\(program_id, updated_at DESC\)/);
});

test("recordings repository paginates and aggregates a library over 50 rows", async () => {
	const { tuner, channel } = await seedTunerAndChannel();
	const channelsRepository = new ChannelsRepository(db);
	const recordingsRepository = new RecordingsRepository(db);
	const seriesRulesRepository = new SeriesRulesRepository(db);
	const alternateChannel = await channelsRepository.create({
		tunerId: tuner.id,
		number: "7.1",
		name: "Sports 7",
		enabled: true,
		sortOrder: 2
	});
	const newsRule = await seriesRulesRepository.create({
		title: "Mountain News",
		keepCount: 100,
		newOnly: false,
		priority: 0
	});
	const sportsRule = await seriesRulesRepository.create({
		title: "Mountain Sports",
		keepCount: 100,
		newOnly: false,
		priority: 0
	});
	const base = new Date("2026-03-01T00:00:00Z");
	const created = [];

	// The mix exercises page boundaries and aggregate filters without relying
	// on browser-side filtering or an unbounded repository read.
	for (let index = 0; index < 65; index += 1) {
		const row = await recordingsRepository.create({
			channelId: index % 2 === 0 ? channel.id : alternateChannel.id,
			title: index < 55 ? `Mountain ${index}` : `Other ${index}`,
			status:
				index % 3 === 0
					? "scheduled"
					: index % 3 === 1
						? "completed"
						: "failed",
			scheduledStart: new Date(base.getTime() + index * 60_000),
			scheduledEnd: new Date(base.getTime() + (index + 1) * 60_000),
			...(index < 30
				? { seriesRuleId: newsRule.id }
				: index < 55
					? { seriesRuleId: sportsRule.id }
					: {})
		});
		await recordingsRepository.update(row.id, { fileSize: 1_000 + index });
		created.push({ ...row, fileSize: 1_000 + index });
	}

	const first = await recordingsRepository.listPage({
		limit: 50,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(first.total, 65);
	assert.equal(first.items.length, 50);
	assert.equal(first.hasMore, true);
	assert.equal(
		first.totalSize,
		created.reduce((total, row) => total + (row.fileSize ?? 0), 0)
	);

	const filteredExpected = created.filter(
		(row) =>
			row.title.toLowerCase().includes("mountain") &&
			row.status === "completed" &&
			row.channelId === channel.id
	);
	const filtered = await recordingsRepository.listPage({
		search: "mountain",
		status: "completed",
		channelId: channel.id,
		limit: 10,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(filtered.total, filteredExpected.length);
	assert.equal(
		filtered.totalSize,
		filteredExpected.reduce((total, row) => total + (row.fileSize ?? 0), 0)
	);

	const news = await recordingsRepository.listPage({
		seriesRuleId: newsRule.id,
		limit: 10,
		offset: 0,
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(news.total, 30);
	assert.equal(news.seriesGroups[0]?.recordingCount, 30);

	const cursorRow = first.items[first.items.length - 1]!;
	const inserted = await recordingsRepository.create({
		channelId: channel.id,
		title: "Inserted ahead",
		status: "completed",
		scheduledStart: new Date(base.getTime() + 100 * 60_000),
		scheduledEnd: new Date(base.getTime() + 101 * 60_000)
	});
	await recordingsRepository.delete(first.items[0]!.id);
	const second = await recordingsRepository.listPage({
		limit: 50,
		offset: first.items.length,
		cursor: { value: cursorRow.scheduledStart, id: cursorRow.id },
		sort: "scheduledStart",
		direction: "desc"
	});
	assert.equal(
		new Set([...first.items, ...second.items].map((row) => row.id)).size,
		first.items.length + second.items.length
	);
	assert.ok(second.items.every((row) => row.id !== inserted.id));
});

test("concurrent schedule-by-program requests persist one active row and job", async () => {
	const { channel } = await seedTunerAndChannel();
	const source = await seedEpgSource();
	const epgChannelsRepository = new EpgChannelsRepository(db);
	const programsRepository = new EpgProgramsRepository(db);
	const mapRepository = new ChannelEpgMapRepository(db);
	const recordingsRepository = new RecordingsRepository(db);
	const jobsRepository = new ScheduledJobsRepository(db);

	const epgChannel = await epgChannelsRepository.create({
		sourceId: source.id,
		externalId: "xmltv-idempotent",
		displayName: "Idempotent Guide"
	});
	const start = new Date(Date.now() + 60 * 60_000);
	const program = await programsRepository.create({
		epgChannelId: epgChannel.id,
		start,
		stop: new Date(start.getTime() + 30 * 60_000),
		title: "Concurrent Show"
	});
	await mapRepository.upsert(channel.id, epgChannel.id);

	const bus = new EventBus();
	const service = new RecordingsService({
		repository: recordingsRepository,
		scheduler: new Scheduler({ bus, jobsRepository }),
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: {
			resolve: async () => {
				throw new Error("resolver should not run while scheduling");
			}
		},
		config: {
			resolve: async () => ({
				recordingsDir: "/tmp/signalhaven-test-recordings",
				paddingBeforeSec: 0,
				paddingAfterSec: 0
			})
		},
		epgPrograms: programsRepository,
		channelEpgMap: mapRepository,
		bus
	});

	const results = await Promise.all([
		service.scheduleByProgram({ programId: program.id }),
		service.scheduleByProgram({ programId: program.id })
	]);

	assert.deepEqual(results.map((result) => result.created).sort(), [
		false,
		true
	]);
	assert.equal(results[0]?.recording.id, results[1]?.recording.id);
	const active = await recordingsRepository.findActiveByProgramId(program.id);
	assert.equal(active?.id, results[0]?.recording.id);

	const counts = await pool.query<{
		recordings: string;
		jobs: string;
	}>(
		`
    SELECT
      (SELECT count(*) FROM recordings
        WHERE program_id = $1 AND status IN ('scheduled', 'recording')) AS recordings,
      (SELECT count(*) FROM scheduled_jobs
        WHERE payload->>'recordingId' = $2 AND status = 'pending') AS jobs
  `,
		[program.id, results[0]!.recording.id]
	);
	assert.equal(Number(counts.rows[0]?.recordings), 1);
	assert.equal(Number(counts.rows[0]?.jobs), 1);
});

test("series rules repository CRUD round-trip", async () => {
	const { channel } = await seedTunerAndChannel();
	const source = await seedEpgSource();
	const epgChannelsRepository = new EpgChannelsRepository(db);
	const seriesRulesRepository = new SeriesRulesRepository(db);

	const epgChannel = await epgChannelsRepository.create({
		sourceId: source.id,
		externalId: "xmltv-13-1",
		displayName: "Series Guide"
	});

	const created = await seriesRulesRepository.create({
		title: "Daily News",
		channelId: channel.id,
		epgChannelId: epgChannel.id,
		keepCount: 5,
		newOnly: true,
		priority: 10
	});

	const fetched = await seriesRulesRepository.getById(created.id);

	assert.ok(fetched);
	assert.equal(fetched.keepCount, 5);
	assert.equal(fetched.priority, 10);
	assert.equal(fetched.newOnly, true);
	assert.ok(fetched.createdAt instanceof Date);
	assert.ok(fetched.updatedAt instanceof Date);

	// list / update / delete (rrainn/SignalHaven#R3-series).
	const listed = await seriesRulesRepository.list();
	assert.ok(listed.some((row) => row.id === created.id));

	const updated = await seriesRulesRepository.update(created.id, {
		keepCount: 7,
		priority: 25
	});
	assert.equal(updated?.keepCount, 7);
	assert.equal(updated?.priority, 25);

	assert.equal(await seriesRulesRepository.delete(created.id), true);
	assert.equal(await seriesRulesRepository.getById(created.id), null);
	assert.equal(await seriesRulesRepository.delete(created.id), false);
});

test("settings repository round-trip", async () => {
	const repository = new SettingsRepository(db);

	await repository.upsert("recording", { defaultQuality: "hd" });
	const fetched = await repository.getByKey("recording");

	assert.ok(fetched);
	assert.deepEqual(fetched.value, { defaultQuality: "hd" });
});

test("settings repository upsertMany applies all keys atomically", async () => {
	const repository = new SettingsRepository(db);

	await repository.upsertMany({
		storage: { path: "/srv/dvr" },
		ui: { theme: "dark" }
	});

	const all = await repository.listAll();
	assert.deepEqual(all["storage"], { path: "/srv/dvr" });
	assert.deepEqual(all["ui"], { theme: "dark" });

	// Re-applying overwrites only the touched keys.
	await repository.upsertMany({ storage: { path: "/mnt/library" } });
	const after = await repository.listAll();
	assert.deepEqual(after["storage"], { path: "/mnt/library" });
	assert.deepEqual(after["ui"], { theme: "dark" });
});

test("scheduled jobs repository persists, claims, completes and recovers", async () => {
	const repository = new ScheduledJobsRepository(db);

	const created = await repository.create({
		kind: "recording.start",
		runAt: new Date("2026-02-01T00:00:00.000Z"),
		payload: { recordingId: "rec-1" },
		maxAttempts: 3
	});

	assert.equal(created.status, "pending");
	assert.equal(created.attempts, 0);
	assert.equal(created.maxAttempts, 3);
	assert.deepEqual(created.payload, { recordingId: "rec-1" });

	const due = await repository.listDue(new Date("2026-02-02T00:00:00.000Z"));
	assert.equal(due.length, 1);
	assert.equal(due[0]?.id, created.id);

	const claimed = await repository.claim(created.id, new Date());
	assert.ok(claimed);
	assert.equal(claimed.status, "running");

	// Re-claiming the same row must fail (atomic transition).
	const reclaimed = await repository.claim(created.id, new Date());
	assert.equal(reclaimed, null);

	await repository.markCompleted(created.id);
	const completed = await repository.getById(created.id);
	assert.equal(completed?.status, "completed");

	// Recovery: a row left in `running` is moved back to `pending`.
	const stuck = await repository.create({
		kind: "cleanup",
		runAt: new Date("2026-02-01T00:00:00.000Z")
	});
	await repository.claim(stuck.id, new Date());
	const recovered = await repository.recoverStuckRunning();
	assert.equal(recovered, 1);
	const recoveredRow = await repository.getById(stuck.id);
	assert.equal(recoveredRow?.status, "pending");
	assert.equal(recoveredRow?.lockedAt, null);

	// Cancel is idempotent and accepts work that has not reached a terminal state.
	const cancelTarget = await repository.create({
		kind: "cleanup",
		runAt: new Date("2026-03-01T00:00:00.000Z")
	});
	assert.equal(await repository.cancel(cancelTarget.id), true);
	assert.equal(await repository.cancel(cancelTarget.id), false);

	const runningCancelTarget = await repository.create({
		kind: "recording",
		runAt: new Date("2026-03-01T00:00:00.000Z"),
		maxAttempts: 3
	});
	await repository.claim(runningCancelTarget.id, new Date());
	assert.equal(await repository.cancel(runningCancelTarget.id), true);
	assert.equal(
		await repository.reschedule(
			runningCancelTarget.id,
			new Date("2026-03-01T00:00:01.000Z"),
			"transient",
			1
		),
		false
	);
	await repository.markCompleted(runningCancelTarget.id);
	assert.equal(
		(await repository.getById(runningCancelTarget.id))?.status,
		"cancelled"
	);
});

test("migration up and down round-trip", async () => {
	const downSql = await fs.readFile(downMigrationPath, "utf8");
	const upSql = await fs.readFile(
		path.join(migrationsFolder, "0000_initial_schema.sql"),
		"utf8"
	);
	// Subsequent migrations must be re-applied so later tests see the
	// current schema (e.g. 0002 re-points epg_channels.source_id at
	// epg_sources(id)).
	const replaySqls = await Promise.all(
		[
			"0001_scheduled_jobs.sql",
			"0002_epg_sources.sql",
			"0003_channel_epg_mapping.sql",
			"0004_recordings_oneoff.sql",
			"0005_recordings_scheduler_job.sql",
			"0006_series_rules.sql",
			"0007_recordings_library.sql",
			"0008_search_indexes.sql",
			"0009_hdhomerun_guide_tuner.sql",
			"0010_recordings_active_program_unique.sql",
			"0011_epg_channel_display_names.sql",
			"0012_recording_recovery.sql",
			"0013_recordings_title_search.sql",
			"0014_commercial_analysis.sql",
			"0015_tuner_lineup_sync.sql",
			"0016_channel_provider_identity.sql",
			"0017_recordings_program_updated_index.sql"
		].map((file) => fs.readFile(path.join(migrationsFolder, file), "utf8"))
	);
	// Drop the later tables first so the 0000 down migration can run
	// cleanly without lingering FK references.
	await pool.query("DROP TABLE IF EXISTS scheduled_jobs CASCADE");
	await pool.query("DROP TABLE IF EXISTS epg_sources CASCADE");
	// Commercial marker tables reference recordings and must be removed before
	// exercising the original schema's standalone rollback.
	await pool.query("DROP TABLE IF EXISTS commercial_markers CASCADE");
	await pool.query("DROP TABLE IF EXISTS commercial_analyses CASCADE");
	// 0006 added a recordings.series_rule_id FK targeting series_rules;
	// dropping series_rules in 0000 down would otherwise be blocked.
	await pool.query(
		"ALTER TABLE recordings DROP COLUMN IF EXISTS series_rule_id"
	);

	await pool.query(downSql);

	const dropped = await pool.query(
		"SELECT to_regclass('public.tuners') AS tuners_table"
	);
	assert.equal(dropped.rows[0]?.tuners_table, null);

	await pool.query(upSql);

	const created = await pool.query(
		"SELECT to_regclass('public.tuners') AS tuners_table"
	);
	assert.equal(created.rows[0]?.tuners_table, "tuners");

	for (const sql of replaySqls) {
		await pool.query(sql);
	}
});

test("parallel epg_program inserts do not deadlock", async () => {
	const source = await seedEpgSource();
	const epgChannelsRepository = new EpgChannelsRepository(db);

	const epgChannel = await epgChannelsRepository.create({
		sourceId: source.id,
		externalId: "xmltv-17-1",
		displayName: "Concurrency Guide"
	});

	const insertSql = `
    INSERT INTO epg_programs (id, epg_channel_id, start, stop, title, categories)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;

	const runInsert = async (
		id: string,
		title: string,
		start: string,
		stop: string
	) => {
		const client = await pool.connect();

		try {
			await client.query("BEGIN");
			await client.query(insertSql, [
				id,
				epgChannel.id,
				start,
				stop,
				title,
				["Drama"]
			]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	};

	await Promise.all([
		runInsert(
			"11111111-1111-4111-8111-111111111111",
			"Concurrent A",
			"2026-01-02T01:00:00.000Z",
			"2026-01-02T02:00:00.000Z"
		),
		runInsert(
			"22222222-2222-4222-8222-222222222222",
			"Concurrent B",
			"2026-01-02T02:00:00.000Z",
			"2026-01-02T03:00:00.000Z"
		)
	]);

	const countResult = await pool.query(
		"SELECT count(*)::int AS count FROM epg_programs WHERE epg_channel_id = $1",
		[epgChannel.id]
	);

	assert.equal(countResult.rows[0]?.count, 2);
});
