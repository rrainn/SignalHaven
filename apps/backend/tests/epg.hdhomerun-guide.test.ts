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
import { EventBus, type PublishedEvent } from "../src/events/event-bus";
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
	  logical_channel_epg_map, channel_epg_map, recordings, series_rules,
      epg_programs, epg_channels, epg_sources,
	  channels, logical_channels, settings, scheduled_jobs, tuners
    RESTART IDENTITY CASCADE
  `);
});

const LEGACY_GUIDE_URL =
	"https://api.hdhomerun.com/api/guide.php?DeviceAuth=ABCDEF1234567890";
const XMLTV_GUIDE_URL =
	"https://api.hdhomerun.com/api/xmltv?DeviceAuth=ABCDEF1234567890";

// This fixture verifies that managed HDHomeRun sources use the shared,
// streaming XMLTV import path without depending on SiliconDust in tests.
const HDHOMERUN_XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="2.1"><display-name>WCBS-DT</display-name></channel>
  <programme channel="2.1" start="20300601000000 +0000" stop="20300601010000 +0000">
    <title>Morning News</title>
  </programme>
</tv>`;

// Real guide feeds can repeat the same channel and time slot in one document.
// The refresh should treat those rows as updates instead of failing the batch.
const DUPLICATE_HDHOMERUN_XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="2.1"><display-name>WCBS-DT</display-name></channel>
  <channel id="2.1"><display-name>WCBS Updated</display-name></channel>
  <programme channel="2.1" start="20300601000000 +0000" stop="20300601010000 +0000">
    <title>Morning News</title>
  </programme>
  <programme channel="2.1" start="20300601000000 +0000" stop="20300601010000 +0000">
    <title>Morning News Updated</title>
  </programme>
</tv>`;

/** Creates the pre-managed source shape used by existing installations. */
async function createLegacySource() {
	return new EpgSourcesRepository(db).create({
		kind: "hdhomerun_guide",
		name: "Test HDHR",
		url: LEGACY_GUIDE_URL
	});
}

test("EpgService.refresh upgrades legacy HDHomeRun URLs to XMLTV", async () => {
	const source = await createLegacySource();
	const bus = new EventBus();
	const events: PublishedEvent[] = [];
	const openedTargets: string[] = [];
	bus.subscribe("epg", (event) => events.push(event));

	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		bus,
		openInput: async (target) => {
			openedTargets.push(target);
			return Readable.from([Buffer.from(HDHOMERUN_XMLTV, "utf8")]);
		}
	});

	const result = await service.refresh(source.id);

	assert.equal(result.channelsUpserted, 1);
	assert.equal(result.programsUpserted, 1);
	assert.deepEqual(openedTargets, [XMLTV_GUIDE_URL]);

	const phases = events
		.filter((event) => event.event === "epg.refresh")
		.map((event) => (event.data as { phase: string }).phase);
	assert.ok(phases.includes("started"));
	assert.ok(phases.includes("completed"));

	const reloaded = await service.getById(source.id);
	assert.equal(reloaded.lastRefreshStatus, "ok");
	assert.equal(reloaded.lastRefreshError, null);
});

test("EpgService resolves fresh tuner auth and imports the XMLTV guide", async () => {
	const tuner = await new TunersRepository(db).create({
		kind: "hdhomerun",
		name: "Living Room",
		config: { host: "192.0.2.10" }
	});
	const resolvedTunerIds: string[] = [];
	const openedTargets: string[] = [];
	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		openInput: async (target) => {
			openedTargets.push(target);
			return Readable.from([Buffer.from(HDHOMERUN_XMLTV, "utf8")]);
		},
		resolveHdhomerunGuideUrl: async (tunerId) => {
			resolvedTunerIds.push(tunerId);
			return XMLTV_GUIDE_URL;
		}
	});

	const first = await service.ensureHdhomerunSource({
		id: tuner.id,
		kind: "hdhomerun",
		name: tuner.name
	});
	const second = await service.ensureHdhomerunSource({
		id: tuner.id,
		kind: "hdhomerun",
		name: tuner.name
	});

	assert.ok(first);
	assert.equal(second?.id, first.id);
	assert.equal(first.tunerId, tuner.id);
	assert.equal(first.url, null);

	const result = await service.refresh(first.id);
	assert.equal(result.channelsUpserted, 1);
	assert.equal(result.programsUpserted, 1);
	assert.deepEqual(resolvedTunerIds, [tuner.id]);
	assert.deepEqual(openedTargets, [XMLTV_GUIDE_URL]);
});

test("EpgService refreshes HDHomeRun XMLTV containing duplicate rows", async () => {
	const source = await createLegacySource();
	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		openInput: async () =>
			Readable.from([Buffer.from(DUPLICATE_HDHOMERUN_XMLTV, "utf8")])
	});

	const result = await service.refresh(source.id);

	assert.equal(result.channelsSeen, 2);
	assert.equal(result.programsSeen, 2);
	assert.equal(result.channelsUpserted, 1);
	assert.equal(result.programsUpserted, 1);

	const channelCount = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM epg_channels WHERE source_id = $1",
		[source.id]
	);
	const programCount = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM epg_programs"
	);
	const imported = await pool.query<{
		display_name: string;
		title: string;
	}>(
		`SELECT c.display_name, p.title
       FROM epg_channels c
       JOIN epg_programs p ON p.epg_channel_id = c.id
      WHERE c.source_id = $1`,
		[source.id]
	);
	assert.equal(channelCount.rows[0]?.count, 1);
	assert.equal(programCount.rows[0]?.count, 1);
	assert.equal(imported.rows[0]?.display_name, "WCBS Updated");
	assert.equal(imported.rows[0]?.title, "Morning News Updated");
});

test("EpgService.create rejects hdhomerun_guide without a tuner or URL", async () => {
	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool
	});

	await assert.rejects(
		service.create({
			kind: "hdhomerun_guide",
			name: "Bad",
			filePath: "/tmp/whatever"
		}),
		/requires a tuner or legacy URL/
	);
});
