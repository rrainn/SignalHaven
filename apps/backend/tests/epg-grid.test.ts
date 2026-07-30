/**
 * Integration tests for `EpgGridService` and the
 * `GET /api/v1/epg/grid` HTTP route.
 *
 * Each test runs against a real PostgreSQL instance spun up via
 * Testcontainers so the queries are exercised end-to-end.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer
} from "@testcontainers/postgresql";
import type { Pool } from "pg";
import request from "supertest";

import {
	createDatabaseClient,
	createDatabasePool,
	type DatabaseClient
} from "../src/db/client";
import { resolveMigrationsFolder } from "../src/db/config";
import { runMigrations } from "../src/db/migrate";
import { EpgGridService } from "../src/epg/epg-grid.service";
import { ChannelEpgMapRepository } from "../src/repositories/channel-epg-map.repository";
import { LogicalChannelEpgMapRepository } from "../src/repositories/logical-channel-epg-map.repository";
import { ChannelsRepository } from "../src/repositories/channels.repository";
import { EpgChannelsRepository } from "../src/repositories/epg-channels.repository";
import { EpgProgramsRepository } from "../src/repositories/epg-programs.repository";
import { EpgSourcesRepository } from "../src/repositories/epg-sources.repository";
import { RecordingsRepository } from "../src/repositories/recordings.repository";
import { TunersRepository } from "../src/repositories/tuners.repository";
import { createApp } from "../src/app";

const migrationsFolder = resolveMigrationsFolder(process.cwd());

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: DatabaseClient;

before(async () => {
	container = await new PostgreSqlContainer("postgres:16-alpine")
		.withDatabase("signalhaven")
		.withUsername("signalhaven")
		.withPassword("signalhaven")
		.start();
	pool = createDatabasePool({
		...process.env,
		SIGNALHAVEN_DATABASE_URL: container.getConnectionUri()
	});
	await runMigrations(pool, migrationsFolder);
	db = createDatabaseClient(pool);
});

after(async () => {
	if (pool) await pool.end();
	if (container) await container.stop();
});

beforeEach(async () => {
	await pool.query(`
    TRUNCATE TABLE
	  logical_channel_epg_map, channel_epg_map, recordings, series_rules,
      epg_programs, epg_channels, epg_sources,
	  channels, logical_channels, settings, scheduled_jobs, tuners
    RESTART IDENTITY CASCADE
  `);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTuner() {
	const repo = new TunersRepository(db);
	return repo.create({ kind: "hdhomerun", name: "Test Tuner", config: {} });
}

async function seedChannel(
	tunerId: string,
	opts: Partial<{ number: string; name: string; sortOrder: number }> = {}
) {
	const repo = new ChannelsRepository(db);
	return repo.create({
		tunerId,
		number: opts.number ?? "1.1",
		name: opts.name ?? "Channel 1",
		enabled: true,
		sortOrder: opts.sortOrder ?? 1
	});
}

async function seedEpgSource() {
	const repo = new EpgSourcesRepository(db);
	return repo.create({
		kind: "xmltv",
		name: "Test XMLTV",
		url: "https://example.com/guide.xml"
	});
}

async function seedEpgChannel(sourceId: string, displayName = "EPG Ch 1") {
	const repo = new EpgChannelsRepository(db);
	return repo.create({
		sourceId,
		externalId: randomUUID(),
		displayName
	});
}

async function seedProgram(
	epgChannelId: string,
	start: Date,
	stop: Date,
	title = "Test Show"
) {
	const repo = new EpgProgramsRepository(db);
	return repo.create({
		epgChannelId,
		start,
		stop,
		title,
		categories: ["Drama"]
	});
}

function buildService() {
	return new EpgGridService({
		channels: new ChannelsRepository(db),
		channelEpgMap: new LogicalChannelEpgMapRepository(db),
		epgPrograms: new EpgProgramsRepository(db),
		recordings: new RecordingsRepository(db)
	});
}

function buildApp() {
	return createApp({ epgGridService: buildService() });
}

// ---------------------------------------------------------------------------
// EpgGridService unit-style integration tests
// ---------------------------------------------------------------------------

test("getGrid returns all enabled channels even when unmapped", async () => {
	const tuner = await seedTuner();
	await seedChannel(tuner.id, { name: "Ch A", sortOrder: 1 });
	await seedChannel(tuner.id, { name: "Ch B", sortOrder: 2 });

	const service = buildService();
	const from = new Date("2026-01-01T00:00:00Z");
	const to = new Date("2026-01-02T00:00:00Z");
	const grid = await service.getGrid(from, to);

	assert.equal(grid.channels.length, 2);
	assert.deepEqual(
		grid.channels.map((c) => c.name),
		["Ch A", "Ch B"]
	);
	assert.ok(grid.channels.every((c) => c.hasMapping === false));
	assert.equal(grid.programs.length, 0);
});

test("getGrid returns programs intersecting the window with tuner channelId", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const source = await seedEpgSource();
	const epgCh = await seedEpgChannel(source.id);

	// Wire channel → EPG channel.
	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(channel.id, epgCh.id);

	const from = new Date("2026-01-01T10:00:00Z");
	const to = new Date("2026-01-01T14:00:00Z");

	// Program fully inside the window.
	const p1 = await seedProgram(
		epgCh.id,
		new Date("2026-01-01T11:00:00Z"),
		new Date("2026-01-01T12:00:00Z"),
		"Inside Show"
	);
	// Program that straddles the start boundary (starts before `from`, stops after).
	const p2 = await seedProgram(
		epgCh.id,
		new Date("2026-01-01T09:30:00Z"),
		new Date("2026-01-01T10:30:00Z"),
		"Straddle Start"
	);
	// Program outside the window — should be excluded.
	await seedProgram(
		epgCh.id,
		new Date("2026-01-01T15:00:00Z"),
		new Date("2026-01-01T16:00:00Z"),
		"Outside Show"
	);

	const service = buildService();
	const grid = await service.getGrid(from, to);

	assert.equal(grid.programs.length, 2);
	const titles = grid.programs.map((p) => p.title).sort();
	assert.deepEqual(titles, ["Inside Show", "Straddle Start"].sort());

	// channelId on each program must be the tuner channel id, not the EPG id.
	for (const prog of grid.programs) {
		assert.equal(prog.channelId, channel.id);
	}

	// The channel must be flagged as mapped.
	const ch = grid.channels.find((c) => c.id === channel.id);
	assert.ok(ch);
	assert.equal(ch.hasMapping, true);

	// Verify that programs outside the window are not returned.
	assert.ok(!grid.programs.find((p) => p.title === "Outside Show"));

	void p1;
	void p2;
});

test("getGrid returns shared EPG programs for every mapped tuner channel", async () => {
	const tuner = await seedTuner();
	const hdChannel = await seedChannel(tuner.id, {
		number: "101",
		name: "News HD",
		sortOrder: 1
	});
	const backupChannel = await seedChannel(tuner.id, {
		number: "102",
		name: "News backup",
		sortOrder: 2
	});
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id, "News");
	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(hdChannel.id, epgChannel.id);
	await mapRepo.upsert(backupChannel.id, epgChannel.id);
	const program = await seedProgram(
		epgChannel.id,
		new Date("2026-01-01T11:00:00Z"),
		new Date("2026-01-01T12:00:00Z"),
		"Shared News"
	);

	const grid = await buildService().getGrid(
		new Date("2026-01-01T10:00:00Z"),
		new Date("2026-01-01T13:00:00Z")
	);

	assert.deepEqual(
		grid.programs.map((entry) => [entry.id, entry.channelId]).sort(),
		[
			[program.id, hdChannel.id],
			[program.id, backupChannel.id]
		].sort()
	);
});

test("getGrid annotates programs with recording status", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const source = await seedEpgSource();
	const epgCh = await seedEpgChannel(source.id);
	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(channel.id, epgCh.id);

	const start = new Date("2026-01-01T20:00:00Z");
	const stop = new Date("2026-01-01T21:00:00Z");
	const program = await seedProgram(epgCh.id, start, stop, "Documentary");

	// Create a scheduled recording for this program.
	const recRepo = new RecordingsRepository(db);
	const recording = await recRepo.create({
		channelId: channel.id,
		programId: program.id,
		title: "Documentary",
		status: "scheduled",
		scheduledStart: start,
		scheduledEnd: stop
	});

	const service = buildService();
	const grid = await service.getGrid(
		new Date("2026-01-01T19:00:00Z"),
		new Date("2026-01-01T22:00:00Z")
	);

	assert.equal(grid.programs.length, 1);
	assert.equal(grid.programs[0]!.recordingStatus, "scheduled");
	assert.equal(grid.programs[0]!.recordingId, recording.id);
});

// ---------------------------------------------------------------------------
// HTTP integration test
// ---------------------------------------------------------------------------

test("GET /api/v1/epg/grid returns 200 with valid window", async () => {
	const tuner = await seedTuner();
	await seedChannel(tuner.id);

	const app = buildApp();

	const res = await request(app).get("/api/v1/epg/grid").query({
		from: "2026-01-01T00:00:00.000Z",
		to: "2026-01-02T00:00:00.000Z"
	});

	assert.equal(res.status, 200);
	assert.ok(Array.isArray(res.body.channels));
	assert.ok(Array.isArray(res.body.programs));
	assert.equal(typeof res.body.from, "string");
	assert.equal(typeof res.body.to, "string");
});

test("GET /api/v1/epg/grid omits detail-only program metadata", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id);
	await new ChannelEpgMapRepository(db).upsert(channel.id, epgChannel.id);
	await new EpgProgramsRepository(db).create({
		epgChannelId: epgChannel.id,
		start: new Date("2026-01-01T12:00:00.000Z"),
		stop: new Date("2026-01-01T13:00:00.000Z"),
		title: "Compact cell",
		description: "Only available from the details route",
		categories: ["Drama"]
	});

	const response = await request(buildApp()).get("/api/v1/epg/grid").query({
		from: "2026-01-01T11:00:00.000Z",
		to: "2026-01-01T14:00:00.000Z"
	});

	assert.equal(response.status, 200);
	assert.equal(response.body.programs.length, 1);
	assert.equal("description" in response.body.programs[0], false);
	assert.equal("categories" in response.body.programs[0], false);
});

test("GET /api/v1/epg/programs/:id returns mapped details and recording state", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id, {
		number: "12.1",
		name: "Details Channel"
	});
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id);
	await new ChannelEpgMapRepository(db).upsert(channel.id, epgChannel.id);
	const program = await seedProgram(
		epgChannel.id,
		new Date("2026-01-01T20:00:00Z"),
		new Date("2026-01-01T21:00:00Z"),
		"Details Show"
	);
	const recording = await new RecordingsRepository(db).create({
		channelId: channel.id,
		programId: program.id,
		title: program.title,
		status: "scheduled",
		scheduledStart: program.start,
		scheduledEnd: program.stop
	});

	const response = await request(buildApp()).get(
		`/api/v1/epg/programs/${program.id}`
	);

	assert.equal(response.status, 200);
	assert.equal(response.body.program.id, program.id);
	assert.equal(response.body.program.recordingId, recording.id);
	assert.equal(response.body.program.recordingStatus, "scheduled");
	assert.equal(response.body.channel.id, channel.id);
});

test("GET /api/v1/epg/programs/:id returns 404 for a deleted program", async () => {
	const response = await request(buildApp()).get(
		`/api/v1/epg/programs/${randomUUID()}`
	);

	assert.equal(response.status, 404);
	assert.equal(response.body.error.code, "not_found");
});

test("GET /api/v1/epg/grid returns 400 when from >= to", async () => {
	const app = buildApp();

	const res = await request(app).get("/api/v1/epg/grid").query({
		from: "2026-01-02T00:00:00.000Z",
		to: "2026-01-01T00:00:00.000Z"
	});

	assert.equal(res.status, 400);
});

test("GET /api/v1/epg/grid returns 400 when query params are missing", async () => {
	const app = buildApp();

	const res = await request(app).get("/api/v1/epg/grid");

	assert.equal(res.status, 400);
});
