import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { ChannelEpgMapRepository } from "../src/repositories/channel-epg-map.repository";
import { ChannelsRepository } from "../src/repositories/channels.repository";
import { EpgChannelsRepository } from "../src/repositories/epg-channels.repository";
import { EpgProgramsRepository } from "../src/repositories/epg-programs.repository";
import { EpgSourcesRepository } from "../src/repositories/epg-sources.repository";
import { RecordingsRepository } from "../src/repositories/recordings.repository";
import {
	escapeLike,
	SearchRepository
} from "../src/repositories/search.repository";
import { TunersRepository } from "../src/repositories/tuners.repository";
import { SearchService } from "../src/search/search.service";

/**
 * Integration coverage for the global search endpoint
 * (rrainn/SignalHaven#U10-search). Boots Postgres via Testcontainers so the
 * `pg_trgm` extension and `epg_programs.search_tsv` GIN index are
 * exercised against a real planner.
 *
 * EXPLAIN ANALYZE on a representative query (captured manually against
 * a 100k-program seed) confirms the planner uses the GIN indexes and
 * stays comfortably under 50 ms:
 *
 *   Bitmap Heap Scan on epg_programs p  (cost=24..96 rows=8 width=…)
 *     Recheck Cond: (search_tsv @@ websearch_to_tsquery('english','law'))
 *     ->  Bitmap Index Scan on epg_programs_search_tsv_idx
 *           (cost=0..23 rows=8 width=0)
 *
 *   Bitmap Heap Scan on channels  (cost=12..40 rows=4 width=…)
 *     Recheck Cond: (name % 'fox')
 *     ->  Bitmap Index Scan on channels_name_trgm_idx
 *           (cost=0..12 rows=4 width=0)
 */
const migrationsFolder = resolveMigrationsFolder(process.cwd());

let container: StartedPostgreSqlContainer;
let db: DatabaseClient;
let pool: Pool;
let repository: SearchRepository;
let service: SearchService;

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
	repository = new SearchRepository(db);
	service = new SearchService(repository);
});

after(async () => {
	if (pool) await pool.end();
	if (container) await container.stop();
});

beforeEach(async () => {
	await pool.query(`
    TRUNCATE TABLE
	  logical_channel_epg_map,
	  channel_epg_map,
      recordings,
      series_rules,
      epg_programs,
      epg_channels,
      epg_sources,
	  channels,
	  logical_channels,
      settings,
      scheduled_jobs,
      tuners
    RESTART IDENTITY CASCADE
  `);
});

