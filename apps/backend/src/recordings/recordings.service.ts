import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
	RECORDING_EVENT,
	RECORDING_FAILED_CONFIGURATION,
	RECORDING_FAILED_MISSED_WINDOW,
	RECORDING_FAILED_PROCESS_TERMINATED,
	RECORDING_FAILED_RETRIES_EXHAUSTED,
	RECORDING_FAILED_RETRY_WINDOW_EXHAUSTED,
	RECORDING_FAILED_SOURCE_CONFIGURATION,
	type Recording,
	type CommercialAnalysis,
	type RecordingEventName,
	type RecordingListQuery,
	type RecordingMetadata,
	type RecordingStartReason,
	type RecordingStatus
} from "@signalhaven/shared";

export { RECORDING_EVENT } from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import {
	RemoteImageProxy,
	type ProxiedImage
} from "../media/remote-image-proxy";
import type { CommercialAnalysisService } from "../commercials/commercial-analysis.service";
import {
	NonRetryableJobError,
	type JobContext,
	type Scheduler
} from "../scheduler/scheduler";
import type { ChannelEpgMapRepository } from "../repositories/channel-epg-map.repository";
import type { EpgProgramsRepository } from "../repositories/epg-programs.repository";
import type {
	CreateScheduledRecordingResult,
	RecordingListCursor,
	RecordingListPage,
	RecordingRecord,
	RecordingEpisodeSnapshot,
	RecordingsRepository,
	UpdateRecordingInput
} from "../repositories/recordings.repository";
import type { SeriesRulesRepository } from "../repositories/series-rules.repository";
import {
	ChannelNotStreamableError,
	type ResolvedStreamSource,
	type StreamSourceResolver
} from "../streaming/streaming.service";
import type { TunerAllocator } from "../tuners/tuner-allocator";
import {
	TunerNotFoundError,
	UnsupportedTunerKindError
} from "../tuners/tuners.service";

import { RecordingSession, type RecordingRunner } from "./recording-session";
import {
	RecordingPlaybackService,
	type RecordingPlaybackServiceOptions
} from "./recording-playback.service";
import {
	recordingPlaybackCachePath,
	recordingPlaybackCacheSize
} from "./recording-playback-session";

/** Job kind registered on the in-process scheduler. */
export const RECORDING_JOB_KIND = "recording";
/** Recording retries are bounded to avoid stale background work. */
export const RECORDING_MAX_ATTEMPTS = 3;
/** A retry must leave at least this much useful capture time. */
const MIN_MEANINGFUL_CAPTURE_MS = 1_000;
/** Ignore routine scheduler, source-resolution, and tuner startup latency. */
const LATE_START_GRACE_MS = 30_000;

/** Structured logger surface used for concise recording lifecycle events. */
export interface RecordingsLogger {
	debug(context: Record<string, unknown>, message: string): void;
	info(context: Record<string, unknown>, message: string): void;
	warn(context: Record<string, unknown>, message: string): void;
	error(context: Record<string, unknown>, message: string): void;
}

const noopLogger: RecordingsLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {}
};

/** Resolves the configured recordings root + padding from settings. */
export interface RecordingsConfigResolver {
	resolve(): Promise<{
		/** Absolute directory recordings are written into. */
		recordingsDir: string;
		/** Seconds to start recording before `scheduledStart`. */
		paddingBeforeSec: number;
		/** Seconds to keep recording after `scheduledEnd`. */
		paddingAfterSec: number;
		/**
		 * Storage quota in bytes (sum of `recordings.file_size` allowed
		 * before automatic eviction kicks in). `null` disables the quota.
		 */
		quotaBytes?: number | null;
	}>;
}

/** Testable boundary for verifying mounted recording storage. */
export type RecordingDirectoryProbe = (directory: string) => Promise<void>;

export class RecordingNotFoundError extends Error {
	constructor(id: string) {
		super(`Recording ${id} not found`);
		this.name = "RecordingNotFoundError";
	}
}

export class RecordingStorageNotConfiguredError extends Error {
	constructor() {
		super(
			"Recording storage directory is not configured (set settings.storage.path)"
		);
		this.name = "RecordingStorageNotConfiguredError";
	}
}

/** Raised when an explicit delete did not acknowledge library protection. */
export class RecordingProtectedError extends Error {
	constructor(public readonly recordingId: string) {
		super(
			`Recording ${recordingId} is protected; explicitly override protection to delete it`
		);
		this.name = "RecordingProtectedError";
	}
}

/** Raised when an opaque pagination cursor is invalid for the active sort. */
export class InvalidRecordingCursorError extends Error {
	constructor() {
		super("Recording page cursor is invalid for this sort");
		this.name = "InvalidRecordingCursorError";
	}
}

export class EpgProgramNotFoundError extends Error {
	constructor(programId: string) {
		super(`EPG program ${programId} not found`);
		this.name = "EpgProgramNotFoundError";
	}
}

export class ChannelNotMappedError extends Error {
	constructor(public readonly epgChannelId: string) {
		super(
			`EPG channel ${epgChannelId} has no tuner-channel mapping; configure one before recording by program`
		);
		this.name = "ChannelNotMappedError";
	}
}

export class ProgramNotRecordableError extends Error {
	constructor(public readonly programId: string) {
		super(`EPG program ${programId} has already ended`);
		this.name = "ProgramNotRecordableError";
	}
}

export interface RecordingsServiceOptions {
	repository: RecordingsRepository;
	scheduler: Scheduler;
	allocator: TunerAllocator;
	resolver: StreamSourceResolver;
	config: RecordingsConfigResolver;
	/**
	 * Optional EPG dependencies; required for `scheduleByProgram` and
	 * `reconcileProgramSchedules`. The service degrades gracefully when
	 * absent (the by-program endpoint is wired only when these are
	 * provided).
	 */
	epgPrograms?: EpgProgramsRepository;
	channelEpgMap?: Pick<
		ChannelEpgMapRepository,
		"getByChannelId" | "getByEpgChannelId"
	>;
	/**
	 * Optional series-rule repository; required for retention-based
	 * eviction (`enforceRetention`). When omitted, retention enforcement
	 * is a silent no-op.
	 */
	seriesRules?: SeriesRulesRepository;
	bus?: EventBus | undefined;
	/** Test seam for swapping out the ffmpeg invocation. */
	runner?: RecordingRunner;
	/** Test seam for deterministic recording-directory permission failures. */
	directoryProbe?: RecordingDirectoryProbe;
	/** Override clock for deterministic unit tests. */
	now?: () => Date;
	/** Structured lifecycle logger; defaults to a silent implementation. */
	logger?: RecordingsLogger;
	/** Override the VOD session manager or its process/configuration seams. */
	playbackService?: RecordingPlaybackService;
	playbackOptions?: Omit<
		RecordingPlaybackServiceOptions,
		"repository" | "bus" | "logger"
	>;
	/** Optional post-processing coordinator; recording success never depends on it. */
	commercialAnalysis?: CommercialAnalysisService;
	/** Test seam for provider artwork fetching and caching. */
	artworkProxy?: RemoteImageProxy;
}

export interface ScheduleRecordingInput {
	channelId: string;
	title: string;
	/** Absolute start time (ISO or Date). */
	start: Date;
	/** Absolute end time, strictly after `start`. */
	end: Date;
	programId?: string | undefined;
	/** Set when the row was created by the series-rule evaluator. */
	seriesRuleId?: string | undefined;
	/** Opt-out from automatic `keepCount` eviction. */
	manuallyProtected?: boolean | undefined;
}

