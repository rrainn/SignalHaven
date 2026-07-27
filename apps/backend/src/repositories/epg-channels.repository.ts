import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { epgChannels } from "../db/schema";

export type CreateEpgChannelInput = {
	sourceId: string;
	externalId: string;
	displayName: string;
	displayNames?: string[];
};

export type EpgChannelRecord = typeof epgChannels.$inferSelect;

export class EpgChannelsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateEpgChannelInput) {
		const [created] = await this.database
			.insert(epgChannels)
			.values({
				id: randomUUID(),
				sourceId: input.sourceId,
				externalId: input.externalId,
				displayName: input.displayName,
				// Keep manually seeded rows compatible with alias-aware matching.
				displayNames: input.displayNames ?? [input.displayName]
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create EPG channel record");
		}

		return created;
	}

	async getById(id: string) {
		const [record] = await this.database
			.select()
			.from(epgChannels)
			.where(eq(epgChannels.id, id))
			.limit(1);

		return record ?? null;
	}

	/** All EPG channels across every source; used by the auto-matcher. */
	async list(): Promise<EpgChannelRecord[]> {
		return this.database.select().from(epgChannels);
	}
}
