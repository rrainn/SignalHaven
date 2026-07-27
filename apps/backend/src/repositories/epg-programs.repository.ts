import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { epgPrograms } from "../db/schema";

export type EpgProgramRecord = typeof epgPrograms.$inferSelect;

/** Program fields needed to render a Guide cell. */
export interface GuideEpgProgramRecord {
	id: string;
	epgChannelId: string;
	start: Date;
	stop: Date;
	title: string;
	subtitle: string | null;
}

export type CreateEpgProgramInput = {
	epgChannelId: string;
	start: Date;
	stop: Date;
	title: string;
	subtitle?: string;
	description?: string;
	episode?: number;
	season?: number;
	categories?: string[];
};

export class EpgProgramsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateEpgProgramInput) {
		const [created] = await this.database
			.insert(epgPrograms)
			.values({
				id: randomUUID(),
				epgChannelId: input.epgChannelId,
				start: input.start,
				stop: input.stop,
				title: input.title,
				subtitle: input.subtitle,
				description: input.description,
				episode: input.episode,
				season: input.season,
				categories: input.categories
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create EPG program record");
		}

		return created;
	}

	async getById(id: string) {
		const [record] = await this.database
			.select()
			.from(epgPrograms)
			.where(eq(epgPrograms.id, id))
			.limit(1);

		return record ?? null;
	}

	/**
	 * Load a bounded set of programs in one query so recordings list pages can
	 * attach artwork and episode metadata without an N+1 lookup pattern.
	 */
	async listByIds(ids: string[]): Promise<EpgProgramRecord[]> {
		if (ids.length === 0) {
			return [];
		}
		return this.database
			.select()
			.from(epgPrograms)
			.where(inArray(epgPrograms.id, ids));
	}

	/**
	 * Find upcoming programs (start >= `after`) whose title matches the
	 * given literal case-insensitively. Optionally restricted to a single
	 * `epgChannelId`; otherwise spans every EPG channel. Used by the
	 * series-rule evaluator to discover candidate episodes to record.
	 *
	 * Uses `lower(title) = lower($1)` rather than `ilike` so titles
	 * containing `%` / `_` are matched literally.
	 */
	async findUpcomingByTitle(input: {
		title: string;
		epgChannelId?: string;
		after: Date;
	}): Promise<EpgProgramRecord[]> {
		const conditions = [
			sql`lower(${epgPrograms.title}) = lower(${input.title})`,
			gte(epgPrograms.start, input.after)
		];
		if (input.epgChannelId) {
			conditions.push(eq(epgPrograms.epgChannelId, input.epgChannelId));
		}
		return this.database
			.select()
			.from(epgPrograms)
			.where(and(...conditions))
			.orderBy(asc(epgPrograms.start));
	}

	/**
	 * Detect whether the given program is a re-run: returns true when
	 * another EPG program with the same title and (when both are set)
	 * the same season + episode aired strictly earlier. Used to honour
	 * the "new episodes only" series-rule flag.
	 *
	 * Uses an existence query rather than a count for index-friendliness;
	 * title comparison is case-insensitive and literal (no wildcards).
	 */
	async hasPriorAiring(program: EpgProgramRecord): Promise<boolean> {
		const conditions = [
			sql`lower(${epgPrograms.title}) = lower(${program.title})`,
			lt(epgPrograms.start, program.start),
			ne(epgPrograms.id, program.id)
		];
		if (program.season !== null && program.episode !== null) {
			conditions.push(eq(epgPrograms.season, program.season));
			conditions.push(eq(epgPrograms.episode, program.episode));
		}
		const [hit] = await this.database
			.select({ id: epgPrograms.id })
			.from(epgPrograms)
			.where(and(...conditions))
			.limit(1);
		return hit !== undefined;
	}

	/**
	 * All programs whose `[start, stop)` interval intersects the given
	 * `[from, to)` window, restricted to the supplied EPG channel IDs.
	 * Programs that start before `to` AND stop after `from` are included,
	 * meaning a program that straddles a boundary is still returned.
	 *
	 * Returns an empty array immediately when `epgChannelIds` is empty.
	 */
	async listInWindow(
		epgChannelIds: string[],
		from: Date,
		to: Date
	): Promise<GuideEpgProgramRecord[]> {
		if (epgChannelIds.length === 0) {
			return [];
		}
		return this.database
			.select({
				id: epgPrograms.id,
				epgChannelId: epgPrograms.epgChannelId,
				start: epgPrograms.start,
				stop: epgPrograms.stop,
				title: epgPrograms.title,
				subtitle: epgPrograms.subtitle
			})
			.from(epgPrograms)
			.where(
				and(
					inArray(epgPrograms.epgChannelId, epgChannelIds),
					lt(epgPrograms.start, to),
					gte(epgPrograms.stop, from)
				)
			)
			.orderBy(asc(epgPrograms.start));
	}
}
