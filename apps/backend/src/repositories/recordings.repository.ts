import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sum,
	sql,
	type SQL
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type {
	RecordingOneOffGroup,
	RecordingSeriesGroup,
	RecordingStartReason
} from "@signalhaven/shared";

import type { DatabaseClient } from "../db/client";
import {
	commercialAnalyses,
	epgPrograms,
	recordings,
	scheduledJobs,
	seriesRules
} from "../db/schema";

import { escapeLike } from "./search.repository";

/**
 * Persisted lifecycle states for a recording. Mirrors the shared
 * `recordingStatusSchema` enum; kept loose at the repository boundary so
 * the layer above can introduce intermediate states without dragging the
 * shared schema along.
 */
export type RecordingStatus =
	| "scheduled"
	| "recording"
	| "completed"
	| "failed"
	| "cancelled";

export type CreateRecordingInput = {
	channelId: string;
	programId?: string;
	title: string;
	status: RecordingStatus;
	scheduledStart: Date;
	scheduledEnd: Date;
	schedulerJobId?: string | null;
	seriesRuleId?: string | null;
	manuallyProtected?: boolean;
	episodeSnapshot?: RecordingEpisodeSnapshot;
};

/** Immutable episode metadata copied from the guide when scheduling. */
export interface RecordingEpisodeSnapshot {
	identityKey: string | null;
	subtitle: string | null;
	description: string | null;
	season: number | null;
	episode: number | null;
	categories: string[];
	artworkUrl: string | null;
	originalAirDate: string | null;
}

/**
 * Recording and one-off job data persisted together for a new schedule.
 * The transaction prevents either row from surviving without its partner.
 */
export type CreateScheduledRecordingInput = Omit<
	CreateRecordingInput,
	"status" | "schedulerJobId"
> & {
	jobKind: string;
	runAt: Date;
	maxAttempts?: number;
};

export type RecordingRecord = {
	id: string;
	channelId: string;
	/** Physical source used for capture; absent on legacy and synthetic records. */
	sourceChannelId?: string | null;
	programId: string | null;
	title: string;
	status: RecordingStatus;
	scheduledStart: Date;
	scheduledEnd: Date;
	actualStart: Date | null;
	actualEnd: Date | null;
	startReason: RecordingStartReason | null;
	filePath: string | null;
	fileSize: number | null;
	durationSeconds: number | null;
	errorMessage: string | null;
	schedulerJobId: string | null;
	seriesRuleId: string | null;
	manuallyProtected: boolean;
	watchedAt: Date | null;
	resumePositionSeconds: number | null;
	episodeIdentityKey?: string | null;
	episodeSubtitle?: string | null;
	episodeDescription?: string | null;
	episodeSeason?: number | null;
	episodeNumber?: number | null;
	episodeCategories?: string[];
	episodeArtworkUrl?: string | null;
	episodeOriginalAirDate?: string | null;
	createdAt: Date;
	updatedAt: Date;
};

/** Recording fields needed to annotate Guide programs. */
export interface GuideRecordingRecord {
	id: string;
	programId: string | null;
	status: RecordingStatus;
}