export interface ScheduleByProgramInput {
	programId: string;
	/** Preferred tuner variant when an EPG channel has multiple mappings. */
	channelId?: string;
}

/** Explicit schedule outcome returned by the by-program API. */
export type ScheduleByProgramResult = CreateScheduledRecordingResult;

/**
 * Coordinates the lifecycle of a one-off recording: persists the row,
 * schedules a one-off scheduler job at `start - paddingBefore`, runs an
 * ffmpeg recording when the job fires (acquiring a tuner lease via the
 * allocator), and tears down cleanly on cancel / completion / failure.
 *
 * Each state transition emits a typed WS event on the `recordings`
 * topic. In-progress sessions are tracked in-process so the cancel API
 * can stop ffmpeg cleanly.
 */
export class RecordingsService {
	private readonly repository: RecordingsRepository;
	private readonly scheduler: Scheduler;
	private readonly allocator: TunerAllocator;
	private readonly resolver: StreamSourceResolver;
	private readonly config: RecordingsConfigResolver;
	private readonly epgPrograms: EpgProgramsRepository | undefined;
	private readonly channelEpgMap:
		| Pick<ChannelEpgMapRepository, "getByChannelId" | "getByEpgChannelId">
		| undefined;
	private readonly seriesRules: SeriesRulesRepository | undefined;
	private readonly bus: EventBus | undefined;
	private readonly runner: RecordingRunner | undefined;
	private readonly directoryProbe: RecordingDirectoryProbe;
	private readonly now: () => Date;
	private readonly logger: RecordingsLogger;
	private readonly playback: RecordingPlaybackService;
	private readonly commercialAnalysis: CommercialAnalysisService | undefined;
	private readonly artworkProxy: RemoteImageProxy;

	/** Recording id -> live in-flight session. */
	private readonly inFlight = new Map<
		string,
		{ session: RecordingSession; releaseLease: () => void }
	>();
	/** Covers pre-FFmpeg work so duplicate scheduler rows cannot overlap. */
	private readonly attemptsInFlight = new Set<string>();
	/** Closes the brief transition-to-recording race before a session is stored. */
	private readonly cancellationRequested = new Set<string>();

	/** Detach hook from `attachLibraryMaintenance()`. */
	private libraryMaintenanceUnsubscribe: (() => void) | undefined;

	constructor(options: RecordingsServiceOptions) {
		this.repository = options.repository;
		this.scheduler = options.scheduler;
		this.allocator = options.allocator;
		this.resolver = options.resolver;
		this.config = options.config;
		this.epgPrograms = options.epgPrograms;
		this.channelEpgMap = options.channelEpgMap;
		this.seriesRules = options.seriesRules;
		this.bus = options.bus;
		this.runner = options.runner;
		this.directoryProbe =
			options.directoryProbe ?? assertRecordingDirectoryWritable;
		this.now = options.now ?? (() => new Date());
		this.logger = options.logger ?? noopLogger;
		this.commercialAnalysis = options.commercialAnalysis;
		this.artworkProxy =
			options.artworkProxy ?? new RemoteImageProxy({ logger: this.logger });
		this.playback =
			options.playbackService ??
			new RecordingPlaybackService({
				repository: options.repository,
				...(options.bus ? { bus: options.bus } : {}),
				...(options.logger ? { logger: options.logger } : {}),
				...(options.playbackOptions ?? {})
			});

		this.scheduler.registerOneOffHandler(RECORDING_JOB_KIND, async (ctx) =>
			this.runRecording(ctx)
		);
	}

	/** Number of currently in-flight (actively recording) sessions. */
	getActiveRecordingCount(): number {
		return this.inFlight.size;
	}

	/** Snapshot active recording FFmpeg work without exposing output paths. */
	async getActiveFfmpegWork(): Promise<
		Array<{
			recordingId: string;
			title: string;
			kind: "recording" | "recording-playback";
			state: string;
			startedAt: string;
			playbackSessionId?: string;
			profile?: string;
			hwaccel?: string | null;
			clientCount?: number;
			pipelineSpeed?: number | null;
		}>
	> {
		const captures = await Promise.all(
			[...this.inFlight.entries()].map(async ([recordingId, entry]) => {
				const recording = await this.repository.getById(recordingId);
				return {
					recordingId,
					title: recording?.title ?? `Recording ${recordingId}`,
					kind: "recording" as const,
					state: "recording",
					startedAt: entry.session.startedAt.toISOString()
				};
			})
		);
		const playbacks = await Promise.all(
			this.playback.getActiveSessions().map(async (session) => {
				const recording = await this.repository.getById(session.recordingId);
				return {
					...session,
					title: recording?.title ?? `Recording ${session.recordingId}`,
					kind: "recording-playback" as const
				};
			})
		);
		return [...captures, ...playbacks];
	}

	/** Stop one advanced-mode playback process without affecting sibling viewers. */
	stopPlayback(playbackSessionId: string): boolean {
		return this.playback.stopSession(playbackSessionId);
	}

	/**
	 * Persist a new recording (status=`scheduled`) and arm the scheduler
	 * to fire at `start - paddingBefore`. A supplied program id makes the
	 * operation idempotent across concurrent callers.
	 */
	async schedule(input: ScheduleRecordingInput): Promise<RecordingRecord> {
		const result = await this.scheduleWithResult(input);
		return result.recording;
	}

	/** Persist the recording row and scheduler job in one transaction. */
	private async scheduleWithResult(
		input: ScheduleRecordingInput
	): Promise<CreateScheduledRecordingResult> {
		if (input.end.getTime() <= input.start.getTime()) {
			throw new Error("`end` must be strictly after `start`");
		}
		const config = await this.config.resolve();
		const episodeSnapshot = await this.loadEpisodeSnapshot(input.programId);
		const runAt = new Date(
			input.start.getTime() - config.paddingBeforeSec * 1000
		);
		const result = await this.scheduler.schedulePersistedOneOff(() =>
			this.repository.createScheduledWithJob({
				channelId: input.channelId,
				...(input.programId !== undefined
					? { programId: input.programId }
					: {}),
				title: input.title,
				scheduledStart: input.start,
				scheduledEnd: input.end,
				jobKind: RECORDING_JOB_KIND,
				runAt,
				maxAttempts: RECORDING_MAX_ATTEMPTS,
				...(input.seriesRuleId !== undefined
					? { seriesRuleId: input.seriesRuleId }
					: {}),
				...(input.manuallyProtected !== undefined
					? { manuallyProtected: input.manuallyProtected }
					: {}),
				...(episodeSnapshot ? { episodeSnapshot } : {})
			})
		);

		if (result.created) {
			this.publish(RECORDING_EVENT.scheduled, result.recording);
		}
		return result;
	}

