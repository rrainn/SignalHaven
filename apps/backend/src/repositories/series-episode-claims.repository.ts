import { and, eq, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";
import { seriesRuleEpisodes } from "../db/schema";

/** Durable claim states retained independently from recording-file retention. */
export type SeriesEpisodeClaimState = "claimed" | "scheduled" | "completed";

/** Persistence contract used by the evaluator and its lightweight test fakes. */
export interface SeriesEpisodeClaims {
	claim(seriesRuleId: string, episodeIdentityKey: string): Promise<boolean>;
	attachRecording(
		seriesRuleId: string,
		episodeIdentityKey: string,
		recordingId: string
	): Promise<void>;
	markCompleted(recordingId: string): Promise<void>;
	releaseByRecordingId(recordingId: string): Promise<void>;
	release(seriesRuleId: string, episodeIdentityKey: string): Promise<void>;
}

/** PostgreSQL-backed atomic episode claims for multi-process evaluators. */
export class SeriesEpisodeClaimsRepository implements SeriesEpisodeClaims {
	constructor(private readonly database: DatabaseClient) {}

	async claim(
		seriesRuleId: string,
		episodeIdentityKey: string
	): Promise<boolean> {
		return this.database.transaction(async (tx) => {
			// A transaction-scoped key lock keeps stale-claim recovery and insertion
			// atomic across multiple backend processes.
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${seriesRuleId}:${episodeIdentityKey}`}, 0))`
			);
			await tx.execute(sql`
				DELETE FROM series_rule_episodes claim
				USING recordings recording
				WHERE claim.series_rule_id = ${seriesRuleId}::uuid
				  AND claim.episode_identity_key = ${episodeIdentityKey}
				  AND claim.recording_id = recording.id
				  AND recording.status IN ('failed', 'cancelled')
			`);
			// A process may stop after claiming but before attaching a recording.
			await tx.execute(sql`
				DELETE FROM series_rule_episodes
				WHERE series_rule_id = ${seriesRuleId}::uuid
				  AND episode_identity_key = ${episodeIdentityKey}
				  AND state = 'claimed'
				  AND recording_id IS NULL
				  AND updated_at < now() - interval '10 minutes'
			`);
			const rows = await tx
				.insert(seriesRuleEpisodes)
				.values({
					seriesRuleId,
					episodeIdentityKey,
					state: "claimed"
				})
				.onConflictDoNothing()
				.returning({ seriesRuleId: seriesRuleEpisodes.seriesRuleId });
			return rows.length > 0;
		});
	}

	async attachRecording(
		seriesRuleId: string,
		episodeIdentityKey: string,
		recordingId: string
	): Promise<void> {
		await this.database
			.update(seriesRuleEpisodes)
			.set({ state: "scheduled", recordingId, updatedAt: new Date() })
			.where(
				and(
					eq(seriesRuleEpisodes.seriesRuleId, seriesRuleId),
					eq(seriesRuleEpisodes.episodeIdentityKey, episodeIdentityKey)
				)
			);
	}

	async markCompleted(recordingId: string): Promise<void> {
		await this.database
			.update(seriesRuleEpisodes)
			.set({ state: "completed", updatedAt: new Date() })
			.where(eq(seriesRuleEpisodes.recordingId, recordingId));
	}

	async releaseByRecordingId(recordingId: string): Promise<void> {
		await this.database
			.delete(seriesRuleEpisodes)
			.where(eq(seriesRuleEpisodes.recordingId, recordingId));
	}

	async release(
		seriesRuleId: string,
		episodeIdentityKey: string
	): Promise<void> {
		await this.database
			.delete(seriesRuleEpisodes)
			.where(
				and(
					eq(seriesRuleEpisodes.seriesRuleId, seriesRuleId),
					eq(seriesRuleEpisodes.episodeIdentityKey, episodeIdentityKey)
				)
			);
	}
}