function toRecord(row: typeof recordings.$inferSelect): RecordingRecord {
	return {
		id: row.id,
		channelId: row.channelId,
		sourceChannelId: row.sourceChannelId ?? null,
		programId: row.programId ?? null,
		title: row.title,
		status: row.status as RecordingStatus,
		scheduledStart: row.scheduledStart,
		scheduledEnd: row.scheduledEnd,
		actualStart: row.actualStart ?? null,
		actualEnd: row.actualEnd ?? null,
		startReason: (row.startReason as RecordingStartReason | null) ?? null,
		filePath: row.filePath ?? null,
		fileSize: row.fileSize ?? null,
		durationSeconds: row.durationSeconds ?? null,
		errorMessage: row.errorMessage ?? null,
		schedulerJobId: row.schedulerJobId ?? null,
		seriesRuleId: row.seriesRuleId ?? null,
		manuallyProtected: row.manuallyProtected ?? false,
		watchedAt: row.watchedAt ?? null,
		resumePositionSeconds: row.resumePositionSeconds ?? null,
		episodeIdentityKey: row.episodeIdentityKey ?? null,
		episodeSubtitle: row.episodeSubtitle ?? null,
		episodeDescription: row.episodeDescription ?? null,
		episodeSeason: row.episodeSeason ?? null,
		episodeNumber: row.episodeNumber ?? null,
		episodeCategories: row.episodeCategories ?? [],
		episodeArtworkUrl: row.episodeArtworkUrl ?? null,
		episodeOriginalAirDate: row.episodeOriginalAirDate ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export type UpdateRecordingInput = Partial<{
	status: RecordingStatus;
	sourceChannelId: string | null;
	actualStart: Date | null;
	actualEnd: Date | null;
	startReason: RecordingStartReason | null;
	filePath: string | null;
	fileSize: number | null;
	durationSeconds: number | null;
	errorMessage: string | null;
	scheduledStart: Date;
	scheduledEnd: Date;
	schedulerJobId: string | null;
	seriesRuleId: string | null;
	manuallyProtected: boolean;
	watchedAt: Date | null;
	resumePositionSeconds: number | null;
}>;

export type RecordingListFilter = {
	/** Literal, case-insensitive title search. */
	search?: string;
	status?: RecordingStatus;
	channelId?: string;
	seriesRuleId?: string;
	/** Inclusive lower bound on `scheduled_start`. */
	from?: Date;
	/** Strict upper bound on `scheduled_start`. */
	to?: Date;
};

export type RecordingListSort = "scheduledStart" | "actualStart" | "createdAt";
export type RecordingListDirection = "asc" | "desc";

/** Decoded keyset position from the preceding page. */
export type RecordingListCursor = {
	value: Date | null;
	id: string;
};

export type RecordingListOptions = RecordingListFilter & {
	limit?: number;
	offset?: number;
	cursor?: RecordingListCursor;
	sort?: RecordingListSort;
	direction?: RecordingListDirection;
};

export type RecordingListPage = {
	items: RecordingRecord[];
	total: number;
	totalSize: number;
	limit: number;
	offset: number;
	hasMore: boolean;
	seriesGroups: RecordingSeriesGroup[];
	oneOffGroup: RecordingOneOffGroup | null;
};

/** Explicit result used by idempotent schedule-by-program callers. */
export type CreateScheduledRecordingResult = {
	recording: RecordingRecord;
	created: boolean;
};

export class RecordingsRepository {
	constructor(private readonly database: DatabaseClient) {}

	/**
	 * Atomically create a scheduled recording and its scheduler job.
	 *
	 * The partial unique index on active `program_id` values arbitrates
	 * concurrent requests. A losing request returns the row that won without
	 * inserting another job, while cancelled and failed rows remain retryable.
	 */
	async createScheduledWithJob(
		input: CreateScheduledRecordingInput
	): Promise<CreateScheduledRecordingResult> {
		const now = new Date();
		const recordingId = randomUUID();
		const jobId = randomUUID();

		return this.database.transaction(async (tx) => {
			const [created] = await tx
				.insert(recordings)
				.values({
					id: recordingId,
					channelId: input.channelId,
					programId: input.programId,
					title: input.title,
					status: "scheduled",
					scheduledStart: input.scheduledStart,
					scheduledEnd: input.scheduledEnd,
					schedulerJobId: jobId,
					seriesRuleId: input.seriesRuleId ?? null,
					manuallyProtected: input.manuallyProtected ?? false,
					episodeIdentityKey: input.episodeSnapshot?.identityKey ?? null,
					episodeSubtitle: input.episodeSnapshot?.subtitle ?? null,
					episodeDescription: input.episodeSnapshot?.description ?? null,
					episodeSeason: input.episodeSnapshot?.season ?? null,
					episodeNumber: input.episodeSnapshot?.episode ?? null,
					episodeCategories: input.episodeSnapshot?.categories ?? [],
					episodeArtworkUrl: input.episodeSnapshot?.artworkUrl ?? null,
					episodeOriginalAirDate:
						input.episodeSnapshot?.originalAirDate ?? null,
					createdAt: now,
					updatedAt: now
				})
				.onConflictDoNothing()
				.returning();

			if (!created) {
				if (!input.programId) {
					throw new Error("Failed to create scheduled recording record");
				}
				const [existing] = await tx
					.select()
					.from(recordings)
					.where(activeProgramCondition(input.programId))
					.limit(1);
				if (!existing) {
					throw new Error("Active recording conflict could not be resolved");
				}
				return { recording: toRecord(existing), created: false };
			}

			await tx.insert(scheduledJobs).values({
				id: jobId,
				kind: input.jobKind,
				payload: { recordingId },
				runAt: input.runAt,
				status: "pending",
				attempts: 0,
				maxAttempts: input.maxAttempts ?? 1,
				createdAt: now,
				updatedAt: now
			});
			await tx.insert(commercialAnalyses).values({
				recordingId,
				status: "not_requested",
				updatedAt: now
			});

			return { recording: toRecord(created), created: true };
		});
	}

	async create(input: CreateRecordingInput): Promise<RecordingRecord> {
		const now = new Date();
		return this.database.transaction(async (tx) => {
			const [created] = await tx
				.insert(recordings)
				.values({
					id: randomUUID(),
					channelId: input.channelId,
					programId: input.programId,
					title: input.title,
					status: input.status,
					scheduledStart: input.scheduledStart,
					scheduledEnd: input.scheduledEnd,
					schedulerJobId: input.schedulerJobId ?? null,
					seriesRuleId: input.seriesRuleId ?? null,
					manuallyProtected: input.manuallyProtected ?? false,
					episodeIdentityKey: input.episodeSnapshot?.identityKey ?? null,
					episodeSubtitle: input.episodeSnapshot?.subtitle ?? null,
					episodeDescription: input.episodeSnapshot?.description ?? null,
					episodeSeason: input.episodeSnapshot?.season ?? null,
					episodeNumber: input.episodeSnapshot?.episode ?? null,
					episodeCategories: input.episodeSnapshot?.categories ?? [],
					episodeArtworkUrl: input.episodeSnapshot?.artworkUrl ?? null,
					episodeOriginalAirDate:
						input.episodeSnapshot?.originalAirDate ?? null,
					createdAt: now,
					updatedAt: now
				})
				.returning();

			if (!created) throw new Error("Failed to create recording record");
			await tx.insert(commercialAnalyses).values({
				recordingId: created.id,
				status: "not_requested",
				updatedAt: now
			});
			return toRecord(created);
		});
	}

	async getById(id: string): Promise<RecordingRecord | null> {
		const [record] = await this.database
			.select()
			.from(recordings)
			.where(eq(recordings.id, id))
			.limit(1);

		return record ? toRecord(record) : null;
	}

	async list(): Promise<RecordingRecord[]> {
		const rows = await this.database
			.select()
			.from(recordings)
			.orderBy(asc(recordings.scheduledStart));
		return rows.map(toRecord);
	}

	/**
	 * Filtered + paginated listing used by `GET /api/v1/recordings`.
	 * Returns the page plus the total row count matching the filter so
	 * callers can render pagination UI.
	 *
	 * Indexes that back this query:
	 *   * `recordings_status_scheduled_start_idx` for status + sort
	 *   * `recordings_channel_scheduled_start_idx` for channel + sort
	 *   * `recordings_series_rule_idx` for series filter
	 *   * `recordings_actual_start_idx` for `sort=actualStart`
	 */
	async listPage(options: RecordingListOptions): Promise<RecordingListPage> {
		const limit = Math.max(1, Math.min(200, options.limit ?? 50));
		const offset = Math.max(0, options.offset ?? 0);
		const sort = options.sort ?? "scheduledStart";
		const direction = options.direction ?? "desc";
		const conditions = this.buildListConditions(options);
		const orderColumn =
			sort === "actualStart"
				? recordings.actualStart
				: sort === "createdAt"
					? recordings.createdAt
					: recordings.scheduledStart;
		// Actual start is nullable for future and failed recordings. Keeping nulls
		// last in both directions makes its cursor order explicit and repeatable.
		const orderBy =
			sort === "actualStart"
				? direction === "asc"
					? sql`${orderColumn} ASC NULLS LAST`
					: sql`${orderColumn} DESC NULLS LAST`
				: direction === "asc"
					? asc(orderColumn)
					: desc(orderColumn);

		const pageConditions = [...conditions];
		if (options.cursor) {
			pageConditions.push(
				this.buildCursorCondition(sort, direction, options.cursor)
			);
		}
		const where =
			pageConditions.length > 0 ? and(...pageConditions) : undefined;
		const aggregateWhere =
			conditions.length > 0 ? and(...conditions) : undefined;

		const baseRows = this.database.select().from(recordings);
		const filteredRows = where ? baseRows.where(where) : baseRows;
		const baseAggregates = this.database
			.select({
				value: count(),
				totalSize: sum(recordings.fileSize)
			})
			.from(recordings);
		const aggregateQuery = aggregateWhere
			? baseAggregates.where(aggregateWhere)
			: baseAggregates;

		// Fetch one extra row so the continuation state stays correct even when
		// concurrent inserts or deletes change the total between page requests.
		const [fetchedRows, aggregate] = await Promise.all([
			filteredRows
				.orderBy(orderBy, asc(recordings.id))
				.limit(limit + 1)
				// Preserve OFFSET for older clients; cursor callers seek by keyset.
				.offset(options.cursor ? 0 : offset),
			aggregateQuery
		]);
		const hasMore = fetchedRows.length > limit;
		const rows = fetchedRows.slice(0, limit);
		const groups = await this.loadGroupSummaries(conditions, rows);
		const [counted] = aggregate;

		return {
			items: rows.map(toRecord),
			total: Number(counted?.value ?? 0),
			totalSize: Number(counted?.totalSize ?? 0),
			limit,
			offset,
			hasMore,
			seriesGroups: groups.seriesGroups,
			oneOffGroup: groups.oneOffGroup
		};
	}

	private buildListConditions(filter: RecordingListFilter): SQL[] {
		const conditions: SQL[] = [];
		const search = filter.search?.trim();
		if (search) {
			// PostgreSQL's default LIKE escape is a backslash, so escaped wildcard
			// characters remain literal while the trigram index supports `%term%`.
			conditions.push(ilike(recordings.title, `%${escapeLike(search)}%`));
		}
		if (filter.status) {
			conditions.push(eq(recordings.status, filter.status));
		}
		if (filter.channelId) {
			conditions.push(eq(recordings.channelId, filter.channelId));
		}
		if (filter.seriesRuleId) {
			conditions.push(eq(recordings.seriesRuleId, filter.seriesRuleId));
		}
		if (filter.from) {
			conditions.push(gte(recordings.scheduledStart, filter.from));
		}
		if (filter.to) {
			conditions.push(lt(recordings.scheduledStart, filter.to));
		}
		return conditions;
	}

	/**
	 * Build the lexicographic "after" predicate for the selected sort. The id
	 * always sorts ascending as a deterministic tiebreaker.
	 */
	private buildCursorCondition(
		sort: RecordingListSort,
		direction: RecordingListDirection,
		cursor: RecordingListCursor
	): SQL {
		const orderColumn =
			sort === "actualStart"
				? recordings.actualStart
				: sort === "createdAt"
					? recordings.createdAt
					: recordings.scheduledStart;
		if (cursor.value === null) {
			// Only nullable actualStart cursors can reach this branch.
			return and(isNull(recordings.actualStart), gt(recordings.id, cursor.id))!;
		}

		const afterValue =
			direction === "asc"
				? gt(orderColumn, cursor.value)
				: lt(orderColumn, cursor.value);
		const sameValueAfterId = and(
			eq(orderColumn, cursor.value),
			gt(recordings.id, cursor.id)
		)!;
		if (sort === "actualStart") {
			return or(afterValue, sameValueAfterId, isNull(orderColumn))!;
		}
		return or(afterValue, sameValueAfterId)!;
	}

	/**
	 * Load complete counts only for groups represented by this bounded page.
	 * This avoids returning an unbounded summary list while still making every
	 * displayed series count and size accurate for the full filter.
	 */
	private async loadGroupSummaries(
		conditions: SQL[],
		rows: Array<typeof recordings.$inferSelect>
	): Promise<{
		seriesGroups: RecordingSeriesGroup[];
		oneOffGroup: RecordingOneOffGroup | null;
	}> {
		const seriesIds = [
			...new Set(
				rows.flatMap((row) => (row.seriesRuleId ? [row.seriesRuleId] : []))
			)
		];
		const includesOneOff = rows.some((row) => row.seriesRuleId === null);
		if (seriesIds.length === 0 && !includesOneOff) {
			return { seriesGroups: [], oneOffGroup: null };
		}

		const membership =
			seriesIds.length > 0 && includesOneOff
				? or(
						inArray(recordings.seriesRuleId, seriesIds),
						isNull(recordings.seriesRuleId)
					)
				: seriesIds.length > 0
					? inArray(recordings.seriesRuleId, seriesIds)
					: isNull(recordings.seriesRuleId);
		const where = and(...conditions, membership!);
		const summaries = await this.database
			.select({
				seriesRuleId: recordings.seriesRuleId,
				title: seriesRules.title,
				recordingCount: count(),
				totalSize: sum(recordings.fileSize)
			})
			.from(recordings)
			.leftJoin(seriesRules, eq(recordings.seriesRuleId, seriesRules.id))
			.where(where)
			.groupBy(recordings.seriesRuleId, seriesRules.title);

		const seriesGroups: RecordingSeriesGroup[] = [];
		let oneOffGroup: RecordingOneOffGroup | null = null;
		for (const summary of summaries) {
			if (summary.seriesRuleId) {
				const fallbackTitle =
					rows.find((row) => row.seriesRuleId === summary.seriesRuleId)
						?.title ?? "Series";
				seriesGroups.push({
					seriesRuleId: summary.seriesRuleId,
					title: summary.title ?? fallbackTitle,
					recordingCount: Number(summary.recordingCount),
					totalSize: Number(summary.totalSize ?? 0)
				});
			} else {
				oneOffGroup = {
					recordingCount: Number(summary.recordingCount),
					totalSize: Number(summary.totalSize ?? 0)
				};
			}
		}
		return { seriesGroups, oneOffGroup };
	}

	async update(
		id: string,
		patch: UpdateRecordingInput
	): Promise<RecordingRecord | null> {
		const [updated] = await this.database
			.update(recordings)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(recordings.id, id))
			.returning();

		return updated ? toRecord(updated) : null;
	}

	/**
	 * Update scheduler-owned fields only while the recording remains scheduled.
	 * Startup recovery and EPG rescheduling use this gate so a concurrent cancel
	 * cannot leave a replacement job linked to a terminal row.
	 */
	async updateScheduled(
		id: string,
		patch: UpdateRecordingInput
	): Promise<RecordingRecord | null> {
		const [updated] = await this.database
			.update(recordings)
			.set({ ...patch, updatedAt: new Date() })
			.where(and(eq(recordings.id, id), eq(recordings.status, "scheduled")))
			.returning();
		return updated ? toRecord(updated) : null;
	}

	/**
	 * Atomic transition that only fires when the row is currently in
	 * `expectedStatus`. Returns the updated row, or `null` if another
	 * actor already moved it (e.g. a cancel request raced the scheduler).
	 */
	async transitionStatus(
		id: string,
		expectedStatus: RecordingStatus,
		patch: UpdateRecordingInput & { status: RecordingStatus }
	): Promise<RecordingRecord | null> {
		const [updated] = await this.database
			.update(recordings)
			.set({ ...patch, updatedAt: new Date() })
			.where(and(eq(recordings.id, id), eq(recordings.status, expectedStatus)))
			.returning();

		return updated ? toRecord(updated) : null;
	}

	/**
	 * Cancel a scheduled recording and its pending/running retry job together.
	 * The conditional recording update makes cancellation win races with the
	 * runner, while the job update prevents a transient failure from re-arming.
	 */
	async cancelScheduled(id: string): Promise<RecordingRecord | null> {
		const now = new Date();
		return this.database.transaction(async (tx) => {
			const [updated] = await tx
				.update(recordings)
				.set({
					status: "cancelled",
					updatedAt: now
				})
				.where(and(eq(recordings.id, id), eq(recordings.status, "scheduled")))
				.returning();
			if (!updated) {
				return null;
			}
			if (updated.schedulerJobId) {
				await tx
					.update(scheduledJobs)
					.set({
						status: "cancelled",
						lockedAt: null,
						updatedAt: now
					})
					.where(
						and(
							eq(scheduledJobs.id, updated.schedulerJobId),
							inArray(scheduledJobs.status, ["pending", "running"])
						)
					);
			}
			return toRecord(updated);
		});
	}

	/**
	 * Crash recovery: any rows still marked `recording` at startup were
	 * orphaned by a previous process and are flipped to `failed` with a
	 * `process_terminated` error message so the operator can see why.
	 * Returns the affected ids so callers can publish WS events.
	 */
	async recoverInProgress(reason: string): Promise<string[]> {
		const now = new Date();
		const updated = await this.database
			.update(recordings)
			.set({
				status: "failed",
				actualEnd: now,
				errorMessage: reason,
				updatedAt: now
			})
			.where(eq(recordings.status, "recording"))
			.returning({ id: recordings.id });

		return updated.map((row) => row.id);
	}

	/**
	 * All recordings still in `scheduled` (used at startup to re-arm the
	 * in-process scheduler with one-off jobs that survived a restart).
	 */
	async listByStatuses(
		statuses: RecordingStatus[]
	): Promise<RecordingRecord[]> {
		if (statuses.length === 0) {
			return [];
		}
		const rows = await this.database
			.select()
			.from(recordings)
			.where(inArray(recordings.status, statuses))
			.orderBy(asc(recordings.scheduledStart));
		return rows.map(toRecord);
	}

	/**
	 * All recordings still `scheduled` and linked to an EPG program (i.e.
	 * `program_id IS NOT NULL`). Used after an EPG refresh to detect
	 * programs whose start/stop have shifted and re-arm the scheduler
	 * accordingly.
	 */
	async listScheduledWithProgram(): Promise<RecordingRecord[]> {
		const rows = await this.database
			.select()
			.from(recordings)
			.where(
				and(eq(recordings.status, "scheduled"), isNotNull(recordings.programId))
			)
			.orderBy(asc(recordings.scheduledStart));
		return rows.map(toRecord);
	}

	/**
	 * Has a non-terminal recording already been scheduled for this exact
	 * EPG program? Used by the series-rule evaluator to avoid creating
	 * duplicate rows for the same airing.
	 */
	async findActiveByProgramId(
		programId: string
	): Promise<RecordingRecord | null> {
		const [row] = await this.database
			.select()
			.from(recordings)
			.where(activeProgramCondition(programId))
			.limit(1);
		return row ? toRecord(row) : null;
	}

	/** Find durable prior work without joining a guide row that may be pruned. */
	async findExistingForEpisodeIdentity(
		episodeIdentityKey: string
	): Promise<RecordingRecord | null> {
		const [record] = await this.database
			.select()
			.from(recordings)
			.where(
				and(
					eq(recordings.episodeIdentityKey, episodeIdentityKey),
					inArray(recordings.status, ["scheduled", "recording", "completed"])
				)
			)
			.limit(1);
		return record ? toRecord(record) : null;
	}

	/**
	 * Has a recording for the given series + season + episode already
	 * been scheduled, captured, or completed? Failed and cancelled attempts
	 * are retryable. Drives the series-rule
	 * `(series-id, season, episode)` deduplication so the same episode
	 * is never recorded twice across reruns. Episodes without season /
	 * episode metadata fall back to the program-id check above.
	 *
	 * The `(season, episode)` filter is highly selective in practice (a
	 * given series rarely has more than a handful of recordings sharing
	 * the same numbers); the modest `limit(200)` cap is a safety belt
	 * against pathological data and is far above any realistic series
	 * cardinality.
	 */
	async findExistingForSeriesEpisode(input: {
		seriesRuleId?: string | null;
		title: string;
		season: number | null;
		episode: number | null;
	}): Promise<RecordingRecord | null> {
		if (input.season === null || input.episode === null) {
			return null;
		}
		// Match either by series-rule lineage (preferred when available) or
		// by case-insensitive title so a manually-scheduled airing of the
		// same episode still counts as a duplicate.
		const rows = await this.database
			.select()
			.from(recordings)
			.innerJoin(epgPrograms, eq(epgPrograms.id, recordings.programId))
			.where(
				and(
					inArray(recordings.status, ["scheduled", "recording", "completed"]),
					eq(epgPrograms.season, input.season),
					eq(epgPrograms.episode, input.episode)
				)
			)
			.limit(200);
		for (const r of rows) {
			const rec = r.recordings;
			if (input.seriesRuleId && rec.seriesRuleId === input.seriesRuleId) {
				return toRecord(rec);
			}
			if (rec.title.toLowerCase() === input.title.toLowerCase()) {
				return toRecord(rec);
			}
		}
		return null;
	}

	/**
	 * All `completed` recordings produced by the given series rule,
	 * ordered oldest-first. Used by `keepCount` enforcement.
	 */
	async listCompletedBySeriesRule(
		seriesRuleId: string
	): Promise<RecordingRecord[]> {
		const rows = await this.database
			.select()
			.from(recordings)
			.where(
				and(
					eq(recordings.seriesRuleId, seriesRuleId),
					eq(recordings.status, "completed")
				)
			)
			.orderBy(asc(recordings.actualStart), asc(recordings.scheduledStart));
		return rows.map(toRecord);
	}

	/**
	 * All future-dated `scheduled` recordings (those whose
	 * `scheduled_end` is strictly after `after`), ordered by start. Used
	 * by the conflict-resolution simulator (it walks every still-scheduled
	 * row when deciding which new candidate, if any, must be dropped).
	 */
	async listScheduledStartingAfter(after: Date): Promise<RecordingRecord[]> {
		const rows = await this.database
			.select()
			.from(recordings)
			.where(
				and(
					eq(recordings.status, "scheduled"),
					gt(recordings.scheduledEnd, after)
				)
			)
			.orderBy(asc(recordings.scheduledStart));
		return rows.map(toRecord);
	}

	/**
	 * Hard-delete a recording row. Used by `keepCount` enforcement after
	 * the on-disk file has been removed; cancellation / soft-delete uses
	 * `transitionStatus` instead.
	 */
	async delete(id: string): Promise<RecordingRecord | null> {
		const [deleted] = await this.database
			.delete(recordings)
			.where(eq(recordings.id, id))
			.returning();
		return deleted ? toRecord(deleted) : null;
	}

	/**
	 * Sum of `file_size` across all completed recordings (the rows that
	 * actually consume storage). Returned as bytes; `0` when the library
	 * is empty. Used by storage-quota enforcement to decide whether to
	 * evict.
	 */
	async sumCompletedSize(): Promise<number> {
		const [row] = await this.database
			.select({ value: sum(recordings.fileSize) })
			.from(recordings)
			.where(eq(recordings.status, "completed"));
		if (!row?.value) return 0;
		// `sum()` returns a string for `bigint`-typed columns under
		// node-postgres; coerce defensively.
		const n = Number(row.value);
		return Number.isFinite(n) ? n : 0;
	}

	/**
	 * Completed recordings ordered oldest-first that are eligible for
	 * automatic eviction (i.e. `manuallyProtected = false`). Used by
	 * storage-quota and series-rule retention enforcement.
	 */
	async listEvictionCandidates(): Promise<RecordingRecord[]> {
		const rows = await this.database
			.select()
			.from(recordings)
			.where(
				and(
					eq(recordings.status, "completed"),
					eq(recordings.manuallyProtected, false)
				)
			)
			.orderBy(asc(recordings.actualStart), asc(recordings.scheduledStart));
		return rows.map(toRecord);
	}

	/**
	 * Every recording that has a non-null `file_path` (any status). Used
	 * by the library-scan reconciler to detect missing files and refresh
	 * stale `file_size` values.
	 */
	async listWithFilePath(): Promise<RecordingRecord[]> {
		const rows = await this.database
			.select()
			.from(recordings)
			.where(isNotNull(recordings.filePath));
		return rows.map(toRecord);
	}

	/**
	 * All recordings whose `program_id` is in the given set. Returns an
	 * empty array immediately when `programIds` is empty. Used by the EPG
	 * grid to annotate each program cell with its recording status.
	 *
	 * When multiple recordings exist for the same program (e.g. a retry
	 * after a failure) the most recently updated row is returned for each
	 * program; the grid service picks the most informative status.
	 */
	async listByProgramIds(
		programIds: string[]
	): Promise<GuideRecordingRecord[]> {
		if (programIds.length === 0) {
			return [];
		}
		const rows = await this.database
			.select({
				id: recordings.id,
				programId: recordings.programId,
				status: recordings.status
			})
			.from(recordings)
			.where(inArray(recordings.programId, programIds))
			.orderBy(desc(recordings.updatedAt));
		return rows.map((row) => ({
			...row,
			status: row.status as RecordingStatus
		}));
	}
}

/** Shared predicate for the database-backed active-program invariant. */
function activeProgramCondition(programId: string): SQL {
	return and(
		eq(recordings.programId, programId),
		inArray(recordings.status, ["scheduled", "recording"])
	) as SQL;
}