	/**
	 * Schedule a recording for a specific EPG program. The channel is
	 * resolved via the channel ↔ EPG mapping (issue rrainn/SignalHaven#17), and
	 * the recording row stays linked to `programId` so episode metadata
	 * can be applied to the resulting file. Throws
	 * {@link EpgProgramNotFoundError} when the program id is unknown and
	 * {@link ChannelNotMappedError} when the program's EPG channel has no
	 * mapped tuner channel (the HTTP layer translates that to a 409).
	 */
	async scheduleByProgram(
		input: ScheduleByProgramInput
	): Promise<ScheduleByProgramResult> {
		if (!this.epgPrograms || !this.channelEpgMap) {
			throw new Error(
				"RecordingsService is not configured with EPG dependencies"
			);
		}
		const program = await this.epgPrograms.getById(input.programId);
		if (!program) {
			throw new EpgProgramNotFoundError(input.programId);
		}
		if (program.stop.getTime() <= this.now().getTime()) {
			throw new ProgramNotRecordableError(program.id);
		}
		const mapping = input.channelId
			? await this.channelEpgMap.getByChannelId(input.channelId)
			: await this.channelEpgMap.getByEpgChannelId(program.epgChannelId);
		if (!mapping || mapping.epgChannelId !== program.epgChannelId) {
			throw new ChannelNotMappedError(program.epgChannelId);
		}
		return this.scheduleWithResult({
			channelId: mapping.channelId,
			title: program.title,
			start: program.start,
			end: program.stop,
			programId: program.id
		});
	}

	async list(): Promise<RecordingRecord[]> {
		return this.repository.list();
	}

	/**
	 * Filtered + paginated listing for `GET /api/v1/recordings`. Limits
	 * are clamped server-side (default 50, max 200) so a misbehaving
	 * client can't ask the DB to materialise an unbounded result set.
	 */
	async listPage(query: RecordingListQuery): Promise<
		Omit<RecordingListPage, "hasMore" | "items"> & {
			items: Array<RecordingRecord & { metadata: RecordingMetadata | null }>;
			nextCursor: string | null;
		}
	> {
		const cursor = query.cursor
			? decodeRecordingCursor(query.cursor, query.sort, query.direction)
			: undefined;
		const page = await this.repository.listPage({
			...(query.search ? { search: query.search } : {}),
			...(query.status !== undefined ? { status: query.status } : {}),
			...(query.channelId !== undefined ? { channelId: query.channelId } : {}),
			...(query.seriesRuleId !== undefined
				? { seriesRuleId: query.seriesRuleId }
				: {}),
			...(query.from ? { from: new Date(query.from) } : {}),
			...(query.to ? { to: new Date(query.to) } : {}),
			limit: query.limit,
			offset: query.offset,
			...(cursor ? { cursor } : {}),
			sort: query.sort,
			direction: query.direction
		});
		const last = page.items[page.items.length - 1];
		const nextCursor =
			page.hasMore && last
				? encodeRecordingCursor(last, query.sort, query.direction)
				: null;
		const metadataByProgramId = await this.loadMetadataByProgramId(page.items);
		const { hasMore: _hasMore, items, ...result } = page;
		return {
			...result,
			items: items.map((record) => {
				const currentMetadata = record.programId
					? (metadataByProgramId.get(record.programId) ?? null)
					: null;
				return {
					...record,
					metadata: mergeRecordingMetadata(
						toSnapshotMetadata(record),
						currentMetadata
					)
				};
			}),
			nextCursor
		};
	}

	async getById(id: string): Promise<RecordingRecord> {
		const row = await this.repository.getById(id);
		if (!row) {
			throw new RecordingNotFoundError(id);
		}
		return row;
	}

	/** Fetch recording artwork through the backend-owned bounded image cache. */
	async getArtwork(id: string): Promise<ProxiedImage | null> {
		const record = await this.getById(id);
		const metadata = await this.loadMetadata(record);
		if (!metadata?.artworkUrl) return null;
		return this.artworkProxy.get(id, metadata.artworkUrl);
	}

	/** Prepare or reuse a VOD session and return its HLS media playlist. */
	async getPlaybackManifest(
		id: string,
		context: { requestId?: string } = {},
		startSeconds = 0,
		viewerId?: string
	): Promise<string> {
		return this.playback.getManifest(id, context, startSeconds, viewerId);
	}

	/** Read a segment from the exact opaque session referenced by the manifest. */
	async getPlaybackSegment(
		id: string,
		sessionId: string,
		segment: string,
		viewerId?: string
	): Promise<Buffer> {
		return this.playback.getSegment(id, sessionId, segment, viewerId);
	}

	/** Release one recording viewer after navigation or tab closure. */
	releasePlaybackViewer(id: string, viewerId: string): boolean {
		return this.playback.releaseViewer(id, viewerId);
	}

	/** Number of active or starting recording playback sessions. */
	getActivePlaybackSessionCount(): number {
		return this.playback.getActiveSessionCount();
	}

	/** Number of recording-playback FFmpeg child processes still running. */
	getRunningPlaybackProcessCount(): number {
		return this.playback.getRunningProcessCount();
	}

	/** Graceful-shutdown hook for FFmpeg processes and temporary HLS files. */
	async stopPlaybackSessions(): Promise<void> {
		await this.playback.stopAll();
	}

	/**
	 * `GET /api/v1/recordings/:id` detail lookup. Bundles EPG-derived
	 * metadata (subtitle, description, season/episode, categories,
	 * artwork) when the recording is linked to an EPG program and the
	 * program row still exists. The metadata block is `null` for
	 * one-off recordings or when the originating program has been
	 * pruned out of the EPG feed.
	 */
	async getDetailById(id: string): Promise<{
		record: RecordingRecord;
		metadata: RecordingMetadata | null;
		commercialAnalysis: CommercialAnalysis;
	}> {
		const record = await this.getById(id);
		const [metadata, commercialAnalysis] = await Promise.all([
			this.loadMetadata(record),
			this.commercialAnalysis?.get(id) ??
				Promise.resolve(notRequestedAnalysis())
		]);
		return { record, metadata, commercialAnalysis };
	}

	/** Re-run commercial detection for completed media without changing playback. */
	async retryCommercialAnalysis(id: string): Promise<CommercialAnalysis> {
		await this.getById(id);
		if (!this.commercialAnalysis) {
			throw new Error("Commercial analysis is not configured");
		}
		return this.commercialAnalysis.retry(id);
	}

	private async loadMetadata(
		record: RecordingRecord
	): Promise<RecordingMetadata | null> {
		const snapshot = toSnapshotMetadata(record);
		if (snapshot?.artworkUrl) return snapshot;
		if (!record.programId || !this.epgPrograms) {
			return snapshot;
		}
		const program = await this.epgPrograms.getById(record.programId);
		if (!program) {
			return snapshot;
		}
		return mergeRecordingMetadata(snapshot, toRecordingMetadata(program));
	}

	/** Copy guide metadata before the broadcast row can be pruned. */
	private async loadEpisodeSnapshot(
		programId: string | undefined
	): Promise<RecordingEpisodeSnapshot | null> {
		if (!programId || !this.epgPrograms) return null;
		const program = await this.epgPrograms.getById(programId);
		if (!program) return null;
		return {
			identityKey: program.episodeIdentityKey ?? null,
			subtitle: program.subtitle ?? null,
			description: program.description ?? null,
			season: program.season ?? null,
			episode: program.episode ?? null,
			categories: program.categories ?? [],
			artworkUrl: program.artworkUrl ?? null,
			originalAirDate: program.originalAirDate ?? null
		};
	}

