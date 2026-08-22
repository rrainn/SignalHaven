/**
 * Integration tests for the channels list endpoint and EpgMatcherService
 * methods added in the "feat(channels): add endpoint to list channels with
 * EPG mapping and tuner info" commit.
 *
 * Covers:
 *   - EpgMatcherService.listChannelsSummary (new method)
 *   - GET  /api/v1/channels
 *   - GET  /api/v1/channels/:id/epg-candidates (HTTP 404 path)
 *   - PUT  /api/v1/channels/:id/epg-mapping    (HTTP 404 paths)
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
import { createTestAuthentication } from "../src/auth/middleware";
import { resolveMigrationsFolder } from "../src/db/config";
import { runMigrations } from "../src/db/migrate";
import { EpgMatcherService } from "../src/epg/epg-matcher.service";
import { ChannelEpgMapRepository } from "../src/repositories/channel-epg-map.repository";
import { ChannelsRepository } from "../src/repositories/channels.repository";
import { EpgChannelsRepository } from "../src/repositories/epg-channels.repository";
import { EpgSourcesRepository } from "../src/repositories/epg-sources.repository";
import { TunersRepository } from "../src/repositories/tuners.repository";
import { UserPreferencesRepository } from "../src/repositories/user-preferences.repository";
import { createApp } from "../src/app";
import { getEventBus } from "../src/events";
import { createDefaultTunerRegistry } from "../src/tuners/registry";
import { TunersService } from "../src/tuners/tuners.service";

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

async function seedTuner(name = "Test Tuner") {
	const repo = new TunersRepository(db);
	return repo.create({
		kind: "hdhomerun",
		name,
		config: { host: "127.0.0.1" }
	});
}

async function seedChannel(
	tunerId: string,
	opts: Partial<{
		number: string;
		name: string;
		sortOrder: number;
		tvgId: string;
		enabled: boolean;
	}> = {}
) {
	const repo = new ChannelsRepository(db);
	return repo.create({
		tunerId,
		number: opts.number ?? "1.1",
		name: opts.name ?? "Channel 1",
		enabled: opts.enabled ?? true,
		sortOrder: opts.sortOrder ?? 1,
		...(opts.tvgId !== undefined ? { tvgId: opts.tvgId } : {})
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

function buildMatcher() {
	return new EpgMatcherService({
		channelsRepository: new ChannelsRepository(db),
		epgChannelsRepository: new EpgChannelsRepository(db),
		epgSourcesRepository: new EpgSourcesRepository(db),
		channelEpgMapRepository: new ChannelEpgMapRepository(db)
	});
}

/** Build an Express app wired to the testcontainer database. */
function buildApp(authentication = createTestAuthentication()) {
	const bus = getEventBus();
	const tunersService = new TunersService({
		repository: new TunersRepository(db),
		registry: createDefaultTunerRegistry(),
		bus
	});
	const epgMatcherService = buildMatcher();
	return createApp({
		authentication,
		tunersService,
		epgMatcherService,
		channelsRepository: new ChannelsRepository(db)
	});
}

// ---------------------------------------------------------------------------
// EpgMatcherService.listChannelsSummary — unit-level tests
// ---------------------------------------------------------------------------

test("EpgMatcherService.listChannelsSummary returns empty array when no channels exist", async () => {
	const matcher = buildMatcher();
	const result = await matcher.listChannelsSummary();
	assert.deepEqual(result, []);
});

test("EpgMatcherService.listChannelsSummary returns channels sorted by sortOrder", async () => {
	const tuner = await seedTuner();
	const ch2 = await seedChannel(tuner.id, {
		name: "Beta",
		number: "2.1",
		sortOrder: 2
	});
	const ch1 = await seedChannel(tuner.id, {
		name: "Alpha",
		number: "1.1",
		sortOrder: 1
	});
	const ch3 = await seedChannel(tuner.id, {
		name: "Gamma",
		number: "3.1",
		sortOrder: 3
	});

	const matcher = buildMatcher();
	const result = await matcher.listChannelsSummary();

	assert.equal(result.length, 3);
	assert.equal(result[0]!.channel.id, ch1.id);
	assert.equal(result[1]!.channel.id, ch2.id);
	assert.equal(result[2]!.channel.id, ch3.id);
});

