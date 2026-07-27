import assert from "node:assert/strict";
import { Readable } from "node:stream";
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
import { EpgService } from "../src/epg/epg.service";
import { EpgMatcherService } from "../src/epg/epg-matcher.service";
import { ChannelEpgMapRepository } from "../src/repositories/channel-epg-map.repository";
import { ChannelsRepository } from "../src/repositories/channels.repository";
import { EpgChannelsRepository } from "../src/repositories/epg-channels.repository";
import { EpgSourcesRepository } from "../src/repositories/epg-sources.repository";
import { TunersRepository } from "../src/repositories/tuners.repository";

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
      channel_epg_map, recordings, series_rules,
      epg_programs, epg_channels, epg_sources,
      channels, settings, scheduled_jobs, tuners
    RESTART IDENTITY CASCADE
  `);
});

async function seedTuner() {
	const repo = new TunersRepository(db);
	return repo.create({
		kind: "hdhomerun",
		name: "Test Tuner",
		config: { host: "127.0.0.1" }
	});
}

async function seedSource() {
	const repo = new EpgSourcesRepository(db);
	return repo.create({
		kind: "xmltv",
		name: "Test XMLTV",
		url: "memory://fixture"
	});
}

test("EpgMatcherService.getCandidates ranks via tvg-id then name then prefix", async () => {
	const tuner = await seedTuner();
	const source = await seedSource();

	const channelsRepo = new ChannelsRepository(db);
	const epgChannelsRepo = new EpgChannelsRepository(db);
	const mapRepo = new ChannelEpgMapRepository(db);

	const channel = await channelsRepo.create({
		tunerId: tuner.id,
		number: "5.1",
		name: "News 5",
		enabled: true,
		sortOrder: 1,
		tvgId: "news5.example.com"
	});

	const exact = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "ext-exact",
		displayName: "News 5"
	});
	const tvg = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "news5.example.com",
		displayName: "Other Display"
	});
	const prefix = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "ext-prefix",
		displayName: "5 Sports"
	});

	const matcher = new EpgMatcherService({
		channelsRepository: channelsRepo,
		epgChannelsRepository: epgChannelsRepo,
		epgSourcesRepository: new EpgSourcesRepository(db),
		channelEpgMapRepository: mapRepo
	});

	const ranked = await matcher.getCandidates(channel.id);
	const ids = ranked.map((c) => c.epgChannel.id);
	assert.deepEqual(ids, [tvg.id, exact.id, prefix.id]);
	assert.equal(ranked[0]?.strategy, "tvg-id");
	assert.equal(ranked[1]?.strategy, "display-name");
	assert.equal(ranked[2]?.strategy, "channel-number-prefix");
});

test("EpgMatcherService.setManualMapping persists with manual=true", async () => {
	const tuner = await seedTuner();
	const source = await seedSource();
	const channelsRepo = new ChannelsRepository(db);
	const epgChannelsRepo = new EpgChannelsRepository(db);
	const mapRepo = new ChannelEpgMapRepository(db);

	const channel = await channelsRepo.create({
		tunerId: tuner.id,
		number: "9.1",
		name: "Kids 9",
		enabled: true,
		sortOrder: 1
	});
	const epgChannel = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "kids-9",
		displayName: "Kids Guide"
	});
	let invalidations = 0;

	const matcher = new EpgMatcherService({
		channelsRepository: channelsRepo,
		epgChannelsRepository: epgChannelsRepo,
		epgSourcesRepository: new EpgSourcesRepository(db),
		channelEpgMapRepository: mapRepo,
		onMappingsChanged: () => {
			invalidations += 1;
		}
	});

	const result = await matcher.setManualMapping(channel.id, epgChannel.id);
	assert.equal(result.manual, true);
	const stored = await mapRepo.getByChannelId(channel.id);
	assert.ok(stored);
	assert.equal(stored.epgChannelId, epgChannel.id);
	assert.equal(stored.manual, true);
	assert.equal(invalidations, 1);
});

test("EpgMatcherService.autoMatchUnmapped maps unmapped channels and never overwrites manual", async () => {
	const tuner = await seedTuner();
	const source = await seedSource();
	const channelsRepo = new ChannelsRepository(db);
	const epgChannelsRepo = new EpgChannelsRepository(db);
	const mapRepo = new ChannelEpgMapRepository(db);

	const autoChannel = await channelsRepo.create({
		tunerId: tuner.id,
		number: "5.1",
		name: "News 5",
		enabled: true,
		sortOrder: 1
	});
	const manualChannel = await channelsRepo.create({
		tunerId: tuner.id,
		number: "9.1",
		name: "Kids 9",
		enabled: true,
		sortOrder: 2
	});

	const newsEpg = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "news",
		displayName: "News 5"
	});
	const wrongKidsEpg = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "kids-wrong",
		displayName: "Kids 9" // would auto-match but user has overridden
	});
	const correctKidsEpg = await epgChannelsRepo.create({
		sourceId: source.id,
		externalId: "kids-correct",
		displayName: "Children's Network"
	});

	// User has manually mapped the kids channel to the "correct" EPG row
	// even though name doesn't match — this must be preserved.
	await mapRepo.upsert(manualChannel.id, correctKidsEpg.id, true);
	let invalidations = 0;

	const matcher = new EpgMatcherService({
		channelsRepository: channelsRepo,
		epgChannelsRepository: epgChannelsRepo,
		epgSourcesRepository: new EpgSourcesRepository(db),
		channelEpgMapRepository: mapRepo,
		onMappingsChanged: () => {
			invalidations += 1;
		}
	});

	const summary = await matcher.autoMatchUnmapped();
	assert.equal(summary.considered, 1);
	assert.equal(summary.matched, 1);
	assert.equal(invalidations, 1);

	const newsMapping = await mapRepo.getByChannelId(autoChannel.id);
	assert.ok(newsMapping);
	assert.equal(newsMapping.epgChannelId, newsEpg.id);
	assert.equal(newsMapping.manual, false);

	const kidsMapping = await mapRepo.getByChannelId(manualChannel.id);
	assert.ok(kidsMapping);
	assert.equal(kidsMapping.epgChannelId, correctKidsEpg.id);
	assert.equal(kidsMapping.manual, true);
	// Sanity: the wrong (auto-matchable) row must not have stolen the slot.
	assert.notEqual(kidsMapping.epgChannelId, wrongKidsEpg.id);
});

test("EpgMatcherService scopes automatic matches to the guide linked to each tuner", async () => {
	const tunersRepo = new TunersRepository(db);
	const hdhomerun = await tunersRepo.create({
		kind: "hdhomerun",
		name: "Antenna",
		config: { host: "127.0.0.1" }
	});
	const iptv = await tunersRepo.create({
		kind: "iptv",
		name: "IPTV",
		config: {
			url: "https://example.test/playlist.m3u",
			epgUrl: "https://example.test/guide.xml"
		}
	});
	const sourcesRepo = new EpgSourcesRepository(db);
	const hdhomerunSource = await sourcesRepo.create({
		kind: "hdhomerun_guide",
		name: "Antenna guide",
		tunerId: hdhomerun.id
	});
	const iptvSource = await sourcesRepo.create({
		kind: "xmltv",
		name: "IPTV guide",
		url: "https://example.test/guide.xml",
		tunerId: iptv.id
	});
	const channelsRepo = new ChannelsRepository(db);
	const epgChannelsRepo = new EpgChannelsRepository(db);
	const mapRepo = new ChannelEpgMapRepository(db);
	const antennaChannel = await channelsRepo.create({
		tunerId: hdhomerun.id,
		number: "5.1",
		name: "Local Five",
		enabled: true,
		sortOrder: 0
	});
	const iptvChannel = await channelsRepo.create({
		tunerId: iptv.id,
		number: "1",
		name: "Local Five",
		tvgId: "local-five.example",
		enabled: true,
		sortOrder: 0
	});
	const antennaGuideChannel = await epgChannelsRepo.create({
		sourceId: hdhomerunSource.id,
		externalId: "antenna-five",
		displayName: "Local Five",
		displayNames: ["Local Five", "5.1"]
	});
	const iptvGuideChannel = await epgChannelsRepo.create({
		sourceId: iptvSource.id,
		externalId: "local-five.example",
		displayName: "Local Five",
		displayNames: ["Local Five", "1"]
	});
	const matcher = new EpgMatcherService({
		channelsRepository: channelsRepo,
		epgChannelsRepository: epgChannelsRepo,
		epgSourcesRepository: sourcesRepo,
		channelEpgMapRepository: mapRepo
	});
	// Simulate mappings produced before guide candidates were source-scoped.
	await mapRepo.upsert(antennaChannel.id, iptvGuideChannel.id, false);
	await mapRepo.upsert(iptvChannel.id, antennaGuideChannel.id, false);

	await matcher.autoMatchUnmapped();

	assert.equal(
		(await mapRepo.getByChannelId(antennaChannel.id))?.epgChannelId,
		antennaGuideChannel.id
	);
	assert.equal(
		(await mapRepo.getByChannelId(iptvChannel.id))?.epgChannelId,
		iptvGuideChannel.id
	);
});

test("EpgService provisions the configured IPTV EPG URL as a tuner-owned source", async () => {
	const tuner = await new TunersRepository(db).create({
		kind: "iptv",
		name: "IPTV",
		config: {
			url: "https://example.test/playlist.m3u",
			epgUrl: "https://example.test/guide.xml"
		}
	});
	const repository = new EpgSourcesRepository(db);
	const service = new EpgService({ repository, pool });

	const source = await service.ensureTunerSource({
		id: tuner.id,
		kind: "iptv",
		name: tuner.name,
		config: tuner.config as Record<string, unknown>
	});

	assert.ok(source);
	assert.equal(source.kind, "xmltv");
	assert.equal(source.tunerId, tuner.id);
	assert.equal(source.url, "https://example.test/guide.xml");
});

test("EpgService adopts an existing matching IPTV XMLTV source", async () => {
	const tuner = await new TunersRepository(db).create({
		kind: "iptv",
		name: "IPTV",
		config: {
			url: "https://example.test/playlist.m3u",
			epgUrl: "https://example.test/guide.xml"
		}
	});
	const repository = new EpgSourcesRepository(db);
	const existing = await repository.create({
		kind: "xmltv",
		name: "Previously manual guide",
		url: "https://example.test/guide.xml"
	});
	const service = new EpgService({ repository, pool });

	const source = await service.ensureTunerSource({
		id: tuner.id,
		kind: "iptv",
		name: tuner.name,
		config: tuner.config as Record<string, unknown>
	});

	assert.equal(source?.id, existing.id);
	assert.equal(source?.tunerId, tuner.id);
});

test("EpgService.refresh runs auto-match for unmapped channels after a successful import", async () => {
	const source = await seedSource();
	const tuner = await seedTuner();
	const channelsRepo = new ChannelsRepository(db);
	const epgChannelsRepo = new EpgChannelsRepository(db);
	const mapRepo = new ChannelEpgMapRepository(db);

	const channel = await channelsRepo.create({
		tunerId: tuner.id,
		number: "1.1",
		name: "Channel One",
		enabled: true,
		sortOrder: 1
	});

	const matcher = new EpgMatcherService({
		channelsRepository: channelsRepo,
		epgChannelsRepository: epgChannelsRepo,
		epgSourcesRepository: new EpgSourcesRepository(db),
		channelEpgMapRepository: mapRepo
	});

	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		matcher,
		openInput: async () =>
			Readable.from([
				Buffer.from(
					`<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="c1"><display-name>Channel One</display-name></channel>
  <programme channel="c1" start="20990101120000 +0000" stop="20990101130000 +0000">
    <title>Future Show</title>
  </programme>