	/** Batch the metadata projection for one already-bounded recordings page. */
	private async loadMetadataByProgramId(
		records: RecordingRecord[]
	): Promise<Map<string, RecordingMetadata>> {
		if (!this.epgPrograms) {
			return new Map();
		}
		const programIds = [
			...new Set(
				records.flatMap((record) =>
					record.programId ? [record.programId] : []
				)
			)
		];
		if (programIds.length === 0) {
			return new Map();
		}
		const programs = await this.epgPrograms.listByIds(programIds);
		return new Map(
			programs.map((program) => [program.id, toRecordingMetadata(program)])
		);
	}

	/**
	 * Cancel a recording. If still `scheduled`, transitions to
	 * `cancelled` (the eventual scheduler tick is a no-op). If currently
	 * `recording`, terminates ffmpeg cleanly; the run loop transitions
	 * the row to `cancelled` once the process settles.
	 */
	async cancel(id: string): Promise<RecordingRecord> {
		const row = await this.repository.getById(id);
		if (!row) {
			throw new RecordingNotFoundError(id);
		}

		if (row.status === "scheduled") {
			const updated = await this.repository.cancelScheduled(id);
			if (updated) {
				this.publish(RECORDING_EVENT.cancelled, updated);
				return updated;
			}
			// Lost a race; fall through and re-read.
			return (await this.repository.getById(id)) ?? row;
		}

		if (row.status === "recording") {
			const inFlight = this.inFlight.get(id);
			if (inFlight) {
				inFlight.session.stop();
			} else {
				this.cancellationRequested.add(id);
			}
			if (row.schedulerJobId) {
				await this.scheduler.cancelOneOff(row.schedulerJobId);
			}
			// The session's run loop will transition the DB row + emit the
			// `cancelled` event when the process settles. Return the latest
			// snapshot for the caller; it may still show `recording` if the
			// process hasn't exited yet.
			return (await this.repository.getById(id)) ?? row;
		}

		// Already terminal: idempotent no-op.
		return row;
	}

	/**
	 * Crash recovery: any rows still marked `recording` at boot belong to
	 * a previous process; flip them to `failed` and emit the event.
	 */
	async recoverOnStartup(): Promise<void> {
		const ids = await this.repository.recoverInProgress(
			RECORDING_FAILED_PROCESS_TERMINATED
		);
		for (const id of ids) {
			const row = await this.repository.getById(id);
			if (row) {
				this.publish(RECORDING_EVENT.failed, row);
			}
		}
		await this.commercialAnalysis?.reconcileCompleted();
	}

	/**
	 * Ensure every still-`scheduled` recording has an active one-off job.
	 * Persisted pending/running jobs are reused; only missing or terminal jobs
	 * are replaced. Called once at startup before the scheduler begins work.
	 */
	async resumeScheduledOnStartup(): Promise<void> {
		const config = await this.config.resolve().catch(() => null);
		if (!config) {
			return;
		}
		const rows = await this.repository.listByStatuses(["scheduled"]);
		for (const row of rows) {
			const runAt = new Date(
				row.scheduledStart.getTime() - config.paddingBeforeSec * 1000
			);
			const jobId = await this.scheduler.ensureOneOffScheduled(
				{
					kind: RECORDING_JOB_KIND,
					runAt,
					payload: { recordingId: row.id },
					maxAttempts: RECORDING_MAX_ATTEMPTS
				},
				row.schedulerJobId
			);
			if (jobId !== row.schedulerJobId) {
				const updated = await this.repository.updateScheduled(row.id, {
					schedulerJobId: jobId
				});
				if (!updated) {
					// Cancellation won after the startup snapshot; do not leave the
					// replacement job armed for a terminal recording.
					await this.scheduler.cancelOneOff(jobId);
				}
			}
		}
	}

	/**
	 * Reconcile scheduled recordings against the latest EPG state. For
	 * every `scheduled` recording linked to an EPG program, refetch the
	 * program and — if its start/stop have shifted — cancel the old
	 * scheduler job, update the recording's `scheduledStart` /
	 * `scheduledEnd`, arm a fresh scheduler job at the new run-at, and
	 * emit a `recording.rescheduled` event. Programs that no longer
	 * exist (pruned out of the feed) are left alone so the user can
	 * cancel manually if desired.
	 *
	 * Designed to be called automatically after a successful EPG refresh.
	 * No-op when no EPG dependencies were wired in.
	 */
	async reconcileProgramSchedules(): Promise<{ rescheduled: number }> {
		if (!this.epgPrograms) {
			return { rescheduled: 0 };
		}
		const config = await this.config.resolve().catch(() => null);
		if (!config) {
			return { rescheduled: 0 };
		}
		const rows = await this.repository.listScheduledWithProgram();
		let rescheduled = 0;
		for (const row of rows) {
			// `listScheduledWithProgram` already filters to rows where
			// `program_id IS NOT NULL`, so this is a narrowing aid rather
			// than a defensive runtime check.
			const programId = row.programId;
			if (!programId) continue;
			const program = await this.epgPrograms.getById(programId);
			if (!program) continue;
			const startChanged =
				program.start.getTime() !== row.scheduledStart.getTime();
			const endChanged = program.stop.getTime() !== row.scheduledEnd.getTime();
			if (!startChanged && !endChanged) continue;

			// Cancel the previously-armed job so the recording doesn't fire
			// at the stale time. Best-effort: a cancel race (already running
			// or already cancelled) is fine — the new job + the row's status
			// gate in `runRecording` keeps things idempotent.
			if (row.schedulerJobId) {
				try {
					await this.scheduler.cancelOneOff(row.schedulerJobId);
				} catch {
					/* ignore */
				}
			}

			const runAt = new Date(
				program.start.getTime() - config.paddingBeforeSec * 1000
			);
			const jobId = await this.scheduler.scheduleOneOff({
				kind: RECORDING_JOB_KIND,
				runAt,
				payload: { recordingId: row.id },
				maxAttempts: RECORDING_MAX_ATTEMPTS
			});

			const updated = await this.repository.updateScheduled(row.id, {
				scheduledStart: program.start,
				scheduledEnd: program.stop,
				schedulerJobId: jobId
			});
			if (updated) {
				rescheduled += 1;
				this.publish(RECORDING_EVENT.rescheduled, updated);
			} else {
				// A cancel may have landed while the new EPG job was being armed.
				await this.scheduler.cancelOneOff(jobId);
			}
		}
		return { rescheduled };
	}

	// ---------- library management ----------

	/**
	 * Permanently delete a recording (`DELETE /api/v1/recordings/:id`).
	 * Drops the DB row, then removes the on-disk file unless `keepFile` is
	 * set. If the recording is still in `scheduled` or `recording`,
	 * it is cancelled first so we don't tear down a row out from under
	 * an in-flight ffmpeg process.
	 *
	 * Idempotent at the row level: a second call after the row has been
	 * removed throws {@link RecordingNotFoundError}, matching `getById`.
	 */
	async delete(
		id: string,
		options: {
			keepFile?: boolean;
			overrideProtection?: boolean;
		} = {}
	): Promise<void> {
		const row = await this.repository.getById(id);
		if (!row) {
			throw new RecordingNotFoundError(id);
		}
		if (row.manuallyProtected && !options.overrideProtection) {
			throw new RecordingProtectedError(id);
		}
		if (row.status === "scheduled" || row.status === "recording") {
			// Stop any in-flight session + cancel the scheduler row before
			// we delete the DB row (otherwise ffmpeg might still write to a
			// file we just removed).
			await this.cancel(id);
		}
		await this.commercialAnalysis?.cancel(id);
		// Hide the row first so a concurrent manifest request cannot create a
		// replacement session while the existing playback work is stopping.
		const deleted = await this.repository.delete(id);
		await this.playback.stop(id);
		if (!options.keepFile && row.filePath) {
			await this.removeRecordingMedia(row.filePath);
		}
		if (deleted) {
			this.publish(RECORDING_EVENT.deleted, deleted);
		}
	}

