import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { channels } from "../db/schema";

export type CreateChannelInput = {
	tunerId: string;
	number: string;
	providerChannelId?: string | null;
	name: string;
	logoUrl?: string;
	tvgId?: string | null;
	enabled: boolean;
	sortOrder: number;
};

export type ChannelRecord = typeof channels.$inferSelect;

/** Channel fields needed to render one Guide row. */
export interface GuideChannelRecord {
	id: string;
	number: string;
	name: string;
	logoUrl: string | null;
	sortOrder: number;
}

export class ChannelsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateChannelInput) {
		const [created] = await this.database
			.insert(channels)
			.values({
				id: randomUUID(),
				tunerId: input.tunerId,
				number: input.number,
				providerChannelId: input.providerChannelId ?? null,
				name: input.name,
				logoUrl: input.logoUrl,
				tvgId: input.tvgId ?? null,
				enabled: input.enabled,
				sortOrder: input.sortOrder
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create channel record");
		}

		return created;
	}

	async getById(id: string) {
		const [record] = await this.database
			.select()
			.from(channels)
			.where(eq(channels.id, id))
			.limit(1);

		return record ?? null;
	}

	/** All persisted channels. Used by the EPG matcher to walk every row. */
	async list(): Promise<ChannelRecord[]> {
		return this.database.select().from(channels);
	}

	/**
	 * Enabled channels projected to the fields used by the Guide.
	 *
	 * Filtering and ordering in PostgreSQL keeps the cached snapshot compact and
	 * avoids repeating stable lineup work for every requested time window.
	 */
	async listEnabledForGrid(): Promise<GuideChannelRecord[]> {
		return this.database
			.select({
				id: channels.id,
				number: channels.number,
				name: channels.name,
				logoUrl: channels.logoUrl,
				sortOrder: channels.sortOrder
			})
			.from(channels)
			.where(eq(channels.enabled, true))
			.orderBy(asc(channels.sortOrder));
	}

	/** All persisted channels belonging to a single tuner. */
	async listByTunerId(tunerId: string): Promise<ChannelRecord[]> {
		return this.database
			.select()
			.from(channels)
			.where(eq(channels.tunerId, tunerId));
	}

	/**
	 * Patch a channel's mutable display fields (name and/or logo URL).
	 * Returns the updated record, or `null` if no row matched.
	 */
	async update(
		id: string,
		patch: {
			number?: string;
			providerChannelId?: string | null;
			name?: string;
			logoUrl?: string | null;
			tvgId?: string | null;
			sortOrder?: number;
			lineupMissingCount?: number;
		}
	): Promise<ChannelRecord | null> {
		const values: Partial<typeof channels.$inferInsert> = {};
		if (patch.number !== undefined) values.number = patch.number;
		if (patch.providerChannelId !== undefined) {
			values.providerChannelId = patch.providerChannelId;
		}
		if (patch.name !== undefined) values.name = patch.name;
		// Passing null intentionally removes a logo that disappeared upstream.
		if (patch.logoUrl !== undefined) values.logoUrl = patch.logoUrl;
		if (patch.tvgId !== undefined) values.tvgId = patch.tvgId;
		if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
		if (patch.lineupMissingCount !== undefined) {
			values.lineupMissingCount = patch.lineupMissingCount;
		}

		if (Object.keys(values).length === 0) return null;

		const [updated] = await this.database
			.update(channels)
			.set(values)
			.where(eq(channels.id, id))
			.returning();

		return updated ?? null;
	}

	/** Remove a channel by its UUID. No-ops when the row does not exist. */
	async deleteById(id: string): Promise<void> {
		await this.database.delete(channels).where(eq(channels.id, id));
	}
}