test("EpgMatcherService.listChannelsSummary reflects mappedEpgChannelId when a mapping exists", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id, "Test EPG");

	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(channel.id, epgChannel.id, false);

	const matcher = buildMatcher();
	const result = await matcher.listChannelsSummary();

	assert.equal(result.length, 1);
	assert.equal(result[0]!.mappedEpgChannelId, epgChannel.id);
});

test("EpgMatcherService.listChannelsSummary returns null mappedEpgChannelId for unmapped channels", async () => {
	const tuner = await seedTuner();
	await seedChannel(tuner.id);

	const matcher = buildMatcher();
	const result = await matcher.listChannelsSummary();

	assert.equal(result.length, 1);
	assert.equal(result[0]!.mappedEpgChannelId, null);
});

test("EpgMatcherService.listChannelsSummary handles mix of mapped and unmapped channels", async () => {
	const tuner = await seedTuner();
	const chMapped = await seedChannel(tuner.id, {
		name: "Mapped",
		sortOrder: 1
	});
	const chUnmapped = await seedChannel(tuner.id, {
		name: "Unmapped",
		sortOrder: 2
	});
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id);

	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(chMapped.id, epgChannel.id, true);

	const matcher = buildMatcher();
	const result = await matcher.listChannelsSummary();

	assert.equal(result.length, 2);
	const mappedEntry = result.find((r) => r.channel.id === chMapped.id);
	const unmappedEntry = result.find((r) => r.channel.id === chUnmapped.id);
	assert.ok(mappedEntry);
	assert.ok(unmappedEntry);
	assert.equal(mappedEntry.mappedEpgChannelId, epgChannel.id);
	assert.equal(unmappedEntry.mappedEpgChannelId, null);
});

// ---------------------------------------------------------------------------
// GET /api/v1/channels — HTTP integration tests
// ---------------------------------------------------------------------------

test("GET /api/v1/channels returns 200 with empty items array when no channels", async () => {
	const app = buildApp();

	const res = await request(app).get("/api/v1/channels");

	assert.equal(res.status, 200);
	assert.ok(Array.isArray(res.body.items));
	assert.equal(res.body.items.length, 0);
});

test("GET /api/v1/channels returns channel list with tuner and mapping info", async () => {
	const tuner = await seedTuner("HDHR Primary");
	const channel = await seedChannel(tuner.id, {
		name: "News 5",
		number: "5.1",
		sortOrder: 1,
		tvgId: "news5.local"
	});
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id, "News 5");
	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(channel.id, epgChannel.id, false);

	const app = buildApp();

	const res = await request(app).get("/api/v1/channels");

	assert.equal(res.status, 200);
	assert.equal(res.body.items.length, 1);

	const item = res.body.items[0];
	assert.equal(item.id, channel.id);
	assert.equal(item.name, "News 5");
	assert.equal(item.number, "5.1");
	assert.equal(item.tvgId, "news5.local");
	assert.equal(item.tunerId, tuner.id);
	assert.equal(item.tunerName, "HDHR Primary");
	assert.equal(item.tunerKind, "hdhomerun");
	assert.equal(item.enabled, true);
	assert.equal(item.sortOrder, 1);
	assert.equal(item.hasMapping, true);
	assert.equal(item.logoUrl, null);
});

test("GET /api/v1/channels returns hasMapping=false for unmapped channels", async () => {
	const tuner = await seedTuner();
	await seedChannel(tuner.id, { name: "Unmapped", sortOrder: 1 });

	const app = buildApp();

	const res = await request(app).get("/api/v1/channels");

	assert.equal(res.status, 200);
	assert.equal(res.body.items.length, 1);
	assert.equal(res.body.items[0].hasMapping, false);
});

test("GET /api/v1/channels returns channels in sortOrder ascending order", async () => {
	const tuner = await seedTuner();
	await seedChannel(tuner.id, { name: "Beta", number: "2.1", sortOrder: 2 });
	await seedChannel(tuner.id, { name: "Alpha", number: "1.1", sortOrder: 1 });
	await seedChannel(tuner.id, { name: "Gamma", number: "3.1", sortOrder: 3 });

	const app = buildApp();

	const res = await request(app).get("/api/v1/channels");

	assert.equal(res.status, 200);
	assert.equal(res.body.items.length, 3);
	assert.equal(res.body.items[0].name, "Alpha");
	assert.equal(res.body.items[1].name, "Beta");
	assert.equal(res.body.items[2].name, "Gamma");
});