	/**
	 * Patch a recording's library bookkeeping fields. Drives the player's
	 * mark-as-watched + resume-position state and the user's `protect`
	 * toggle. Returns the updated row.
	 */
	async patch(
		id: string,
		patch: {
			watched?: boolean;
			watchedAt?: string | Date | null;
			resumePositionSeconds?: number | null;
			manuallyProtected?: boolean;
		}
	): Promise<RecordingRecord> {
		const existing = await this.repository.getById(id);
		if (!existing) {
			throw new RecordingNotFoundError(id);
		}
		const update: UpdateRecordingInput = {};
		if (patch.watched !== undefined) {
			update.watchedAt = patch.watched ? this.now() : null;
		} else if (patch.watchedAt !== undefined) {
			update.watchedAt =
				patch.watchedAt === null ? null : new Date(patch.watchedAt);
		}
		if (patch.resumePositionSeconds !== undefined) {
			update.resumePositionSeconds = patch.resumePositionSeconds;
		}
		if (patch.manuallyProtected !== undefined) {
			update.manuallyProtected = patch.manuallyProtected;
		}
		const updated = await this.repository.update(id, update);
		if (!updated) {
			throw new RecordingNotFoundError(id);
		}
		return updated;
	}

	/**
	 * Walk the recordings root and reconcile it against the DB:
	 *
	 *   * `missingFiles` — DB rows whose `file_path` no longer exists
	 *     on disk. Their `file_size` is cleared and an `error_message`
	 *     is set so the UI can flag them.
	 *   * `orphanFiles` — files in the recordings dir that no DB row
	 *     references. They are left on disk (we never delete files we
	 *     don't recognise) but counted so an operator can investigate.
	 *   * `resized` — completed rows whose persisted `file_size` no
	 *     longer matches the actual on-disk size; the row is updated.
	 *
	 * No-op when storage isn't configured.
	 */
	async scanLibrary(): Promise<{
		missingFiles: number;
		orphanFiles: number;
		resized: number;
		scanned: number;
	}> {
		const config = await this.config.resolve().catch(() => null);
		if (!config) {
			return { missingFiles: 0, orphanFiles: 0, resized: 0, scanned: 0 };
		}
		const baseDir = resolve(config.recordingsDir);
		const rows = await this.repository.listWithFilePath();
		const knownPaths = new Set<string>();

		let missingFiles = 0;
		let resized = 0;
		let scanned = 0;

		for (const row of rows) {
			if (!row.filePath) continue;
			const absolute = resolve(row.filePath);
			knownPaths.add(absolute);
			scanned += 1;
			let stats;
			try {
				stats = await stat(absolute);
			} catch {
				// File vanished out from under the row.
				missingFiles += 1;
				await this.repository.update(row.id, {
					fileSize: null,
					errorMessage: "file_missing"
				});
				continue;
			}
			const storedSize =
				stats.size + (await recordingPlaybackCacheSize(absolute));
			if (
				row.status === "completed" &&
				stats.size > 0 &&
				row.fileSize !== storedSize
			) {
				await this.repository.update(row.id, { fileSize: storedSize });
				resized += 1;
			}
		}

		let orphanFiles = 0;
		try {
			const entries = await readdir(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const candidate = resolve(join(baseDir, entry.name));
				if (!knownPaths.has(candidate)) {
					orphanFiles += 1;
				}
			}
		} catch {
			// Directory missing or unreadable; treat as no orphans.
		}

		return { missingFiles, orphanFiles, resized, scanned };
	}

	/**
	 * If the configured `quotaBytes` is exceeded by the sum of completed
	 * `file_size`, evict oldest non-`manuallyProtected` recordings (file
	 * + DB row) until the library fits. No-op when no quota is set or
	 * the library is already under the limit. Returns the number of
	 * rows deleted.
	 */
	async enforceStorageQuota(): Promise<{ deleted: number }> {
		const config = await this.config.resolve().catch(() => null);
		const quota = config?.quotaBytes ?? null;
		if (!quota || quota <= 0) {
			return { deleted: 0 };
		}
		let total = await this.repository.sumCompletedSize();
		if (total <= quota) {
			return { deleted: 0 };
		}
		const candidates = await this.repository.listEvictionCandidates();
		let deleted = 0;
		for (const victim of candidates) {
			if (total <= quota) break;
			const size = victim.fileSize ?? 0;
			// Remove discoverability before stopping readers to close the same
			// manifest-creation race as an explicit library deletion.
			const removed = await this.repository.delete(victim.id);
			await this.playback.stop(victim.id);
			if (victim.filePath) {
				await this.removeRecordingMedia(victim.filePath);
			}
			if (removed) {
				this.publish(RECORDING_EVENT.deleted, removed);
				deleted += 1;
				total -= size;
			}
		}
		return { deleted };
	}

	/**
	 * Apply per-series retention windows: any completed, non-protected
	 * recording produced by a rule with `retentionDays` set is deleted
	 * once its `actualEnd` (or `scheduledEnd` fallback) is older than
	 * `retentionDays` days. Independent of `keepCount`. No-op when no
	 * series-rule repository was wired in.
	 */
	async enforceRetention(): Promise<{ deleted: number }> {
		if (!this.seriesRules) {
			return { deleted: 0 };
		}
		const rules = await this.seriesRules.list();
		const ruleByRetention = rules.filter(
			(rule) => rule.retentionDays !== null && rule.retentionDays > 0
		);
		if (ruleByRetention.length === 0) {
			return { deleted: 0 };
		}
		const candidates = await this.repository.listEvictionCandidates();
		const now = this.now();
		let deleted = 0;
		for (const victim of candidates) {
			if (!victim.seriesRuleId) continue;
			const rule = ruleByRetention.find((r) => r.id === victim.seriesRuleId);
			if (!rule || rule.retentionDays === null) continue;
			const reference = victim.actualEnd ?? victim.scheduledEnd;
			const ageMs = now.getTime() - reference.getTime();
			const limitMs = rule.retentionDays * 86_400_000;
			if (ageMs <= limitMs) continue;
			// Remove discoverability before stopping readers to prevent a new VOD
			// session from racing retention cleanup.
			const removed = await this.repository.delete(victim.id);
			await this.playback.stop(victim.id);
			if (victim.filePath) {
				await this.removeRecordingMedia(victim.filePath);
			}
			if (removed) {
				this.publish(RECORDING_EVENT.deleted, removed);
				deleted += 1;
			}
		}
		return { deleted };
	}

	/** Remove the source and its derived HLS cache as one owned media unit. */
	private async removeRecordingMedia(filePath: string): Promise<void> {
		await Promise.all([
			rm(filePath, { force: true }).catch(() => undefined),
			rm(recordingPlaybackCachePath(filePath), {
				recursive: true,
				force: true
			}).catch(() => undefined)
		]);
	}

