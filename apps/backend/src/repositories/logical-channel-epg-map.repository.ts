import { eq } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";
import { logicalChannelEpgMap } from "../db/schema";

export type LogicalChannelEpgMapRecord =
	typeof logicalChannelEpgMap.$inferSelect;

/** Persists the single guide feed shared by every source in a channel group. */
export class LogicalChannelEpgMapRepository {
	constructor(private readonly database: DatabaseClient) {}

	async upsert(
		logicalChannelId: string,
		epgChannelId: string,
		manual = false
	): Promise<LogicalChannelEpgMapRecord> {
		const [stored] = await this.database
			.insert(logicalChannelEpgMap)
			.values({ logicalChannelId, epgChannelId, manual })
			.onConflictDoUpdate({
				target: logicalChannelEpgMap.logicalChannelId,
				set: { epgChannelId, manual }
			})
			.returning();
		if (!stored) throw new Error("Failed to store logical channel EPG mapping");
		return stored;
	}

	async getByLogicalChannelId(
		logicalChannelId: string
	): Promise<LogicalChannelEpgMapRecord | null> {
		const [record] = await this.database
			.select()
			.from(logicalChannelEpgMap)
			.where(eq(logicalChannelEpgMap.logicalChannelId, logicalChannelId))
			.limit(1);
		return record ?? null;
	}

	/** Compatibility shape for scheduling services that consume channelId. */
	async getByChannelId(logicalChannelId: string) {
		const record = await this.getByLogicalChannelId(logicalChannelId);
		return record
			? {
					channelId: record.logicalChannelId,
					epgChannelId: record.epgChannelId,
					manual: record.manual
				}
			: null;
	}

	async getByEpgChannelId(epgChannelId: string) {
		const [record] = await this.database
			.select()
			.from(logicalChannelEpgMap)
			.where(eq(logicalChannelEpgMap.epgChannelId, epgChannelId))
			.limit(1);
		return record
			? {
					channelId: record.logicalChannelId,
					epgChannelId: record.epgChannelId,
					manual: record.manual
				}
			: null;
	}

	async list(): Promise<LogicalChannelEpgMapRecord[]> {
		return this.database.select().from(logicalChannelEpgMap);
	}

	async listForGrid(): Promise<LogicalChannelEpgMapRecord[]> {
		return this.list();
	}
}