test("GET /api/v1/channels/:id/diagnostics resolves the original provider stream URL", async () => {
	const tuner = await new TunersRepository(db).create({
		kind: "hls",
		name: "Direct HLS",
		config: {
			url: "https://streams.example.test/live/news.m3u8?token=diagnostic",
			channelName: "Provider News"
		}
	});
	const channel = await seedChannel(tuner.id, {
		name: "Displayed News",
		number: "42",
		sortOrder: 7,
		tvgId: "news.example"
	});

	const response = await request(buildApp()).get(
		`/api/v1/channels/${channel.id}/diagnostics`
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers["cache-control"], "private, no-store");
	assert.equal(response.body.channel.name, "Displayed News");
	assert.equal(response.body.channel.number, "42");
	assert.equal(response.body.sources[0].tunerName, "Direct HLS");
	// Diagnostics must report the same fallback identifier passed to playback
	// when a legacy row has no stored provider channel ID or lineup match.
	assert.equal(response.body.sources[0].resolvedProviderChannelId, "42");
	assert.equal(
		response.body.sources[0].streamUrl,
		"https://streams.example.test/live/news.m3u8?token=diagnostic"
	);
});

test("GET /api/v1/channels/:id/diagnostics is restricted to administrators", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const standardUserAuthentication = createTestAuthentication({
		id: randomUUID(),
		username: "viewer",
		role: "user"
	});

	const response = await request(buildApp(standardUserAuthentication)).get(
		`/api/v1/channels/${channel.id}/diagnostics`
	);

	assert.equal(response.status, 403);
});

test("POST /api/v1/channels/merge groups sources under the primary channel", async () => {
	const primaryTuner = await seedTuner("Primary");
	const backupTuner = await seedTuner("Backup");
	const primary = await seedChannel(primaryTuner.id, {
		name: "News",
		number: "5.1",
		sortOrder: 1
	});
	const backup = await seedChannel(backupTuner.id, {
		name: "News backup",
		number: "5.1",
		sortOrder: 2
	});

	const response = await request(buildApp())
		.post("/api/v1/channels/merge")
		.send({
			channelIds: [primary.id, backup.id],
			primaryChannelId: primary.id
		});

	assert.equal(response.status, 200);
	assert.equal(response.body.items.length, 1);
	assert.equal(response.body.items[0].id, primary.id);
	assert.deepEqual(
		response.body.items[0].sources.map((source: { id: string }) => source.id),
		[primary.id, backup.id]
	);
	assert.equal(
		(await new ChannelsRepository(db).getById(backup.id))?.logicalChannelId,
		primary.id
	);
});

test("merging channels reconciles every user's channel and playback preferences", async () => {
	const primaryTuner = await seedTuner("Primary");
	const backupTuner = await seedTuner("Backup");
	const primary = await seedChannel(primaryTuner.id, { sortOrder: 1 });
	const backup = await seedChannel(backupTuner.id, { sortOrder: 2 });
	const preferences = new UserPreferencesRepository(db);
	const adminId = "00000000-0000-4000-8000-000000000001";
	const secondUserId = randomUUID();
	await pool.query(
		`INSERT INTO users (
			id, username, username_normalized, password_hash, role, activated_at
		 ) VALUES ($1, 'viewer', 'viewer', 'test-hash', 'user', now())`,
		[secondUserId]
	);
	for (const userId of [adminId, secondUserId]) {
		await preferences.upsertManyForUser(userId, {
			channels: {
				favorites: [backup.id],
				hidden: [primary.id, backup.id],
				order: [backup.id, primary.id]
			},
			player: {
				volume: 1,
				muted: false,
				captionsEnabled: false,
				qualityByChannel: { [backup.id]: "720p" }
			}
		});
	}

	await new ChannelsRepository(db).mergeLogicalChannels(
		[primary.id, backup.id],
		primary.id
	);

	for (const userId of [adminId, secondUserId]) {
		const stored = await preferences.listForUser(userId);
		assert.deepEqual(stored["channels"], {
			favorites: [primary.id],
			hidden: [primary.id],
			order: [primary.id]
		});
		assert.deepEqual(stored["player"], {
			volume: 1,
			muted: false,
			captionsEnabled: false,
			qualityByChannel: { [primary.id]: "720p" }
		});
	}
});