	/**
	 * Subscribe to the `recordings` topic so quota + retention
	 * enforcement runs automatically every time a recording finishes
	 * (i.e. as soon as new bytes have hit the disk). Idempotent. Detach
	 * via the returned function.
	 */
	attachLibraryMaintenance(): () => void {
		if (!this.bus) {
			return () => undefined;
		}
		if (this.libraryMaintenanceUnsubscribe) {
			return this.libraryMaintenanceUnsubscribe;
		}
		const detach = this.bus.subscribe("recordings", (event) => {
			if (event.event !== RECORDING_EVENT.completed) return;
			void this.enforceStorageQuota().catch(() => undefined);
			void this.enforceRetention().catch(() => undefined);
		});
		this.libraryMaintenanceUnsubscribe = () => {
			this.libraryMaintenanceUnsubscribe = undefined;
			detach();
		};
		return this.libraryMaintenanceUnsubscribe;
	}

	// ---------- internals ----------

	private async runRecording(context: JobContext): Promise<void> {
		const recordingId = String(context.payload["recordingId"] ?? "");
		if (!recordingId) {
			throw new Error("recording job payload missing `recordingId`");
		}

		if (this.attemptsInFlight.has(recordingId)) {
			this.logger.debug(
				{ recordingId, attempt: context.attempt },
				"Skipped overlapping recording attempt"
			);
			return;
		}

		this.attemptsInFlight.add(recordingId);
		try {
			await this.runRecordingAttempt(recordingId, context);
		} finally {
			this.attemptsInFlight.delete(recordingId);
			this.cancellationRequested.delete(recordingId);
		}
	}

	/** Execute one scheduler attempt without carrying tuner state across retries. */
	private async runRecordingAttempt(
		recordingId: string,
		context: JobContext
	): Promise<void> {
		const row = await this.repository.getById(recordingId);
		if (!row) {
			// Nothing to do — the row was deleted out from under us.
			return;
		}
		// The user may have cancelled before this persisted job was dispatched;
		// the row remains the authoritative gate even when a stale tick exists.
		if (row.status !== "scheduled" || context.signal.aborted) {
			return;
		}

		let config: Awaited<ReturnType<RecordingsConfigResolver["resolve"]>>;
		try {
			config = await this.config.resolve();
		} catch (error) {
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_CONFIGURATION,
				error
			);
			return;
		}

