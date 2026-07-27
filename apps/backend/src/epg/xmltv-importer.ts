/**
 * XMLTV → Postgres importer.
 *
 * Streams an XMLTV document via the SAX parser into Postgres, batching
 * channels and programs through staging tables and a final
 * `INSERT … ON CONFLICT DO UPDATE` flush. Emits per-batch progress so
 * the {@link EpgService} can publish `epg.refresh` events on the WS bus.
 */

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { Pool, PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";

import { decodeStream } from "./xmltv-encoding";
import {
	parseXmltvStream,
	type XmltvChannel,
	type XmltvProgram
} from "./xmltv-parser";

export interface ImportProgress {
	channelsSeen: number;
	programsSeen: number;
	channelsUpserted: number;
	/** Programs inserted or changed during this refresh. */
	programsUpserted: number;
	/** Programs that did not previously exist. */
	programsInserted: number;
	/** Existing programs whose imported fields changed. */
	programsChanged: number;
	/** Existing programs skipped because every imported field matched. */
	programsUnchanged: number;
	programsPruned: number;
}

export interface ImportXmltvOptions {
	sourceId: string;
	pool: Pool;
	input: NodeJS.ReadableStream;
	/** Optional default zone for offsetless timestamps; e.g. "America/New_York". */
	defaultTimezone?: string;
	/** Channels per COPY batch. Defaults to 1000. */
	channelBatchSize?: number;
	/** Programs per COPY batch. Defaults to 1000. */
	programBatchSize?: number;
	/** Cutoff for pruning old programs; defaults to 24h before "now". */
	pruneOlderThan?: Date;
	/** Invoked after each batch flush so callers can publish progress. */
	onProgress?: (progress: ImportProgress) => void;
	/** Aborted via this signal aborts the import (rolls back transaction). */
	signal?: AbortSignal;
}

const DEFAULT_BATCH_SIZE = 1000;

/** Result summary for a single import run. */
export interface ImportResult extends ImportProgress {
	durationMs: number;
	/** Inclusive/exclusive bounds touched by programs in this import. */
	affectedFrom: string | null;
	affectedTo: string | null;
}

/**
 * Drives one import. Wraps the entire load in a single transaction so
 * partial failures never leave half-written data; staging tables are
 * `ON COMMIT DROP` so they vanish even on rollback.
 */
export async function importXmltv(
	options: ImportXmltvOptions
): Promise<ImportResult> {
	const startedAt = Date.now();
	const channelBatchSize = options.channelBatchSize ?? DEFAULT_BATCH_SIZE;
	const programBatchSize = options.programBatchSize ?? DEFAULT_BATCH_SIZE;

	const client = await options.pool.connect();
	const progress: ImportProgress = {
		channelsSeen: 0,
		programsSeen: 0,
		channelsUpserted: 0,
		programsUpserted: 0,
		programsInserted: 0,
		programsChanged: 0,
		programsUnchanged: 0,
		programsPruned: 0
	};

	const channelBatch: XmltvChannel[] = [];
	const programBatch: XmltvProgram[] = [];
	let affectedFromMs: number | null = null;
	let affectedToMs: number | null = null;
	let channelsBufferedDuringFlush = false;

	try {
		await client.query("BEGIN");
		// Serialize refreshes for one source so the pre-upsert classification and
		// PostgreSQL's affected-row count describe the same set of existing rows.
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[options.sourceId]
		);

		// Preserve feed order so duplicate keys can keep the last occurrence,
		// matching the result of applying the same rows as sequential upserts.
		await client.query(
			`CREATE TEMP TABLE epg_channels_staging (
         import_order bigint GENERATED ALWAYS AS IDENTITY,
         external_id text NOT NULL,
         display_name text NOT NULL,
         display_names text[] NOT NULL
       ) ON COMMIT DROP`
		);
		await client.query(
			`CREATE TEMP TABLE epg_programs_staging (
         import_order bigint GENERATED ALWAYS AS IDENTITY,
         external_id text NOT NULL,
         channel_external_id text NOT NULL,
         start timestamptz NOT NULL,
         stop timestamptz NOT NULL,
         title text NOT NULL,
         subtitle text,
         description text,
         episode integer,
         season integer,
         categories text[] NOT NULL
       ) ON COMMIT DROP`
		);

		let flushChannelsP: Promise<void> | null = null;
		let flushProgramsP: Promise<void> | null = null;

		/**
		 * Single-flight flush helpers. Detach the buffered rows from the
		 * mutable batch array (`splice`) so subsequent pushes from the same
		 * SAX chunk don't double-count or get re-copied. We also serialise
		 * concurrent flush attempts so two COPYs can't race over the same
		 * connection.
		 */
		const flushChannels = async (): Promise<void> => {
			while (flushChannelsP) {
				await flushChannelsP;
			}
			if (channelBatch.length === 0) return;
			const rows = channelBatch.splice(0);
			const p = copyChannels(client, rows).finally(() => {
				flushChannelsP = null;
			});
			flushChannelsP = p;
			await p;
		};
		const flushPrograms = async (): Promise<void> => {
			while (flushProgramsP) {
				await flushProgramsP;
			}
			if (programBatch.length === 0) return;
			const rows = programBatch.splice(0);
			const p = copyPrograms(client, rows).finally(() => {
				flushProgramsP = null;
			});
			flushProgramsP = p;
			await p;
		};

		const decoded = decodeStream(options.input);
		await parseXmltvStream(
			decoded,
			{
				async onChannel(channel) {
					if (options.signal?.aborted) {
						throw new Error("Import aborted");
					}
					progress.channelsSeen += 1;
					const displayNames =
						channel.displayNames.length > 0
							? channel.displayNames
							: [channel.externalId];
					channelBatch.push({
						externalId: channel.externalId,
						displayName: channel.displayName ?? channel.externalId,
						displayNames
					});
					channelsBufferedDuringFlush = true;
					if (channelBatch.length >= channelBatchSize) {
						await flushChannels();
						options.onProgress?.({ ...progress });
					}
				},
				async onProgram(program) {
					if (options.signal?.aborted) {
						throw new Error("Import aborted");
					}
					progress.programsSeen += 1;
					// Refresh consumers use these bounds to invalidate only overlapping
					// two-hour Guide partitions.
					const programStartMs = program.start.getTime();
					const programStopMs = program.stop.getTime();
					if (affectedFromMs === null || programStartMs < affectedFromMs) {
						affectedFromMs = programStartMs;
					}
					if (affectedToMs === null || programStopMs > affectedToMs) {
						affectedToMs = programStopMs;
					}
					programBatch.push(program);
					if (programBatch.length >= programBatchSize) {
						await flushPrograms();
						options.onProgress?.({ ...progress });
					}
				}
			},
			options.defaultTimezone !== undefined
				? { defaultTimezone: options.defaultTimezone }
				: {}
		);

		await flushChannels();
		await flushPrograms();
		void channelsBufferedDuringFlush;

		// Deduplicate each statement so repeated feed rows do not make Postgres
		// update the same conflict target twice. Channels still run first for FKs.
		const channelsRes = await client.query(
			`INSERT INTO epg_channels (
         id, source_id, external_id, display_name, display_names
       )
         SELECT
           gen_random_uuid(), $1::uuid, external_id, display_name, display_names
           FROM (
             SELECT DISTINCT ON (external_id)
                    external_id, display_name, display_names
               FROM epg_channels_staging
              ORDER BY external_id, import_order DESC
           ) deduplicated_channels
       ON CONFLICT (source_id, external_id) DO UPDATE
         SET
           display_name = EXCLUDED.display_name,
           display_names = EXCLUDED.display_names`,
			[options.sourceId]
		);
		progress.channelsUpserted = channelsRes.rowCount ?? 0;

		// Materialize the deduplicated, channel-resolved feed once. The temporary
		// table avoids repeating the DISTINCT sort when classifying and upserting.
		await client.query(
			`CREATE TEMP TABLE epg_programs_import ON COMMIT DROP AS
       SELECT
         gen_random_uuid() AS id,
         c.id AS epg_channel_id,
         s.external_id,
         s.start,
         s.stop,
         s.title,
         s.subtitle,
         s.description,
         s.episode,
         s.season,
         s.categories
       FROM (
         SELECT DISTINCT ON (channel_external_id, external_id, start)
                external_id,
                channel_external_id,
                start,
                stop,
                title,
                subtitle,
                description,
                episode,
                season,
                categories
           FROM epg_programs_staging
          ORDER BY
                channel_external_id,
                external_id,
                start,
                import_order DESC
       ) s
       JOIN epg_channels c
         ON c.source_id = $1::uuid
        AND c.external_id = s.channel_external_id`,
			[options.sourceId]
		);

		const classificationRes = await client.query<{
			total: number;
			inserted: number;
		}>(
			`SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE existing.id IS NULL)::int AS inserted
       FROM epg_programs_import imported
       LEFT JOIN epg_programs existing
         ON existing.epg_channel_id = imported.epg_channel_id
        AND existing.external_id = imported.external_id
        AND existing.start = imported.start`
		);
		const classifiedPrograms = classificationRes.rows[0] ?? {
			total: 0,
			inserted: 0
		};

		const programsRes = await client.query(
			`INSERT INTO epg_programs (
         id, epg_channel_id, external_id, start, stop, title, subtitle,
         description, episode, season, categories
       )
       SELECT
         id, epg_channel_id, external_id, start, stop, title, subtitle,
         description, episode, season, categories
       FROM epg_programs_import
       ON CONFLICT (epg_channel_id, external_id, start)
         WHERE external_id IS NOT NULL
         DO UPDATE SET
           stop = EXCLUDED.stop,
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           description = EXCLUDED.description,
           episode = EXCLUDED.episode,
           season = EXCLUDED.season,
           categories = EXCLUDED.categories
		 WHERE (epg_programs.stop, epg_programs.title, epg_programs.subtitle,
		        epg_programs.description, epg_programs.episode,
		        epg_programs.season, epg_programs.categories)
		       IS DISTINCT FROM
		       (EXCLUDED.stop, EXCLUDED.title, EXCLUDED.subtitle,
		        EXCLUDED.description, EXCLUDED.episode,
		        EXCLUDED.season, EXCLUDED.categories)`
		);
		const affectedPrograms = programsRes.rowCount ?? 0;
		progress.programsUpserted = affectedPrograms;
		progress.programsInserted = classifiedPrograms.inserted;
		progress.programsChanged = affectedPrograms - classifiedPrograms.inserted;
		progress.programsUnchanged = classifiedPrograms.total - affectedPrograms;

		const cutoff =
			options.pruneOlderThan ?? new Date(Date.now() - 24 * 3600 * 1000);
		const pruneRes = await client.query(
			`DELETE FROM epg_programs
         WHERE epg_channel_id IN (
           SELECT id FROM epg_channels WHERE source_id = $1::uuid
         )
           AND stop < $2::timestamptz`,
			[options.sourceId, cutoff]
		);
		progress.programsPruned = pruneRes.rowCount ?? 0;

		await client.query("COMMIT");
		options.onProgress?.({ ...progress });
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			/* ignore */
		}
		throw error;
	} finally {
		client.release();
	}

	return {
		...progress,
		durationMs: Date.now() - startedAt,
		affectedFrom:
			affectedFromMs === null ? null : new Date(affectedFromMs).toISOString(),
		affectedTo:
			affectedToMs === null ? null : new Date(affectedToMs).toISOString()
	};
}