test("source preference and split operations preserve physical source identity", async () => {
	const primaryTuner = await seedTuner("Primary");
	const backupTuner = await seedTuner("Backup");
	const primary = await seedChannel(primaryTuner.id, { sortOrder: 1 });
	const backup = await seedChannel(backupTuner.id, {
		name: "Backup News",
		number: "12.4",
		sortOrder: 2
	});
	const app = buildApp();
	await request(app)
		.post("/api/v1/channels/merge")
		.send({
			channelIds: [primary.id, backup.id],
			primaryChannelId: primary.id
		});

	const preferred = await request(app).post(
		`/api/v1/channels/${primary.id}/sources/${backup.id}/preferred`
	);
	assert.equal(preferred.status, 200);
	assert.equal(preferred.body.items[0].sources[0].id, backup.id);
	assert.equal(preferred.body.items[0].name, "Backup News");
	assert.equal(preferred.body.items[0].number, "12.4");

	const split = await request(app).post(
		`/api/v1/channels/${primary.id}/sources/${backup.id}/split`
	);
	assert.equal(split.status, 200);
	assert.equal(split.body.items.length, 2);
	assert.ok(
		split.body.items.some((item: { sources: Array<{ id: string }> }) =>
			item.sources.some((source) => source.id === backup.id)
		)
	);
	const originalGroup = split.body.items.find(
		(item: { id: string }) => item.id === primary.id
	);
	assert.equal(originalGroup.name, "Channel 1");
	assert.equal(originalGroup.sources[0].priority, 0);
});

test("preferred source metadata moves the logical channel without changing its id", async () => {
	const tuner = await seedTuner("Primary");
	const source = await seedChannel(tuner.id, {
		name: "News",
		number: "5.1",
		sortOrder: 1
	});
	const repository = new ChannelsRepository(db);

	await repository.update(source.id, {
		name: "News HD",
		number: "12.4",
		sortOrder: 4
	});

	const logical = await repository.getLogicalChannelById(source.id);
	assert.equal(logical?.id, source.id);
	assert.equal(logical?.name, "News HD");
	assert.equal(logical?.number, "12.4");
	assert.equal(logical?.sortOrder, 4);
});

test("temporary misses stay usable until the source becomes unavailable", async () => {
	const tuner = await seedTuner("Primary");
	const source = await seedChannel(tuner.id);
	const repository = new ChannelsRepository(db);

	await repository.update(source.id, { sourceStatus: "missing" });
	assert.deepEqual(
		(await repository.listEnabledForGrid()).map((channel) => channel.id),
		[source.id]
	);

	await repository.update(source.id, { sourceStatus: "unavailable" });
	assert.deepEqual(await repository.listEnabledForGrid(), []);
});

test("deleting a tuner delinks its source and promotes the remaining fallback", async () => {
	const primaryTuner = await seedTuner("Primary");
	const backupTuner = await seedTuner("Backup");
	const primary = await seedChannel(primaryTuner.id, {
		name: "Primary News",
		number: "5.1",
		sortOrder: 1
	});
	const backup = await seedChannel(backupTuner.id, {
		name: "Backup News",
		number: "12.4",
		sortOrder: 2
	});
	const channels = new ChannelsRepository(db);
	await channels.mergeLogicalChannels([primary.id, backup.id], primary.id);

	await new TunersRepository(db).delete(primaryTuner.id);

	const [summary] = await channels.listLogicalChannelSummaries();
	assert.ok(summary);
	assert.equal(summary.channel.id, primary.id);
	assert.equal(summary.channel.name, "Backup News");
	assert.equal(summary.channel.number, "12.4");
	assert.deepEqual(
		summary.sources.map((source) => source.id),
		[backup.id]
	);
	assert.equal(summary.sources[0]?.sourcePriority, 0);
});

// ---------------------------------------------------------------------------
// GET /api/v1/channels/:id/epg-candidates — 404 path
// ---------------------------------------------------------------------------

test("GET /api/v1/channels/:id/epg-candidates returns 404 when channel is not found", async () => {
	const app = buildApp();

	const unknownId = randomUUID();
	const res = await request(app).get(
		`/api/v1/channels/${unknownId}/epg-candidates`
	);

	assert.equal(res.status, 404);
	assert.equal(res.body.error.code, "not_found");
});

test("GET /api/v1/channels/:id/epg-candidates returns 400 when id is not a UUID", async () => {
	const app = buildApp();

	const res = await request(app).get(
		"/api/v1/channels/not-a-uuid/epg-candidates"
	);

	assert.equal(res.status, 400);
});

