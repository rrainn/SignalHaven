import { sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";

/**
 * Global search repository (rrainn/SignalHaven#U10-search).
 *
 * Three independent queries — channels (trigram + number prefix),
 * upcoming EPG programs (Postgres FTS via `websearch_to_tsquery` /
 * `ts_rank_cd` against the `epg_programs.search_tsv` GIN index), and
 * recordings (joined to their EPG program when available, falling back
 * to ILIKE on the recording's own title for un-linked rows).
 *
 * Every user-supplied value is passed through drizzle's `sql\`...\``
 * tag so it lands as a bound parameter (`$1`, `$2`, …); no string
 * concatenation, so `q` cannot inject SQL or break `to_tsquery`'s
 * fragile syntax (`websearch_to_tsquery` itself never raises a syntax
 * error for free-form input).
 */
export class SearchRepository {
	constructor(private readonly database: DatabaseClient) {}

	/**
	 * Channels matched by trigram similarity on `name` plus a prefix
	 * match on `number`. The `0.1` similarity floor is the default
	 * `pg_trgm` threshold and rejects unrelated noise without losing
	 * fuzzy / partial-word matches. Number-prefix hits are returned with
	 * a synthetic high score so a user typing `12.` always sees `12.x`
	 * channels first.
	 */
	async searchChannels(q: string, limit: number): Promise<ChannelSearchRow[]> {
		const result = await this.database.execute<ChannelSearchRow>(sql`
      SELECT
		lc.id,
		lc.number,
		lc.name,
		lc.logo_url AS "logoUrl",
        GREATEST(
		  similarity(lc.name, ${q}),
		  CASE WHEN lc.number LIKE ${q + "%"} THEN 1.0 ELSE 0 END
		) AS score
	  FROM logical_channels lc
      WHERE lc.enabled = true
        AND EXISTS (
          SELECT 1
          FROM channels source
		  WHERE source.logical_channel_id = lc.id
            AND source.enabled = true
            AND source.source_status <> 'unavailable'
        )
        AND (
		  lc.name % ${q}
		  OR lc.number LIKE ${q + "%"}
		)
      ORDER BY score DESC, lc.name ASC
      LIMIT ${limit}
    `);
		return [...result.rows];
	}

	/**
	 * Upcoming EPG programs ranked by `ts_rank_cd` against
	 * `search_tsv`. Joins through `logical_channel_epg_map` so every row carries
	 * an enabled, stable channel identity that the details endpoint can resolve.
	 * Unmapped guide data stays out of search because presenting it as a
	 * clickable result would lead to a guaranteed not-found page.
	 */
	async searchPrograms(
		q: string,
		limit: number,
		nowUtc: Date
	): Promise<ProgramSearchRow[]> {
		const result = await this.database.execute<ProgramSearchRow>(sql`
      WITH q AS (
        SELECT websearch_to_tsquery('english', ${q}) AS tsq
      )
      SELECT
        p.id,
        p.title,
        p.subtitle,
        p.start,
        p.stop,
        c.id AS "channelId",
        c.name AS "channelName",
        c.number AS "channelNumber",
        ts_rank_cd(p.search_tsv, q.tsq) AS score
      FROM epg_programs p
      CROSS JOIN q
	  JOIN logical_channel_epg_map m ON m.epg_channel_id = p.epg_channel_id
	  JOIN logical_channels c ON c.id = m.logical_channel_id
      WHERE p.search_tsv @@ q.tsq
        AND p.stop >= ${nowUtc}
		AND c.enabled = true
      ORDER BY score DESC, p.start ASC
      LIMIT ${limit}
    `);
		return [...result.rows];
	}

	/**
	 * Recordings matched by FTS through the linked EPG program where
	 * one exists, falling back to `ILIKE` on the recording's own
	 * `title` for rows without a program (manual one-offs). The two
	 * branches are unioned and re-ranked together so the per-group cap
	 * yields a sensible mix.
	 */
	async searchRecordings(
		q: string,
		limit: number,
		userId = "00000000-0000-4000-8000-000000000001"
	): Promise<RecordingSearchRow[]> {
		// `LIKE`-style wildcard fallback for unlinked rows. We escape `%`,
		// `_`, and `\` so pasted SQL wildcards in the query don't change
		// the match semantics.
		const ilikeNeedle = "%" + escapeLike(q) + "%";
		const result = await this.database.execute<RecordingSearchRow>(sql`
      WITH q AS (
        SELECT websearch_to_tsquery('english', ${q}) AS tsq
      ),
      hits AS (
        SELECT
          r.id,
          r.title,
          r.status,
          r.scheduled_start AS "scheduledStart",
          r.channel_id AS "channelId",
          r.program_id AS "programId",
          ts_rank_cd(p.search_tsv, q.tsq) AS score
        FROM recordings r
        JOIN epg_programs p ON p.id = r.program_id
        CROSS JOIN q
		WHERE p.search_tsv @@ q.tsq
		  AND r.user_id = ${userId}
        UNION ALL
        SELECT
          r.id,
          r.title,
          r.status,
          r.scheduled_start AS "scheduledStart",
          r.channel_id AS "channelId",
          r.program_id AS "programId",
          0.05::real AS score
        FROM recordings r
        WHERE r.program_id IS NULL
		  AND r.user_id = ${userId}
          AND r.title ILIKE ${ilikeNeedle} ESCAPE '\\'
      )
      SELECT
        h.id,
        h.title,
        h.status,
        h."scheduledStart",
        h."channelId",
        h."programId",
        c.name AS "channelName",
        c.number AS "channelNumber",
        h.score
      FROM hits h
	  LEFT JOIN logical_channels c ON c.id = h."channelId"
      ORDER BY h.score DESC, h."scheduledStart" DESC
      LIMIT ${limit}
    `);
		return [...result.rows];
	}
}

/** Escape `%`, `_`, and `\` so user input stays a literal in `ILIKE`. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => "\\" + c);
}

export type ChannelSearchRow = {
	id: string;
	number: string;
	name: string;
	logoUrl: string | null;
	score: number;
};

export type ProgramSearchRow = {
	id: string;
	title: string;
	subtitle: string | null;
	start: Date;
	stop: Date;
	channelId: string | null;
	channelName: string | null;
	channelNumber: string | null;
	score: number;
};

export type RecordingSearchRow = {
	id: string;
	title: string;
	status: string;
	scheduledStart: Date;
	channelId: string;
	channelName: string | null;
	channelNumber: string | null;
	programId: string | null;
	score: number;
};