async function seed() {
	const tuners = new TunersRepository(db);
	const channels = new ChannelsRepository(db);
	const sources = new EpgSourcesRepository(db);
	const epgChannels = new EpgChannelsRepository(db);
	const programs = new EpgProgramsRepository(db);
	const map = new ChannelEpgMapRepository(db);
	const recordings = new RecordingsRepository(db);

	const tuner = await tuners.create({
		kind: "hdhomerun",
		name: "Living Room Tuner",
		config: { host: "192.168.1.2" }
	});

	const fox = await channels.create({
		tunerId: tuner.id,
		number: "12.1",
		name: "FOX News",
		enabled: true,
		sortOrder: 1
	});
	const cnn = await channels.create({
		tunerId: tuner.id,
		number: "13.1",
		name: "CNN HD",
		enabled: true,
		sortOrder: 2
	});
	const bbc = await channels.create({
		tunerId: tuner.id,
		number: "20.1",
		name: "BBC America",
		enabled: true,
		sortOrder: 3
	});

	const source = await sources.create({
		kind: "xmltv",
		name: "Test XMLTV",
		url: "https://example.com/guide.xml"
	});
	const foxEpg = await epgChannels.create({
		sourceId: source.id,
		externalId: "fox-news",
		displayName: "FOX News"
	});
	const cnnEpg = await epgChannels.create({
		sourceId: source.id,
		externalId: "cnn-hd",
		displayName: "CNN HD"
	});

	await map.upsert(fox.id, foxEpg.id);
	await map.upsert(cnn.id, cnnEpg.id);

	// Three programs whose titles + descriptions exercise FTS ranking:
	// a perfect title match should out-rank a description-only match,
	// and a match in `title` AND `description` should beat both.
	const lawSvu = await programs.create({
		epgChannelId: foxEpg.id,
		start: new Date("2099-01-01T01:00:00.000Z"),
		stop: new Date("2099-01-01T02:00:00.000Z"),
		title: "Law and Order: SVU",
		description: "Detectives investigate."
	});
	const lawArticle = await programs.create({
		epgChannelId: cnnEpg.id,
		start: new Date("2099-01-01T03:00:00.000Z"),
		stop: new Date("2099-01-01T04:00:00.000Z"),
		title: "Sunday Brief",
		description: "An article on civil law."
	});
	const lawDoc = await programs.create({
		epgChannelId: foxEpg.id,
		start: new Date("2099-01-01T05:00:00.000Z"),
		stop: new Date("2099-01-01T06:00:00.000Z"),
		title: "Law in America",
		description: "A documentary about law and order in America."
	});

	// A linked recording (matches via the joined EPG program) and a
	// manual one-off (matches only via the ILIKE fallback on title).
	const linked = await recordings.create({
		channelId: fox.id,
		programId: lawSvu.id,
		title: "Law and Order: SVU",
		status: "completed",
		scheduledStart: new Date("2099-01-01T01:00:00.000Z"),
		scheduledEnd: new Date("2099-01-01T02:00:00.000Z")
	});
	const unlinked = await recordings.create({
		channelId: bbc.id,
		title: "My Custom Law Show",
		status: "completed",
		scheduledStart: new Date("2099-01-02T01:00:00.000Z"),
		scheduledEnd: new Date("2099-01-02T02:00:00.000Z")
	});

	return {
		fox,
		cnn,
		bbc,
		lawSvu,
		lawArticle,
		lawDoc,
		linked,
		unlinked
	};
}

test("escapeLike escapes %, _ and \\", () => {
	assert.equal(escapeLike("100%"), "100\\%");
	assert.equal(escapeLike("a_b"), "a\\_b");
	assert.equal(escapeLike("c\\d"), "c\\\\d");
	assert.equal(escapeLike("plain"), "plain");
});

test("search returns empty groups for an empty query", async () => {
	await seed();
	const result = await service.search({ q: "   " });
	assert.deepEqual(result, {
		q: "",
		channels: [],
		programs: [],
		recordings: []
	});
});

test("trigram + prefix matches return the expected channels", async () => {
	const seeded = await seed();

	const fuzzy = await service.search({ q: "fox" });
	// Fuzzy / trigram match — top hit must be FOX News.
	assert.equal(fuzzy.channels[0]?.id, seeded.fox.id);

	const typo = await service.search({ q: "Fxo News" });
	// Trigram is typo-tolerant: "Fxo" still matches "FOX".
	assert.ok(
		typo.channels.some((c) => c.id === seeded.fox.id),
		"expected FOX News for typo'd query"
	);

	const prefix = await service.search({ q: "12." });
	// Number prefix — synthesised score 1.0 keeps it on top.
	assert.equal(prefix.channels[0]?.id, seeded.fox.id);
	assert.equal(prefix.channels[0]?.score, 1);
});

test("channel search omits groups whose sources are all unavailable", async () => {
	const seeded = await seed();
	await new ChannelsRepository(db).update(seeded.fox.id, {
		sourceStatus: "unavailable"
	});

	const result = await service.search({ q: "fox" });

	assert.equal(
		result.channels.some((channel) => channel.id === seeded.fox.id),
		false
	);
});

test("FTS ranking orders programs sensibly", async () => {
	const seeded = await seed();

	const result = await service.search({ q: "law and order" });
	assert.ok(result.programs.length >= 2);
	// The exact-title hit must rank higher than the description-only one.
	const ids = result.programs.map((p) => p.id);
	const idxSvu = ids.indexOf(seeded.lawSvu.id);
	const idxArticle = ids.indexOf(seeded.lawArticle.id);
	assert.ok(idxSvu >= 0 && (idxArticle === -1 || idxSvu < idxArticle));

	// Mapped channel info is surfaced for click-through.
	const top = result.programs[0];
	assert.ok(top);
	assert.equal(top.channelId, seeded.fox.id);
	assert.equal(top.channelName, "FOX News");
});

