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
import { importXmltv } from "../src/epg/xmltv-importer";
import { EventBus, type PublishedEvent } from "../src/events/event-bus";
import { EpgSourcesRepository } from "../src/repositories/epg-sources.repository";

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

const SMALL_XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="c1"><display-name>Channel One</display-name></channel>
  <channel id="c2"><display-name>Channel Two</display-name></channel>
  <programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">
    <title>Program A</title><desc>First</desc><category>News</category>
  </programme>
  <programme channel="c1" start="20260101130000 +0000" stop="20260101140000 +0000">
    <title>Program B</title>
  </programme>
  <programme channel="c2" start="20260101140000 +0000" stop="20260101150000 +0000">
    <title>Program C</title><sub-title>Pilot</sub-title>
  </programme>
</tv>`;

async function createSource() {
	const repo = new EpgSourcesRepository(db);
	return repo.create({
		kind: "xmltv",
		name: "Test",
		url: "memory://fixture"
	});
}

test("importXmltv populates channels and programs idempotently", async () => {
	const source = await createSource();
	// Pin pruneOlderThan to a date before the fixture so the prune step
	// doesn't silently delete what we just inserted (the fixture programs
	// are dated 2026-01-01 and the test clock might already be past that).
	const noPrune = new Date("2000-01-01T00:00:00Z");
	const result1 = await importXmltv({
		sourceId: source.id,
		pool,
		input: Readable.from([Buffer.from(SMALL_XMLTV, "utf8")]),
		pruneOlderThan: noPrune
	});
	assert.equal(result1.channelsSeen, 2);
	assert.equal(result1.programsSeen, 3);
	assert.equal(result1.channelsUpserted, 2);
	assert.equal(result1.programsUpserted, 3);
	assert.equal(result1.programsInserted, 3);
	assert.equal(result1.programsChanged, 0);
	assert.equal(result1.programsUnchanged, 0);

	const channelCount = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM epg_channels WHERE source_id = $1",
		[source.id]
	);
	assert.equal(channelCount.rows[0]?.count, 2);
	const programCount = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM epg_programs"
	);
	assert.equal(programCount.rows[0]?.count, 3);
	const tuplesBeforeRefresh = await pool.query<{
		id: string;
		xmin: string;
	}>("SELECT id, xmin::text AS xmin FROM epg_programs ORDER BY id");

	// Re-import: unchanged rows keep their tuple versions and indexes untouched.
	const result2 = await importXmltv({
		sourceId: source.id,
		pool,
		input: Readable.from([Buffer.from(SMALL_XMLTV, "utf8")]),
		pruneOlderThan: noPrune
	});
	assert.equal(result2.channelsUpserted, 2);
	assert.equal(result2.programsUpserted, 0);
	assert.equal(result2.programsInserted, 0);
	assert.equal(result2.programsChanged, 0);
	assert.equal(result2.programsUnchanged, 3);

	const programAfter = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM epg_programs"
	);
	assert.equal(programAfter.rows[0]?.count, 3);
	const tuplesAfterRefresh = await pool.query<{
		id: string;
		xmin: string;
	}>("SELECT id, xmin::text AS xmin FROM epg_programs ORDER BY id");
	assert.deepEqual(tuplesAfterRefresh.rows, tuplesBeforeRefresh.rows);

	const changedFeed = SMALL_XMLTV.replace("Program B", "Program B Updated");
	const result3 = await importXmltv({
		sourceId: source.id,
		pool,
		input: Readable.from([Buffer.from(changedFeed, "utf8")]),
		pruneOlderThan: noPrune
	});
	assert.equal(result3.programsUpserted, 1);
	assert.equal(result3.programsInserted, 0);
	assert.equal(result3.programsChanged, 1);
	assert.equal(result3.programsUnchanged, 2);
});

test("importXmltv prunes programs whose stop is older than the cutoff", async () => {
	const source = await createSource();
	await importXmltv({
		sourceId: source.id,
		pool,
		input: Readable.from([Buffer.from(SMALL_XMLTV, "utf8")]),
		// All fixture programs end on 2026-01-01; cutoff "now" is well past.
		pruneOlderThan: new Date("2030-01-01T00:00:00Z")
	});
	const programCount = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM epg_programs"
	);
	assert.equal(programCount.rows[0]?.count, 0);
});

test("EpgService.refresh publishes start/progress/completed events", async () => {
	const source = await createSource();
	const bus = new EventBus();
	const events: PublishedEvent[] = [];
	bus.subscribe("epg", (event) => events.push(event));

	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		bus,
		openInput: async () => Readable.from([Buffer.from(SMALL_XMLTV, "utf8")])
	});

	const result = await service.refresh(source.id);
	assert.equal(result.programsUpserted, 3);
	assert.equal(result.affectedFrom, "2026-01-01T12:00:00.000Z");
	assert.equal(result.affectedTo, "2026-01-01T15:00:00.000Z");

	const refreshEvents = events.filter((e) => e.event === "epg.refresh");
	const phases = refreshEvents.map((e) => (e.data as { phase: string }).phase);
	assert.ok(phases.includes("started"));
	assert.ok(phases.includes("completed"));
	const completed = refreshEvents.find(
		(event) => (event.data as { phase: string }).phase === "completed"
	);
	assert.equal(
		(completed?.data as { affectedFrom?: string }).affectedFrom,
		result.affectedFrom
	);

	const reloaded = await service.getById(source.id);
	assert.equal(reloaded.lastRefreshStatus, "ok");
	assert.equal(reloaded.lastRefreshError, null);
});

test("EpgService.refresh records errors and rethrows on import failure", async () => {
	const source = await createSource();
	const bus = new EventBus();
	const events: PublishedEvent[] = [];
	bus.subscribe("epg", (event) => events.push(event));

	const service = new EpgService({
		repository: new EpgSourcesRepository(db),
		pool,
		bus,
		openInput: async () => {
			throw new Error("boom");
		}
	});

	await assert.rejects(service.refresh(source.id), /boom/);
	const reloaded = await service.getById(source.id);
	assert.equal(reloaded.lastRefreshStatus, "error");
	assert.equal(reloaded.lastRefreshError, "boom");
	const failed = events.find(
		(e) =>
			e.event === "epg.refresh" &&
			(e.data as { phase: string }).phase === "failed"
	);
	assert.ok(failed);
});

test("importXmltv handles a 50MB synthetic XMLTV in under 30s", async (t) => {
	// Opt-in: this is a heavy benchmark that needs a beefier Postgres
	// (testcontainers default settings can hit `idle_in_transaction_session_timeout`).
	if (!process.env["SIGNALHAVEN_RUN_PERF"]) {
		t.skip("set SIGNALHAVEN_RUN_PERF=1 to run");
		return;
	}
	const source = await createSource();
	const stream = synthesizeXmltvStream(50 * 1024 * 1024);
	const start = Date.now();
	const result = await importXmltv({
		sourceId: source.id,
		pool,
		input: stream
	});
	const elapsed = Date.now() - start;
	// Sanity: we generated thousands of programs.
	assert.ok(result.programsUpserted > 1000);
	assert.ok(elapsed < 30_000, `Import took ${elapsed}ms, expected < 30000ms`);
});

/**
 * Generate roughly `targetBytes` of XMLTV as a Readable stream without
 * holding the whole document in memory. Produces a fixed number of
 * channels and a chronologically increasing series of programs.
 */
function synthesizeXmltvStream(targetBytes: number): Readable {
	const header =
		`<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n` +
		Array.from({ length: 50 })
			.map(
				(_, i) =>
					`  <channel id="c${i}"><display-name>Channel ${i}</display-name></channel>\n`
			)
			.join("");
	const footer = "</tv>\n";

	let bytesEmitted = header.length;
	let i = 0;
	const baseStart = Date.UTC(2026, 0, 1, 0, 0, 0);

	return new Readable({
		read() {
			if (bytesEmitted === header.length) {
				this.push(header);
			}
			// Push ~64KB per pull until we've hit the target.
			let chunk = "";
			while (
				chunk.length < 64 * 1024 &&
				bytesEmitted + chunk.length < targetBytes
			) {
				const channelIdx = i % 50;
				const startMs = baseStart + i * 30 * 60 * 1000;
				const stopMs = startMs + 30 * 60 * 1000;
				const startStr = formatXmltvTime(new Date(startMs));
				const stopStr = formatXmltvTime(new Date(stopMs));
				chunk +=
					`<programme channel="c${channelIdx}" start="${startStr}" stop="${stopStr}">` +
					`<title>Program ${i}</title>` +
					`<desc>Synthesised programme number ${i} with some longer text to bulk up bytes.</desc>` +
					`<category>Synthetic</category>` +
					`</programme>\n`;
				i += 1;
			}
			if (chunk.length > 0) {
				bytesEmitted += chunk.length;
				this.push(chunk);
			}
			if (bytesEmitted >= targetBytes) {
				this.push(footer);
				this.push(null);
			}
		}
	});
}

function formatXmltvTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
		" +0000"
	);
}
