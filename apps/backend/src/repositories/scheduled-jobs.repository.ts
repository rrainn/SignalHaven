import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { scheduledJobs } from "../db/schema";

/** Persisted lifecycle states for a one-off job. */
export type ScheduledJobStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type CreateScheduledJobInput = {
	kind: string;
	runAt: Date;
	payload?: Record<string, unknown>;
	maxAttempts?: number;
};

export type ScheduledJobRecord = {
	id: string;
	kind: string;
	payload: Record<string, unknown>;
	runAt: Date;
	status: ScheduledJobStatus;
	attempts: number;
	maxAttempts: number;
	lastError: string | null;
	lockedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

function toRecord(row: typeof scheduledJobs.$inferSelect): ScheduledJobRecord {
	return {
		id: row.id,
		kind: row.kind,
		payload: (row.payload as Record<string, unknown>) ?? {},
		runAt: row.runAt,
		status: row.status as ScheduledJobStatus,
		attempts: row.attempts,
		maxAttempts: row.maxAttempts,
		lastError: row.lastError ?? null,
		lockedAt: row.lockedAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/**
 * Persistence for one-off jobs scheduled by the in-process scheduler. Recurring
 * jobs are intentionally code-defined (not stored here) so a deploy can change
 * the schedule without DB migrations.
 */
export class ScheduledJobsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateScheduledJobInput): Promise<ScheduledJobRecord> {
		const now = new Date();
		const [created] = await this.database
			.insert(scheduledJobs)
			.values({
				id: randomUUID(),
				kind: input.kind,
				payload: input.payload ?? {},
				runAt: input.runAt,
				status: "pending",
				attempts: 0,
				maxAttempts: input.maxAttempts ?? 1,
				createdAt: now,
				updatedAt: now
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create scheduled job record");
		}

		return toRecord(created);
	}

	async getById(id: string): Promise<ScheduledJobRecord | null> {
		const [record] = await this.database
			.select()
			.from(scheduledJobs)
			.where(eq(scheduledJobs.id, id))
			.limit(1);

		return record ? toRecord(record) : null;
	}

	/** Pending jobs whose run_at is at or before `now`, oldest first. */
	async listDue(now: Date, limit = 100): Promise<ScheduledJobRecord[]> {
		const rows = await this.database
			.select()
			.from(scheduledJobs)
			.where(
				and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.runAt, now))
			)
			.orderBy(asc(scheduledJobs.runAt))
			.limit(limit);

		return rows.map(toRecord);
	}

	/** Returns the earliest pending run_at, used to compute next timer wakeup. */
	async findNextPendingRunAt(): Promise<Date | null> {
		const [row] = await this.database
			.select({ runAt: scheduledJobs.runAt })
			.from(scheduledJobs)
			.where(eq(scheduledJobs.status, "pending"))
			.orderBy(asc(scheduledJobs.runAt))
			.limit(1);

		return row?.runAt ?? null;
	}

	/**
	 * Atomically claim a pending job by transitioning to `running`. Returns the
	 * updated row only if the transition succeeded (prevents double-execution
	 * across concurrent scheduler ticks).
	 */
	async claim(id: string, now: Date): Promise<ScheduledJobRecord | null> {
		const [updated] = await this.database
			.update(scheduledJobs)
			.set({
				status: "running",
				lockedAt: now,
				updatedAt: now
			})
			.where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "pending")))
			.returning();

		return updated ? toRecord(updated) : null;
	}

	async markCompleted(id: string): Promise<boolean> {
		const now = new Date();
		const [updated] = await this.database
			.update(scheduledJobs)
			.set({
				status: "completed",
				lockedAt: null,
				updatedAt: now
			})
			.where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "running")))
			.returning({ id: scheduledJobs.id });
		return updated !== undefined;
	}

	async markFailed(
		id: string,
		error: string,
		attempts: number
	): Promise<boolean> {
		const now = new Date();
		const [updated] = await this.database
			.update(scheduledJobs)
			.set({
				status: "failed",
				lastError: error,
				attempts,
				lockedAt: null,
				updatedAt: now
			})
			.where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "running")))
			.returning({ id: scheduledJobs.id });
		return updated !== undefined;
	}

	/** Reschedules a failing job for another attempt at the given time. */
	async reschedule(
		id: string,
		runAt: Date,
		error: string,
		attempts: number
	): Promise<boolean> {
		const now = new Date();
		const [updated] = await this.database
			.update(scheduledJobs)
			.set({
				status: "pending",
				runAt,
				lastError: error,
				attempts,
				lockedAt: null,
				updatedAt: now
			})
			.where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "running")))
			.returning({ id: scheduledJobs.id });
		return updated !== undefined;
	}

	async cancel(id: string): Promise<boolean> {
		const now = new Date();
		const [updated] = await this.database
			.update(scheduledJobs)
			.set({
				status: "cancelled",
				lockedAt: null,
				updatedAt: now
			})
			.where(
				and(
					eq(scheduledJobs.id, id),
					inArray(scheduledJobs.status, ["pending", "running"])
				)
			)
			.returning({ id: scheduledJobs.id });

		return updated !== undefined;
	}

	/**
	 * Recovery on startup: any rows still in `running` (because the process
	 * crashed mid-job) are returned to `pending` so the scheduler can retry.
	 */
	async recoverStuckRunning(): Promise<number> {
		const now = new Date();
		const updated = await this.database
			.update(scheduledJobs)
			.set({
				status: "pending",
				lockedAt: null,
				updatedAt: now
			})
			.where(eq(scheduledJobs.status, "running"))
			.returning({ id: scheduledJobs.id });

		return updated.length;
	}
}