		const cutoff = new Date(
			row.scheduledEnd.getTime() + config.paddingAfterSec * 1_000
		);
		const initialRemainingMs = cutoff.getTime() - this.now().getTime();
		if (initialRemainingMs <= 0) {
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_MISSED_WINDOW
			);
			return;
		}

		this.logger.info(
			this.recordingLogContext(row, context, cutoff, initialRemainingMs),
			"Starting recording attempt"
		);

		let outputPath: string;
		try {
			outputPath = await this.prepareOutputPath(
				config.recordingsDir,
				row.title,
				row.scheduledStart
			);
		} catch (error) {
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_CONFIGURATION,
				error,
				cutoff
			);
			return;
		}

		let sources: ResolvedStreamSource[];
		try {
			sources = this.resolver.resolveCandidates
				? await this.resolver.resolveCandidates(row.channelId)
				: [await this.resolver.resolve(row.channelId)];
			if (sources.length === 0) {
				throw new ChannelNotStreamableError(row.channelId);
			}
		} catch (error) {
			if (isPermanentSourceFailure(error)) {
				await this.failScheduledAttempt(
					row,
					context,
					RECORDING_FAILED_SOURCE_CONFIGURATION,
					error,
					cutoff
				);
				return;
			}
			await this.retryTransientAttempt(row, context, cutoff, error);
			return;
		}

		if (await this.wasCancelled(recordingId, context.signal)) {
			return;
		}

		// Source resolution can involve provider I/O, so refresh the absolute
		// window immediately before asking the allocator for a tuner.
		const beforeAllocationMs = cutoff.getTime() - this.now().getTime();
		if (beforeAllocationMs <= 0) {
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_MISSED_WINDOW,
				undefined,
				cutoff
			);
			return;
		}

		let source: ResolvedStreamSource | undefined;
		let lease;
		let allocationError: unknown;
		for (const candidate of sources) {
			try {
				lease = await this.allocator.acquire({
					providerId: candidate.providerId,
					channelId: candidate.providerChannelId,
					purpose: "record",
					// Recordings always outrank live leases on every fallback source.
					priority: 0
				});
				source = candidate;
				break;
			} catch (error) {
				allocationError = error;
			}
		}
		if (!source || !lease) {
			const error = allocationError;
			if (
				error instanceof TunerNotFoundError ||
				error instanceof UnsupportedTunerKindError
			) {
				await this.failScheduledAttempt(
					row,
					context,
					RECORDING_FAILED_SOURCE_CONFIGURATION,
					error,
					cutoff
				);
				return;
			}
			await this.retryTransientAttempt(row, context, cutoff, error);
			return;
		}
		if (source.sourceChannelId) {
			await this.repository.update(recordingId, {
				sourceChannelId: source.sourceChannelId
			});
		}

		let leaseReleased = false;
		const releaseLease = (): void => {
			if (leaseReleased) {
				return;
			}
			leaseReleased = true;
			this.allocator.release(lease.leaseId);
		};

		if (await this.wasCancelled(recordingId, context.signal)) {
			releaseLease();
			return;
		}

		// Allocator queues are asynchronous. Recompute just before FFmpeg so a
		// contended tuner can never extend a recording beyond its fixed cutoff.
		const startedAt = this.now();
		const remainingMs = cutoff.getTime() - startedAt.getTime();
		if (remainingMs <= 0) {
			releaseLease();
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_MISSED_WINDOW,
				undefined,
				cutoff
			);
			return;
		}
		const plannedDurationSeconds = remainingMs / 1_000;
		const startReason: RecordingStartReason | null =
			startedAt.getTime() - row.scheduledStart.getTime() > LATE_START_GRACE_MS
				? "late_start"
				: null;
		const transitioned = await this.repository.transitionStatus(
			recordingId,
			"scheduled",
			{
				status: "recording",
				actualStart: startedAt,
				startReason,
				errorMessage: null,
				filePath: outputPath
			}
		);
		if (!transitioned) {
			// Cancel happened between the status check above and this update.
			releaseLease();
			return;
		}
		this.publish(RECORDING_EVENT.started, transitioned);

		let session: RecordingSession;
		try {
			session = new RecordingSession({
				upstreamUrl: source.upstreamUrl,
				outputPath,
				durationSeconds: plannedDurationSeconds,
				...(this.runner ? { runner: this.runner } : {})
			});
		} catch (error) {
			releaseLease();
			const failed = await this.repository.transitionStatus(
				recordingId,
				"recording",
				{
					status: "failed",
					actualEnd: this.now(),
					errorMessage: errorMessage(error)
				}
			);
			if (failed) {
				this.publish(RECORDING_EVENT.failed, failed);
				this.logTerminal(failed, context, cutoff, "ffmpeg_start_failed", error);
			}
			throw new NonRetryableJobError("ffmpeg_start_failed", error);
		}

		this.inFlight.set(recordingId, { session, releaseLease });
		if (context.signal.aborted || this.cancellationRequested.has(recordingId)) {
			session.stop();
		}
		let outcome;
		try {
			outcome = await session.done();
		} finally {
			this.inFlight.delete(recordingId);
			releaseLease();
		}

		const endedAt = this.now();
		const fileSize = await RecordingSession.readFileSize(outputPath);
		const actualDurationSeconds = Math.max(
			0,
			Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
		);

		if (outcome.kind === "completed") {
			const updated = await this.repository.transitionStatus(
				recordingId,
				"recording",
				{
					status: "completed",
					actualEnd: endedAt,
					fileSize,
					durationSeconds: actualDurationSeconds
				}
			);
			if (updated) {
				this.publish(RECORDING_EVENT.completed, updated);
				this.logTerminal(updated, context, cutoff, "completed");
				void this.commercialAnalysis
					?.enqueueCompleted(updated)
					.catch((error) =>
						this.logger.warn(
							{ recordingId, error: errorMessage(error) },
							"Commercial analysis could not be queued"
						)
					);
			}
			return;
		}

		if (outcome.kind === "cancelled") {
			const updated = await this.repository.transitionStatus(
				recordingId,
				"recording",
				{
					status: "cancelled",
					actualEnd: endedAt,
					fileSize,
					durationSeconds: actualDurationSeconds
				}
			);
			if (updated) {
				this.publish(RECORDING_EVENT.cancelled, updated);
				this.logTerminal(updated, context, cutoff, "cancelled");
			}
			return;
		}

		const failed = await this.repository.transitionStatus(
			recordingId,
			"recording",
			{
				status: "failed",
				actualEnd: endedAt,
				fileSize,
				durationSeconds: actualDurationSeconds,
				errorMessage: outcome.error
			}
		);
		if (failed) {
			this.publish(RECORDING_EVENT.failed, failed);
			this.logTerminal(failed, context, cutoff, "ffmpeg_failed", outcome.error);
		}
		// A failed FFmpeg attempt may have produced a partial file. Retrying into
		// that path is unsafe, so the scheduler must keep this terminal.
		throw new NonRetryableJobError(outcome.error);
	}

	/** True when cancellation or another terminal transition won the race. */
	private async wasCancelled(
		recordingId: string,
		signal: AbortSignal
	): Promise<boolean> {
		if (signal.aborted || this.cancellationRequested.has(recordingId)) {
			return true;
		}
		const latest = await this.repository.getById(recordingId);
		return latest?.status !== "scheduled";
	}

	/** Keep transient failures scheduled only when the next retry is useful. */
	private async retryTransientAttempt(
		row: RecordingRecord,
		context: JobContext,
		cutoff: Date,
		error: unknown
	): Promise<void> {
		if (await this.wasCancelled(row.id, context.signal)) {
			return;
		}

		const nextRetryAt = context.nextRetryAt;
		if (!nextRetryAt) {
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_RETRIES_EXHAUSTED,
				error,
				cutoff
			);
			return;
		}
		if (cutoff.getTime() - nextRetryAt.getTime() < MIN_MEANINGFUL_CAPTURE_MS) {
			await this.failScheduledAttempt(
				row,
				context,
				RECORDING_FAILED_RETRY_WINDOW_EXHAUSTED,
				error,
				cutoff
			);
			return;
		}

		this.logger.warn(
			this.recordingLogContext(
				row,
				context,
				cutoff,
				cutoff.getTime() - this.now().getTime(),
				{
					nextRetryAt: nextRetryAt.toISOString(),
					error: errorMessage(error)
				}
			),
			"Recording attempt will retry"
		);
		throw error instanceof Error ? error : new Error(errorMessage(error));
	}

	/** Make a still-scheduled recording terminal and stop scheduler retries. */
	private async failScheduledAttempt(
		row: RecordingRecord,
		context: JobContext,
		reason: string,
		cause?: unknown,
		cutoff = row.scheduledEnd
	): Promise<void> {
		const updated = await this.repository.transitionStatus(
			row.id,
			"scheduled",
			{
				status: "failed",
				errorMessage: reason,
				actualEnd: this.now()
			}
		);
		if (!updated) {
			return;
		}
		this.publish(RECORDING_EVENT.failed, updated);
		this.logTerminal(updated, context, cutoff, reason, cause);
		throw new NonRetryableJobError(reason, cause);
	}

	/** Common structured fields keep recovery logs searchable and concise. */
	private recordingLogContext(
		row: RecordingRecord,
		context: JobContext,
		cutoff: Date,
		remainingMs: number,
		extra: Record<string, unknown> = {}
	): Record<string, unknown> {
		return {
			recordingId: row.id,
			scheduledStart: row.scheduledStart.toISOString(),
			scheduledEnd: row.scheduledEnd.toISOString(),
			cutoff: cutoff.toISOString(),
			attempt: context.attempt,
			maxAttempts: context.maxAttempts,
			remainingDurationSeconds: Math.max(0, remainingMs / 1_000),
			...extra
		};
	}

	/** Emit one terminal lifecycle log without per-segment noise. */
	private logTerminal(
		row: RecordingRecord,
		context: JobContext,
		cutoff: Date,
		terminalReason: string,
		cause?: unknown
	): void {
		const fields = this.recordingLogContext(
			row,
			context,
			cutoff,
			cutoff.getTime() - this.now().getTime(),
			{
				terminalReason,
				...(cause !== undefined ? { error: errorMessage(cause) } : {})
			}
		);
		if (terminalReason === "completed" || terminalReason === "cancelled") {
			this.logger.info(fields, "Recording attempt finished");
		} else {
			this.logger.error(fields, "Recording attempt failed");
		}
	}

	/**
	 * Build the absolute output path for a recording, ensuring the
	 * destination directory exists and that the resolved path stays
	 * inside `recordingsDir` (defence against weird titles smuggling
	 * `..` past the safe-title sanitizer).
	 */
	private async prepareOutputPath(
		recordingsDir: string,
		title: string,
		scheduledStart: Date
	): Promise<string> {
		const safeTitle = sanitizeFileNameComponent(title) || "recording";
		const startIso = scheduledStart
			.toISOString()
			.replace(/[:]/g, "-")
			// Strip the milliseconds (`.123Z` -> `Z`) so on-disk file names
			// are easier on the eye and shell-friendly across operating
			// systems.
			.replace(/\.\d{3}Z$/, "Z");
		const fileName = `${safeTitle}-${startIso}.mkv`;
		const baseDir = resolve(recordingsDir);
		const target = resolve(join(baseDir, fileName));
		if (
			target !== join(baseDir, fileName) ||
			!target.startsWith(baseDir + sep)
		) {
			throw new Error(`Refusing to write recording outside ${baseDir}`);
		}
		await mkdir(dirname(target), { recursive: true });
		await this.directoryProbe(baseDir);
		return target;
	}

	private publish(event: RecordingEventName, row: RecordingRecord): void {
		if (!this.bus) {
			return;
		}
		this.bus.publish({
			topic: "recordings",
			event,
			data: toPublicRecording(row) as unknown
		});
	}
}

/**
 * Prove the recorder can create files before source discovery or tuner work.
 * A zero-byte probe exercises the effective container user and mounted volume,
 * which catches permission and read-only filesystem failures that `mkdir`
 * cannot detect when the directory already exists.
 */