async function copyChannels(
	client: PoolClient,
	rows: XmltvChannel[]
): Promise<void> {
	const stream = client.query(
		copyFrom(
			`COPY epg_channels_staging (
         external_id, display_name, display_names
       ) FROM STDIN WITH (FORMAT text)`
		)
	);
	const source = Readable.from(serializeChannels(rows));
	await pipelineToCopy(source, stream);
}

async function copyPrograms(
	client: PoolClient,
	rows: XmltvProgram[]
): Promise<void> {
	const stream = client.query(
		copyFrom(
			`COPY epg_programs_staging (
         external_id, channel_external_id, start, stop, title, subtitle,
         description, episode, season, categories
       ) FROM STDIN WITH (FORMAT text)`
		)
	);
	const source = Readable.from(serializePrograms(rows));
	await pipelineToCopy(source, stream);
}

function pipelineToCopy(
	source: Readable,
	copy: NodeJS.WritableStream
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let done = false;
		const finish = (err?: unknown): void => {
			if (done) return;
			done = true;
			if (err) reject(err as Error);
			else resolve();
		};
		copy.on("finish", () => finish());
		copy.on("error", (err) => finish(err));
		source.on("error", (err) => finish(err));
		source.pipe(copy);
	});
}

/** Yields one COPY-text row per channel, terminated with `\n`. */
function* serializeChannels(rows: XmltvChannel[]): Generator<string> {
	for (const row of rows) {
		const displayName = row.displayName ?? row.externalId;
		const displayNames =
			row.displayNames.length > 0 ? row.displayNames : [displayName];
		const columns = [
			escapeCopyText(row.externalId),
			escapeCopyText(displayName),
			escapeCopyText(serializeTextArray(displayNames))
		];
		yield `${columns.join("\t")}\n`;
	}
}