</tv>`,
					"utf8"
				)
			])
	});

	await service.refresh(source.id);

	const mapping = await mapRepo.getByChannelId(channel.id);
	assert.ok(mapping, "expected channel to be auto-mapped after refresh");
	assert.equal(mapping.manual, false);

	const epgRow = await pool.query<{ display_name: string }>(
		"SELECT display_name FROM epg_channels WHERE id = $1",
		[mapping.epgChannelId]
	);
	assert.equal(epgRow.rows[0]?.display_name, "Channel One");
});

test("EpgService maps HDHomeRun XMLTV aliases to exact tuner channel numbers", async () => {
	const tuner = await seedTuner();
	const source = await new EpgSourcesRepository(db).create({
		kind: "hdhomerun_guide",
		name: "Test HDHomeRun guide",
		tunerId: tuner.id
	});
	const channelsRepo = new ChannelsRepository(db);
	const epgChannelsRepo = new EpgChannelsRepository(db);
	const mapRepo = new ChannelEpgMapRepository(db);

	const station = await channelsRepo.create({
		tunerId: tuner.id,
		number: "4.1",
		name: "KCNC-TV",
		enabled: true,
		sortOrder: 1
	});
	const firstLaff = await channelsRepo.create({
		tunerId: tuner.id,
		number: "7.3",
		name: "Laff",
		enabled: true,
		sortOrder: 2
	});
	const secondLaff = await channelsRepo.create({
		tunerId: tuner.id,
		number: "10.1",
		name: "Laff",
		enabled: true,
		sortOrder: 3
	});

	const matcher = new EpgMatcherService({
		channelsRepository: channelsRepo,
		epgChannelsRepository: epgChannelsRepo,
		epgSourcesRepository: new EpgSourcesRepository(db),
		channelEpgMapRepository: mapRepo
	});
	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		matcher,
		resolveHdhomerunGuideUrl: async () => "memory://hdhomerun-guide",
		openInput: async () =>
			Readable.from([
				Buffer.from(
					`<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="US19330.hdhomerun.com">
    <display-name>KCNCDT</display-name>
    <display-name>4.1</display-name>
  </channel>
  <channel id="US-LAFF-73.hdhomerun.com">
    <display-name>LAFF</display-name>
    <display-name>7.3</display-name>
  </channel>
  <channel id="US-LAFF-101.hdhomerun.com">
    <display-name>LAFF</display-name>
    <display-name>10.1</display-name>
  </channel>
  <programme channel="US19330.hdhomerun.com" start="20990101120000 +0000" stop="20990101130000 +0000">
    <title>Station Show</title>
  </programme>
  <programme channel="US-LAFF-73.hdhomerun.com" start="20990101120000 +0000" stop="20990101130000 +0000">
    <title>First Laff Show</title>
  </programme>
  <programme channel="US-LAFF-101.hdhomerun.com" start="20990101120000 +0000" stop="20990101130000 +0000">
    <title>Second Laff Show</title>
  </programme>
</tv>`,
					"utf8"
				)
			])
	});

	await service.refresh(source.id);

	const mappings = await Promise.all(
		[station, firstLaff, secondLaff].map((channel) =>
			mapRepo.getByChannelId(channel.id)
		)
	);
	assert.ok(mappings.every((mapping) => mapping !== null));

	const mappedRows = await Promise.all(
		mappings.map((mapping) => epgChannelsRepo.getById(mapping!.epgChannelId))
	);
	assert.deepEqual(
		mappedRows.map((row) => row?.externalId),
		[
			"US19330.hdhomerun.com",
			"US-LAFF-73.hdhomerun.com",
			"US-LAFF-101.hdhomerun.com"
		]
	);

	// A later refresh must repair a stale auto-map from an older deployment.
	await mapRepo.upsert(secondLaff.id, mappings[1]!.epgChannelId, false);
	await service.refresh(source.id);

	const repairedMapping = await mapRepo.getByChannelId(secondLaff.id);
	assert.ok(repairedMapping);
	const repairedRow = await epgChannelsRepo.getById(
		repairedMapping.epgChannelId
	);
	assert.equal(repairedRow?.externalId, "US-LAFF-101.hdhomerun.com");
});