async function assertRecordingDirectoryWritable(
	directory: string
): Promise<void> {
	const probePath = join(directory, `.signalhaven-write-probe-${randomUUID()}`);
	try {
		await writeFile(probePath, "", {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600
		});
	} catch (error) {
		await rm(probePath, { force: true }).catch(() => undefined);
		throw error;
	}
	await rm(probePath, { force: true });
}

/** Strip / replace characters that are unsafe in file names on any OS. */
function sanitizeFileNameComponent(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.replace(/[\\/:*?"<>|]/g, "_")
			.replace(/\.+$/g, "")
			.replace(/^\.+/g, "")
			.trim()
			.slice(0, 120)
	);
}

/** Hide legacy false positives created before routine startup latency had a grace period. */
function publicRecordingStartReason(
	row: RecordingRecord
): RecordingStartReason | null {
	if (row.startReason !== "late_start" || !row.actualStart) {
		return row.startReason;
	}
	return row.actualStart.getTime() - row.scheduledStart.getTime() >
		LATE_START_GRACE_MS
		? row.startReason
		: null;
}

/** Convert a DB row into the public, JSON-serialisable shape. */
export function toPublicRecording(row: RecordingRecord): Recording {
	return {
		id: row.id,
		channelId: row.channelId,
		programId: row.programId,
		title: row.title,
		status: row.status as RecordingStatus,
		scheduledStart: row.scheduledStart.toISOString(),
		scheduledEnd: row.scheduledEnd.toISOString(),
		actualStart: row.actualStart?.toISOString() ?? null,
		actualEnd: row.actualEnd?.toISOString() ?? null,
		startReason: publicRecordingStartReason(row),
		filePath: row.filePath,
		fileSize: row.fileSize,
		durationSeconds: row.durationSeconds,
		errorMessage: row.errorMessage,
		seriesRuleId: row.seriesRuleId,
		manuallyProtected: row.manuallyProtected,
		watchedAt: row.watchedAt?.toISOString() ?? null,
		resumePositionSeconds: row.resumePositionSeconds
	};
}

/** Detail fallback used when commercial analysis is not wired in tests. */
function notRequestedAnalysis(): CommercialAnalysis {
	return {
		status: "not_requested",
		queuedAt: null,
		startedAt: null,
		completedAt: null,
		failedAt: null,
		diagnosticMessage: null,
		detectorVersion: null,
		markers: []
	};
}

/** Project the EPG row onto the stable public recording metadata contract. */
function toRecordingMetadata(program: {
	subtitle: string | null;
	description: string | null;
	episode: number | null;
	season: number | null;
	categories: string[];
	artworkUrl: string | null;
	originalAirDate?: string | null;
}): RecordingMetadata {
	return {
		subtitle: program.subtitle ?? null,
		description: program.description ?? null,
		episode: program.episode ?? null,
		season: program.season ?? null,
		categories: program.categories ?? [],
		artworkUrl: program.artworkUrl ?? null,
		originalAirDate: program.originalAirDate ?? null
	};
}

/** Rehydrate the public metadata contract entirely from the durable snapshot. */
function toSnapshotMetadata(record: RecordingRecord): RecordingMetadata | null {
	const hasSnapshot =
		record.episodeIdentityKey != null ||
		record.episodeSubtitle != null ||
		record.episodeDescription != null ||
		record.episodeSeason != null ||
		record.episodeNumber != null ||
		(record.episodeCategories?.length ?? 0) > 0 ||
		record.episodeArtworkUrl != null ||
		record.episodeOriginalAirDate != null;
	if (!hasSnapshot) return null;
	return {
		subtitle: record.episodeSubtitle ?? null,
		description: record.episodeDescription ?? null,
		episode: record.episodeNumber ?? null,
		season: record.episodeSeason ?? null,
		categories: record.episodeCategories ?? [],
		artworkUrl: record.episodeArtworkUrl ?? null,
		originalAirDate: record.episodeOriginalAirDate ?? null
	};
}

/** Preserve durable episode metadata while allowing a guide refresh to add artwork. */
function mergeRecordingMetadata(
	snapshot: RecordingMetadata | null,
	current: RecordingMetadata | null
): RecordingMetadata | null {
	if (!snapshot) return current;
	if (!current || snapshot.artworkUrl) return snapshot;
	return { ...snapshot, artworkUrl: current.artworkUrl };
}

/**
 * Encode every deterministic order field into an opaque URL-safe cursor.
 * The version keeps future wire-format changes explicit.
 */
function encodeRecordingCursor(
	record: RecordingRecord,
	sort: RecordingListQuery["sort"],
	direction: RecordingListQuery["direction"]
): string {
	const value =
		sort === "actualStart"
			? record.actualStart
			: sort === "createdAt"
				? record.createdAt
				: record.scheduledStart;
	return Buffer.from(
		JSON.stringify({
			version: 1,
			sort,
			direction,
			value: value?.toISOString() ?? null,
			id: record.id
		})
	).toString("base64url");
}

/** Decode a cursor and bind it to the sort that originally produced it. */
function decodeRecordingCursor(
	encoded: string,
	sort: RecordingListQuery["sort"],
	direction: RecordingListQuery["direction"]
): RecordingListCursor {
	try {
		const payload = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8")
		) as Record<string, unknown>;
		if (
			payload["version"] !== 1 ||
			payload["sort"] !== sort ||
			payload["direction"] !== direction ||
			typeof payload["id"] !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				payload["id"]
			)
		) {
			throw new InvalidRecordingCursorError();
		}
		if (payload["value"] === null) {
			if (sort !== "actualStart") throw new InvalidRecordingCursorError();
			return { value: null, id: payload["id"] };
		}
		if (typeof payload["value"] !== "string") {
			throw new InvalidRecordingCursorError();
		}
		const value = new Date(payload["value"]);
		if (Number.isNaN(value.getTime())) {
			throw new InvalidRecordingCursorError();
		}
		return { value, id: payload["id"] };
	} catch (error) {
		if (error instanceof InvalidRecordingCursorError) throw error;
		throw new InvalidRecordingCursorError();
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Validation and missing-resource failures cannot recover through backoff. */
function isPermanentSourceFailure(error: unknown): boolean {
	return (
		error instanceof ChannelNotStreamableError ||
		error instanceof TunerNotFoundError ||
		error instanceof UnsupportedTunerKindError
	);
}

/**
 * Default config resolver that pulls `recordingsDir` + padding values
 * from the live settings document. Built in `app.ts` so the recordings
 * service can react to settings changes without extra wiring.
 */
export function createSettingsBackedRecordingsConfig(
	getSettings: () => Promise<{
		storage: { path: string | null; quotaGb?: number | null };
		recordings: { paddingBeforeSec: number; paddingAfterSec: number };
	}>
): RecordingsConfigResolver {
	return {
		resolve: async () => {
			const current = await getSettings();
			const recordingsDir = current.storage.path;
			if (!recordingsDir) {
				throw new RecordingStorageNotConfiguredError();
			}
			const quotaGb = current.storage.quotaGb ?? null;
			return {
				recordingsDir,
				paddingBeforeSec: current.recordings.paddingBeforeSec,
				paddingAfterSec: current.recordings.paddingAfterSec,
				quotaBytes:
					quotaGb && quotaGb > 0
						? Math.round(quotaGb * 1024 * 1024 * 1024)
						: null
			};
		}
	};
}

/** Re-exported for route wiring convenience. */
export type { ResolvedStreamSource };