test("GET /api/v1/channels/:id/epg-candidates returns 200 with ranked candidates", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id, { name: "News 5", tvgId: "n5" });
	const source = await seedEpgSource();
	await seedEpgChannel(source.id, "News 5");

	const app = buildApp();

	const res = await request(app).get(
		`/api/v1/channels/${channel.id}/epg-candidates`
	);

	assert.equal(res.status, 200);
	assert.equal(res.body.channelId, channel.id);
	assert.ok(Array.isArray(res.body.candidates));
	assert.ok(res.body.candidates.length > 0);
	assert.equal(typeof res.body.candidates[0].epgChannelId, "string");
	assert.equal(typeof res.body.candidates[0].score, "number");
});

test("GET /api/v1/channels/:id/epg-candidates returns empty candidates when no EPG channels exist", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id, { name: "Lonely Channel" });

	const app = buildApp();

	const res = await request(app).get(
		`/api/v1/channels/${channel.id}/epg-candidates`
	);

	assert.equal(res.status, 200);
	assert.equal(res.body.channelId, channel.id);
	assert.deepEqual(res.body.candidates, []);
});

// ---------------------------------------------------------------------------
// PUT /api/v1/channels/:id/epg-mapping
// ---------------------------------------------------------------------------

test("PUT /api/v1/channels/:id/epg-mapping returns 200 and persists manual mapping", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id);

	const app = buildApp();

	const res = await request(app)
		.put(`/api/v1/channels/${channel.id}/epg-mapping`)
		.send({ epgChannelId: epgChannel.id });

	assert.equal(res.status, 200);
	assert.equal(res.body.channelId, channel.id);
	assert.equal(res.body.epgChannelId, epgChannel.id);
	assert.equal(res.body.manual, true);
});

test("PUT /api/v1/channels/:id/epg-mapping returns 404 when channel not found", async () => {
	const source = await seedEpgSource();
	const epgChannel = await seedEpgChannel(source.id);

	const app = buildApp();

	const unknownChannelId = randomUUID();
	const res = await request(app)
		.put(`/api/v1/channels/${unknownChannelId}/epg-mapping`)
		.send({ epgChannelId: epgChannel.id });

	assert.equal(res.status, 404);
	assert.equal(res.body.error.code, "not_found");
});

test("PUT /api/v1/channels/:id/epg-mapping returns 404 when EPG channel not found", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);

	const app = buildApp();

	const unknownEpgId = randomUUID();
	const res = await request(app)
		.put(`/api/v1/channels/${channel.id}/epg-mapping`)
		.send({ epgChannelId: unknownEpgId });

	assert.equal(res.status, 404);
	assert.equal(res.body.error.code, "not_found");
});

test("PUT /api/v1/channels/:id/epg-mapping returns 400 when body is invalid", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);

	const app = buildApp();

	const res = await request(app)
		.put(`/api/v1/channels/${channel.id}/epg-mapping`)
		.send({ epgChannelId: "not-a-uuid" });

	assert.equal(res.status, 400);
});

test("PUT /api/v1/channels/:id/epg-mapping returns 400 when id param is not a UUID", async () => {
	const app = buildApp();

	const res = await request(app)
		.put("/api/v1/channels/not-a-uuid/epg-mapping")
		.send({ epgChannelId: randomUUID() });

	assert.equal(res.status, 400);
});

test("PUT /api/v1/channels/:id/epg-mapping overrides a previous auto-mapping with manual=true", async () => {
	const tuner = await seedTuner();
	const channel = await seedChannel(tuner.id);
	const source = await seedEpgSource();
	const epgChannel1 = await seedEpgChannel(source.id, "Auto Match");
	const epgChannel2 = await seedEpgChannel(source.id, "Manual Choice");

	// Seed an existing auto-mapping first.
	const mapRepo = new ChannelEpgMapRepository(db);
	await mapRepo.upsert(channel.id, epgChannel1.id, false);

	const app = buildApp();

	const res = await request(app)
		.put(`/api/v1/channels/${channel.id}/epg-mapping`)
		.send({ epgChannelId: epgChannel2.id });

	assert.equal(res.status, 200);
	assert.equal(res.body.epgChannelId, epgChannel2.id);
	assert.equal(res.body.manual, true);

	// Verify it was persisted as manual.
	const stored = await mapRepo.getByChannelId(channel.id);
	assert.ok(stored);
	assert.equal(stored.epgChannelId, epgChannel2.id);
	assert.equal(stored.manual, true);
});
