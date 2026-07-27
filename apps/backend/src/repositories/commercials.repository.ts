import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type {
	CommercialAnalysisStatus,
	CommercialMarker
} from "@signalhaven/shared";

import type { DatabaseClient } from "../db/client";
import {
	commercialAnalyses,
	commercialMarkers,
	recordings,
	scheduledJobs
} from "../db/schema";

export interface CommercialAnalysisRecord {
	recordingId: string;
	status: CommercialAnalysisStatus;
	scheduledJobId: string | null;
	detectorVersion: string | null;
	queuedAt: Date | null;
	startedAt: Date | null;
	completedAt: Date | null;
	failedAt: Date | null;
	diagnosticMessage: string | null;
}

export interface CommercialAnalysisDetail {
	analysis: CommercialAnalysisRecord | null;
	markers: CommercialMarker[];
}

/** Result of atomically owning or reusing an analysis job. */
export interface EnqueueCommercialAnalysisResult {
	analysis: CommercialAnalysisRecord;
	created: boolean;
}

function toRecord(
	row: typeof commercialAnalyses.$inferSelect
): CommercialAnalysisRecord {
	return {
		recordingId: row.recordingId,
		status: row.status as CommercialAnalysisRecord["status"],
		scheduledJobId: row.scheduledJobId ?? null,
		detectorVersion: row.detectorVersion ?? null,
		queuedAt: row.queuedAt ?? null,
		startedAt: row.startedAt ?? null,
		completedAt: row.completedAt ?? null,
		failedAt: row.failedAt ?? null,
		diagnosticMessage: row.diagnosticMessage ?? null
	};
}

/** Persists analysis ownership and normalized intervals transactionally. */
export class CommercialsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async get(recordingId: string): Promise<CommercialAnalysisDetail> {
		const [analysis, markers] = await Promise.all([
			this.database
				.select()
				.from(commercialAnalyses)
				.where(eq(commercialAnalyses.recordingId, recordingId))
				.limit(1),
			this.database
				.select({
					startMs: commercialMarkers.startMs,
					endMs: commercialMarkers.endMs
				})
				.from(commercialMarkers)
				.where(eq(commercialMarkers.recordingId, recordingId))
				.orderBy(asc(commercialMarkers.startMs))
		]);
		return {
			analysis: analysis[0] ? toRecord(analysis[0]) : null,
			markers
		};
	}

	/**
	 * Insert analysis ownership and its scheduler row in one transaction.
	 * Active work and same-version completed output are reused idempotently.
	 */
	async enqueue(
		recordingId: string,
		detectorVersion: string,
		jobKind: string,
		force = false
	): Promise<EnqueueCommercialAnalysisResult> {
		return this.database.transaction(async (tx) => {
			// Lock the parent even when no analysis row exists yet; otherwise two
			// first-time requests could each create a different scheduler job.
			const [recording] = await tx
				.select({ id: recordings.id })
				.from(recordings)
				.where(eq(recordings.id, recordingId))
				.for("update")
				.limit(1);
			if (!recording) throw new Error("Recording not found");
			const [existing] = await tx
				.select()
				.from(commercialAnalyses)
				.where(eq(commercialAnalyses.recordingId, recordingId))
				.for("update")
				.limit(1);
			if (
				existing &&
				(existing.status === "queued" || existing.status === "running")
			) {
				return { analysis: toRecord(existing), created: false };
			}
			if (
				existing &&
				!force &&
				existing.status === "completed" &&
				existing.detectorVersion === detectorVersion
			) {
				return { analysis: toRecord(existing), created: false };
			}

			const now = new Date();
			const jobId = randomUUID();
			await tx
				.delete(commercialMarkers)
				.where(eq(commercialMarkers.recordingId, recordingId));
			const [analysis] = await tx
				.insert(commercialAnalyses)
				.values({
					recordingId,
					status: "queued",
					scheduledJobId: jobId,
					detectorVersion,
					queuedAt: now,
					startedAt: null,
					completedAt: null,
					failedAt: null,
					diagnosticMessage: null,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: commercialAnalyses.recordingId,
					set: {
						status: "queued",
						scheduledJobId: jobId,
						detectorVersion,
						queuedAt: now,
						startedAt: null,
						completedAt: null,
						failedAt: null,
						diagnosticMessage: null,
						updatedAt: now
					}
				})
				.returning();
			if (!analysis) throw new Error("Failed to queue commercial analysis");
			await tx.insert(scheduledJobs).values({
				id: jobId,
				kind: jobKind,
				payload: { recordingId },
				runAt: now,
				status: "pending",
				attempts: 0,
				maxAttempts: 1,
				createdAt: now,
				updatedAt: now
			});
			return { analysis: toRecord(analysis), created: true };
		});
	}

	/** Claim queued work, including a recovered job whose state remained running. */
	async markRunning(
		recordingId: string
	): Promise<CommercialAnalysisRecord | null> {
		const now = new Date();
		const [updated] = await this.database
			.update(commercialAnalyses)
			.set({
				status: "running",
				startedAt: now,
				failedAt: null,
				updatedAt: now
			})
			.where(
				and(
					eq(commercialAnalyses.recordingId, recordingId),
					inArray(commercialAnalyses.status, ["queued", "running"])
				)
			)
			.returning();
		return updated ? toRecord(updated) : null;
	}

	/** Replace every marker and finish the owning analysis atomically. */
	async complete(
		recordingId: string,
		markers: readonly CommercialMarker[]
	): Promise<void> {
		await this.database.transaction(async (tx) => {
			await tx
				.delete(commercialMarkers)
				.where(eq(commercialMarkers.recordingId, recordingId));
			if (markers.length > 0) {
				await tx.insert(commercialMarkers).values(
					markers.map((marker) => ({
						id: randomUUID(),
						recordingId,
						startMs: marker.startMs,
						endMs: marker.endMs
					}))
				);
			}
			const now = new Date();
			await tx
				.update(commercialAnalyses)
				.set({
					status: "completed",
					completedAt: now,
					failedAt: null,
					diagnosticMessage: null,
					updatedAt: now
				})
				.where(eq(commercialAnalyses.recordingId, recordingId));
		});
	}

	async fail(recordingId: string, diagnosticMessage: string): Promise<void> {
		const now = new Date();
		await this.database
			.update(commercialAnalyses)
			.set({
				status: "failed",
				failedAt: now,
				diagnosticMessage,
				updatedAt: now
			})
			.where(eq(commercialAnalyses.recordingId, recordingId));
	}

	/** Completed recordings are reconsidered when settings/version changes. */
	async listCompletedRecordingIds(): Promise<string[]> {
		const rows = await this.database
			.select({ id: recordings.id })
			.from(recordings)
			.where(eq(recordings.status, "completed"));
		return rows.map((row) => row.id);
	}
}