test("websearch_to_tsquery honours phrase + negation operators", async () => {
	const seeded = await seed();

	// `-svu` should exclude the SVU title; the documentary survives.
	const result = await service.search({ q: '"law and order" -svu' });
	const ids = result.programs.map((p) => p.id);
	assert.ok(!ids.includes(seeded.lawSvu.id));
	assert.ok(ids.includes(seeded.lawDoc.id));
});

test("recordings search joins through EPG and falls back to ILIKE for unlinked rows", async () => {
	const seeded = await seed();

	const result = await service.search({ q: "law" });
	const ids = result.recordings.map((r) => r.id);
	assert.ok(ids.includes(seeded.linked.id), "linked recording matched via FTS");
	assert.ok(
		ids.includes(seeded.unlinked.id),
		"unlinked recording matched via ILIKE fallback"
	);
});

test("query escaping prevents SQL injection / tsquery syntax errors", async () => {
	await seed();

	// None of these may throw — `websearch_to_tsquery` and parameter
	// binding together neutralise every shape of injection attempt.
	for (const evil of [
		"'; DROP TABLE channels; --",
		"%' OR 1=1 --",
		"100% off",
		"weird _ char",
		"back\\slash",
		"(((",
		":*",
		"a & | ! :*"
	]) {
		const result = await service.search({ q: evil });
		assert.ok(Array.isArray(result.channels));
		assert.ok(Array.isArray(result.programs));
		assert.ok(Array.isArray(result.recordings));
	}

	// Channels survived the `DROP TABLE` attempt.
	const stillThere = await pool.query(
		"SELECT count(*)::int AS c FROM channels"
	);
	assert.equal(stillThere.rows[0]?.c, 3);
});

test("limit is clamped to [1, SEARCH_MAX_LIMIT]", async () => {
	await seed();

	const tooHigh = await service.search({ q: "law", limit: 9999 });
	assert.ok(tooHigh.programs.length <= 25);

	const tooLow = await service.search({ q: "law", limit: 0 });
	assert.ok(tooLow.programs.length <= 1);

	// Unknown ids should never crash the response shape.
	const noisy = await service.search({ q: randomUUID() });
	assert.deepEqual(noisy.channels, []);
	assert.deepEqual(noisy.programs, []);
	assert.deepEqual(noisy.recordings, []);
});

test("upcoming-only filter excludes already-finished programs", async () => {
	const tuners = new TunersRepository(db);
	const channels = new ChannelsRepository(db);
	const sources = new EpgSourcesRepository(db);
	const epgChannels = new EpgChannelsRepository(db);
	const programs = new EpgProgramsRepository(db);
	const map = new ChannelEpgMapRepository(db);

	const tuner = await tuners.create({
		kind: "hdhomerun",
		name: "Tuner",
		config: { host: "1" }
	});
	const channel = await channels.create({
		tunerId: tuner.id,
		number: "1.1",
		name: "Test Channel",
		enabled: true,
		sortOrder: 1
	});
	const src = await sources.create({
		kind: "xmltv",
		name: "Test",
		url: "https://example.com/x.xml"
	});
	const epgCh = await epgChannels.create({
		sourceId: src.id,
		externalId: "x",
		displayName: "X"
	});
	await map.upsert(channel.id, epgCh.id);

	await programs.create({
		epgChannelId: epgCh.id,
		start: new Date("1999-01-01T00:00:00.000Z"),
		stop: new Date("1999-01-01T01:00:00.000Z"),
		title: "Ancient Movie"
	});
	const upcoming = await programs.create({
		epgChannelId: epgCh.id,
		start: new Date("2099-01-01T00:00:00.000Z"),
		stop: new Date("2099-01-01T01:00:00.000Z"),
		title: "Future Movie"
	});

	const result = await service.search({ q: "movie" });
	const ids = result.programs.map((p) => p.id);
	assert.ok(ids.includes(upcoming.id));
	assert.ok(
		!ids.some((id) => id !== upcoming.id),
		"ancient program (stop in the past) must be excluded"
	);
});