function* serializePrograms(rows: XmltvProgram[]): Generator<string> {
	for (const row of rows) {
		const cols = [
			escapeCopyText(row.externalId),
			escapeCopyText(row.channelExternalId),
			row.start.toISOString(),
			row.stop.toISOString(),
			escapeCopyText(row.title),
			row.subtitle === null ? "\\N" : escapeCopyText(row.subtitle),
			row.description === null ? "\\N" : escapeCopyText(row.description),
			row.episode === null ? "\\N" : String(row.episode),
			row.season === null ? "\\N" : String(row.season),
			escapeCopyText(serializeTextArray(row.categories))
		];
		yield `${cols.join("\t")}\n`;
	}
}

/** Escape a string for COPY text format. */
function escapeCopyText(value: string): string {
	// Order matters: backslash first.
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const ch = value.charCodeAt(i);
		if (ch === 0x5c) {
			out += "\\\\";
		} else if (ch === 0x09) {
			out += "\\t";
		} else if (ch === 0x0a) {
			out += "\\n";
		} else if (ch === 0x0d) {
			out += "\\r";
		} else if (ch === 0x00) {
			// Null bytes are illegal in text columns.
			continue;
		} else {
			out += value[i];
		}
	}
	return out;
}

/** Render a string array in Postgres array literal syntax. */
function serializeTextArray(values: string[]): string {
	if (values.length === 0) return "{}";
	const escaped = values.map((value) => {
		const inner = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${inner}"`;
	});
	return `{${escaped.join(",")}}`;
}

/** Generate a fresh UUID. Exported so callers/tests can use the same pool. */
export function newId(): string {
	return randomUUID();
}
