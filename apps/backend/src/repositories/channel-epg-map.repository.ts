import { eq } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";
import { channelEpgMap, channels, logicalChannelEpgMap } from "../db/schema";

export type ChannelEpgMapRecord = typeof channelEpgMap.$inferSelect;

/** Mapping fields needed to associate Guide programs with tuner channels. */
export interface GuideChannelEpgMapRecord {
	channelId: string;
	epgChannelId: string;
}

export class ChannelEpgMapRepository {
	constructor(private readonly database: DatabaseClient) {}

	/**
	 * Insert or update a mapping. `manual` defaults to false (auto-generated);
	 * pass `true` from the manual override endpoint so the auto-matcher knows
	 * to leave it alone on subsequent EPG refreshes.
	 */
	async upsert(channelId: string, epgChannelId: string, manual = false) {
		const created = await this.database.transaction(async (tx) => {
			const [stored] = await tx
				.insert(channelEpgMap)
				.values({ channelId, epgChannelId, manual })
				.onConflictDoUpdate({
					target: channelEpgMap.channelId,
					set: { epgChannelId, manual }
				})
				.returning();
			const [source] = await tx
				.select({ logicalChannelId: channels.logicalChannelId })
				.from(channels)
				.where(eq(channels.id, channelId))
				.limit(1);
			if (source) {
				const insert = tx.insert(logicalChannelEpgMap).values({
					logicalChannelId: source.logicalChannelId,
					epgChannelId,
					manual
				});
				if (manual) {
					await insert.onConflictDoUpdate({
						target: logicalChannelEpgMap.logicalChannelId,
						set: { epgChannelId, manual: true }
					});
				} else {
					await insert.onConflictDoNothing();
				}
			}
			return stored;
		});

		if (!created) {
			throw new Error("Failed to upsert channel EPG map record");
		}

		return created;
	}

	async getByChannelId(channelId: string) {
		const [record] = await this.database
			.select()
			.from(channelEpgMap)
			.where(eq(channelEpgMap.channelId, channelId))
			.limit(1);

		return record ?? null;
	}

	/**
	 * Look up a tuner channel that is mapped to the given EPG channel.
	 * Multiple tuner channels can map to the same EPG channel (e.g. an
	 * HD/SD pair); we return the first one — picking the "best" channel
	 * across duplicates is a future concern. Returns `null` when no tuner
	 * channel is mapped to this EPG channel.
	 */
	async getByEpgChannelId(epgChannelId: string) {
		const [record] = await this.database
			.select()
			.from(channelEpgMap)
			.where(eq(channelEpgMap.epgChannelId, epgChannelId))
			.limit(1);

		return record ?? null;
	}

	/** All persisted mappings; used by the matcher to skip mapped channels. */
	async list(): Promise<ChannelEpgMapRecord[]> {
		return this.database.select().from(channelEpgMap);
	}

	/** Returns a compact mapping snapshot for Guide assembly. */
	async listForGrid(): Promise<GuideChannelEpgMapRecord[]> {
		return this.database
			.select({
				channelId: channelEpgMap.channelId,
				epgChannelId: channelEpgMap.epgChannelId
			})
			.from(channelEpgMap);
	}

	/** Removes a stale automatic mapping when no eligible guide match remains. */
	async deleteByChannelId(channelId: string): Promise<void> {
		await this.database
			.delete(channelEpgMap)
			.where(eq(channelEpgMap.channelId, channelId));
	}
}
