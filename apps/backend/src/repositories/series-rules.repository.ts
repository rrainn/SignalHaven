import { and, asc, count, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import type { EpisodePolicy } from "@signalhaven/shared";
import { BOOTSTRAP_ADMIN_USER_ID, seriesRules } from "../db/schema";

export type CreateSeriesRuleInput = {
	/** Route-created rules always provide an account owner. */
	userId?: string;
	title: string;
	channelId?: string | null;
	epgChannelId?: string | null;
	keepCount: number;
	episodePolicy?: EpisodePolicy;
	newOnly?: boolean;
	priority: number;
	retentionDays?: number | null;
};

export type UpdateSeriesRuleInput = Partial<{
	title: string;
	channelId: string | null;
	epgChannelId: string | null;
	keepCount: number;
	newOnly: boolean;
	episodePolicy: EpisodePolicy;
	priority: number;
	retentionDays: number | null;
}>;

export type SeriesRuleRecord = {
	id: string;
	userId?: string;
	title: string;
	channelId: string | null;
	epgChannelId: string | null;
	keepCount: number;
	newOnly: boolean;
	episodePolicy: EpisodePolicy;
	priority: number;
	retentionDays: number | null;
	createdAt: Date;
	updatedAt: Date;
};

export const MAX_SERIES_RULES_PER_USER = 128;

export class SeriesRuleLimitError extends Error {
	readonly code = "series_rule_limit";

	constructor() {
		super("Too many series rules already exist for this account");
		this.name = "SeriesRuleLimitError";
	}
}

function toRecord(row: typeof seriesRules.$inferSelect): SeriesRuleRecord {
	return {
		id: row.id,
		userId: row.userId,
		title: row.title,
		channelId: row.channelId ?? null,
		epgChannelId: row.epgChannelId ?? null,
		keepCount: row.keepCount,
		newOnly: row.newOnly,
		episodePolicy: row.episodePolicy as EpisodePolicy,
		priority: row.priority,
		retentionDays: row.retentionDays ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export class SeriesRulesRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateSeriesRuleInput): Promise<SeriesRuleRecord> {
		const now = new Date();
		const userId = input.userId ?? BOOTSTRAP_ADMIN_USER_ID;
		const episodePolicy =
			input.episodePolicy ?? (input.newOnly ? "confirmed_new" : "all");
		const created = await this.database.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 3))`
			);
			const [usage] = await tx
				.select({ value: count() })
				.from(seriesRules)
				.where(eq(seriesRules.userId, userId));
			if (Number(usage?.value ?? 0) >= MAX_SERIES_RULES_PER_USER) {
				throw new SeriesRuleLimitError();
			}
			const [row] = await tx
				.insert(seriesRules)
				.values({
					id: randomUUID(),
					userId,
					title: input.title,
					channelId: input.channelId ?? null,
					epgChannelId: input.epgChannelId ?? null,
					keepCount: input.keepCount,
					newOnly: episodePolicy !== "all",
					episodePolicy,
					priority: input.priority,
					retentionDays: input.retentionDays ?? null,
					createdAt: now,
					updatedAt: now
				})
				.returning();
			return row;
		});

		if (!created) {
			throw new Error("Failed to create series rule record");
		}

		return toRecord(created);
	}

	async getById(id: string): Promise<SeriesRuleRecord | null> {
		const [record] = await this.database
			.select()
			.from(seriesRules)
			.where(eq(seriesRules.id, id))
			.limit(1);

		return record ? toRecord(record) : null;
	}

	async getByIdForUser(
		id: string,
		userId: string
	): Promise<SeriesRuleRecord | null> {
		const [record] = await this.database
			.select()
			.from(seriesRules)
			.where(and(eq(seriesRules.id, id), eq(seriesRules.userId, userId)))
			.limit(1);
		return record ? toRecord(record) : null;
	}

	async list(): Promise<SeriesRuleRecord[]> {
		const rows = await this.database
			.select()
			.from(seriesRules)
			.orderBy(asc(seriesRules.title));
		return rows.map(toRecord);
	}

	async listForUser(userId: string): Promise<SeriesRuleRecord[]> {
		const rows = await this.database
			.select()
			.from(seriesRules)
			.where(eq(seriesRules.userId, userId))
			.orderBy(asc(seriesRules.title));
		return rows.map(toRecord);
	}

	async update(
		id: string,
		patch: UpdateSeriesRuleInput
	): Promise<SeriesRuleRecord | null> {
		const normalizedPatch = { ...patch };
		if (patch.episodePolicy) {
			normalizedPatch.newOnly = patch.episodePolicy !== "all";
		} else if (patch.newOnly !== undefined) {
			normalizedPatch.episodePolicy = patch.newOnly ? "confirmed_new" : "all";
		}
		const [updated] = await this.database
			.update(seriesRules)
			.set({ ...normalizedPatch, updatedAt: new Date() })
			.where(eq(seriesRules.id, id))
			.returning();

		return updated ? toRecord(updated) : null;
	}

	async updateForUser(
		id: string,
		userId: string,
		patch: UpdateSeriesRuleInput
	): Promise<SeriesRuleRecord | null> {
		const normalizedPatch = { ...patch };
		if (patch.episodePolicy) {
			normalizedPatch.newOnly = patch.episodePolicy !== "all";
		} else if (patch.newOnly !== undefined) {
			normalizedPatch.episodePolicy = patch.newOnly ? "confirmed_new" : "all";
		}
		const [updated] = await this.database
			.update(seriesRules)
			.set({ ...normalizedPatch, updatedAt: new Date() })
			.where(and(eq(seriesRules.id, id), eq(seriesRules.userId, userId)))
			.returning();
		return updated ? toRecord(updated) : null;
	}

	async delete(id: string): Promise<boolean> {
		const deleted = await this.database
			.delete(seriesRules)
			.where(eq(seriesRules.id, id))
			.returning({ id: seriesRules.id });
		return deleted.length > 0;
	}

	async deleteForUser(id: string, userId: string): Promise<boolean> {
		const deleted = await this.database
			.delete(seriesRules)
			.where(and(eq(seriesRules.id, id), eq(seriesRules.userId, userId)))
			.returning({ id: seriesRules.id });
		return deleted.length > 0;
	}
}
