import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

import type { HwaccelKind } from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import type {
	RecordingRecord,
	RecordingsRepository
} from "../repositories/recordings.repository";

import {
	RecordingPlaybackFfmpegError,
	RecordingPlaybackSession,
	type RecordingPlaybackRunner
} from "./recording-playback-session";

/** Stable API codes used by the recording player for actionable states. */
export const RECORDING_PLAYBACK_ERROR_CODE = {
	notReady: "recording_not_ready",
	failed: "recording_failed",
	cancelled: "recording_cancelled",
	fileMissing: "recording_file_missing",
	fileUnreadable: "recording_file_unreadable",
	sessionExpired: "playback_session_expired",
	stoppedByOperator: "playback_stopped_by_operator"
} as const;

/** Requested recording row no longer exists. */
export class RecordingPlaybackNotFoundError extends Error {
	constructor(id: string) {
		super(`Recording ${id} not found`);
		this.name = "RecordingPlaybackNotFoundError";
	}
}

/** Recording exists but its lifecycle or file prevents playback. */
export class RecordingPlaybackUnavailableError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly code: string,
		message: string,
		public readonly details?: Record<string, unknown>,
		public readonly internalCause?: unknown,
		/** Prevent a second generic warning after the terminal cause was logged. */
		public readonly diagnosticLogged = false
	) {
		super(message);
		this.name = "RecordingPlaybackUnavailableError";
	}
}

/** Correlation details supplied by the request that starts a shared session. */
export interface RecordingPlaybackRequestContext {
	requestId?: string;
}

/** Structured logger surface used for terminal playback preparation failures. */
export interface RecordingPlaybackLogger {
	error(context: Record<string, unknown>, message: string): void;
}

/** Segment request refers to a cleaned-up or replaced playback session. */
export class RecordingPlaybackSessionExpiredError extends Error {
	readonly statusCode = 410;
	readonly code = RECORDING_PLAYBACK_ERROR_CODE.sessionExpired;

	constructor() {
		super("This playback session expired. Reload the recording to continue.");
		this.name = "RecordingPlaybackSessionExpiredError";
	}
}

/** Playlist retries cannot recreate work an operator explicitly stopped. */
export class RecordingPlaybackStoppedByOperatorError extends Error {
	readonly statusCode = 409;
	readonly code = RECORDING_PLAYBACK_ERROR_CODE.stoppedByOperator;

	constructor(recordingId: string) {
		super(`Recording playback ${recordingId} was stopped by an operator.`);
		this.name = "RecordingPlaybackStoppedByOperatorError";
	}
}

/** Requested segment is not part of the active recording session. */
export class RecordingPlaybackSegmentNotFoundError extends Error {
	readonly statusCode = 404;
	readonly code = "recording_segment_not_found";

	constructor(segment: string) {
		super(`Recording segment ${segment} was not found.`);
		this.name = "RecordingPlaybackSegmentNotFoundError";
	}
}

export interface RecordingPlaybackServiceOptions {
	repository: Pick<RecordingsRepository, "getById">;
	bus?: EventBus;
	runner?: RecordingPlaybackRunner;
	tmpRoot?: string;
	idleMs?: number;
	startTimeoutMs?: number;
	viewerTimeoutMs?: number;
	operatorStopQuietMs?: number;
	/** Application logger used for durable, sanitized failure summaries. */
	logger?: RecordingPlaybackLogger;
	/** Resolve current hardware acceleration without coupling sessions to settings. */
	resolveHwaccel?: () => Promise<HwaccelKind | null>;
}

interface PendingPlaybackSession {
	key: string;
	recordingId: string;
	ready: Promise<RecordingPlaybackSession>;
	session?: RecordingPlaybackSession;
	cancelled: boolean;
	/** Managed viewers reserve pending work before FFmpeg is ready. */
	viewerIds: Set<string>;
	/** Requests from older clients retain the session through idle activity. */
	legacyOwner: boolean;
	requestedStartSeconds: number;
	startSeconds: number;
}

/**
 * Coordinates one reusable VOD HLS session per recording. Pending creation is
 * inserted into the map before I/O begins so concurrent manifest requests
 * cannot spawn duplicate FFmpeg processes.
 */
export class RecordingPlaybackService {
	private readonly repository: Pick<RecordingsRepository, "getById">;
	private readonly bus: EventBus | undefined;
	private readonly runner: RecordingPlaybackRunner | undefined;
	private readonly tmpRoot: string | undefined;
	private readonly idleMs: number | undefined;
	private readonly startTimeoutMs: number | undefined;
	private readonly viewerTimeoutMs: number | undefined;
	private readonly operatorStopQuietMs: number;
	private readonly logger: RecordingPlaybackLogger | undefined;
	private readonly resolveHwaccel: () => Promise<HwaccelKind | null>;
	private readonly sessions = new Map<string, PendingPlaybackSession>();
	private readonly viewerSessions = new Map<string, PendingPlaybackSession>();
	private readonly operatorStopBarriers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();

	constructor(options: RecordingPlaybackServiceOptions) {
		this.repository = options.repository;
		this.bus = options.bus;
		this.runner = options.runner;
		this.tmpRoot = options.tmpRoot;
		this.idleMs = options.idleMs;
		this.startTimeoutMs = options.startTimeoutMs;
		this.viewerTimeoutMs = options.viewerTimeoutMs;
		this.operatorStopQuietMs = options.operatorStopQuietMs ?? 10_000;
		this.logger = options.logger;
		this.resolveHwaccel = options.resolveHwaccel ?? (async () => null);
	}

	/** Create or reuse a session and return its recording-scoped media playlist. */
	async getManifest(
		recordingId: string,
		context: RecordingPlaybackRequestContext = {},
		startSeconds = 0,
		viewerId?: string
	): Promise<string> {
		const normalizedStart = normalizeStartSeconds(startSeconds);
		const { pending, session } = await this.getOrCreate(
			recordingId,
			context,
			normalizedStart,
			viewerId
		);
		if (viewerId && this.viewerSessions.get(viewerId) !== pending) {
			throw new RecordingPlaybackSessionExpiredError();
		}
		if (session.getState() === "stopped") {
			throw new RecordingPlaybackSessionExpiredError();
		}
		try {
			return await session.readPlaylist(viewerId);
		} catch (error) {
			if (session.getState() === "stopped") {
				throw new RecordingPlaybackSessionExpiredError();
			}
			throw this.wrapPreparationError(error);
		}
	}

	/** Serve a segment only from the active session named in the manifest. */
	async getSegment(
		recordingId: string,
		sessionId: string,
		segment: string,
		viewerId?: string
	): Promise<Buffer> {
		const pending = [...this.sessions.values()].find(
			(entry) =>
				entry.recordingId === recordingId &&
				entry.session?.sessionId === sessionId
		);
		if (!pending) throw new RecordingPlaybackSessionExpiredError();
		if (viewerId && this.viewerSessions.get(viewerId) !== pending) {
			throw new RecordingPlaybackSessionExpiredError();
		}
		let session: RecordingPlaybackSession;
		try {
			session = await pending.ready;
		} catch {
			throw new RecordingPlaybackSessionExpiredError();
		}
		if (session.sessionId !== sessionId || session.getState() === "stopped") {
			throw new RecordingPlaybackSessionExpiredError();
		}
		try {
			return await session.readSegment(segment, viewerId);
		} catch {
			if (session.getState() === "stopped") {
				throw new RecordingPlaybackSessionExpiredError();
			}
			throw new RecordingPlaybackSegmentNotFoundError(segment);
		}
	}

	/** Stop and remove one recording's process and temporary artifacts. */
	async stop(recordingId: string): Promise<void> {
		const matches = [...this.sessions.values()].filter(
			(pending) => pending.recordingId === recordingId
		);
		await Promise.all(matches.map((pending) => this.stopPending(pending)));
	}

	/** Release one logical browser viewer; repeated beacons are harmless. */
	releaseViewer(recordingId: string, viewerId: string): boolean {
		const pending = this.viewerSessions.get(viewerId);
		if (!pending || pending.recordingId !== recordingId) return false;
		this.viewerSessions.delete(viewerId);
		pending.viewerIds.delete(viewerId);
		if (pending.session) {
			pending.session.detachViewer(viewerId, !pending.legacyOwner);
		}
		if (pending.viewerIds.size === 0 && !pending.legacyOwner) {
			void this.stopPending(pending);
		}
		return true;
	}

	/** Stop one operator-selected playback session and block immediate retries. */
	stopSession(sessionId: string): boolean {
		const pending = [...this.sessions.values()].find(
			(entry) => entry.session?.sessionId === sessionId
		);
		if (!pending) return false;
		this.extendOperatorStopBarrier(pending.key);
		void this.stopPending(pending);
		return true;
	}

	/** Stop all playback work during graceful backend shutdown. */
	async stopAll(): Promise<void> {
		for (const timer of this.operatorStopBarriers.values()) clearTimeout(timer);
		this.operatorStopBarriers.clear();
		await Promise.all(
			[...this.sessions.values()].map((pending) => this.stopPending(pending))
		);
	}

	getActiveSessionCount(): number {
		return this.sessions.size;
	}

	/** Count only child processes that are still alive for metrics. */
	getRunningProcessCount(): number {
		return [...this.sessions.values()].filter((pending) =>
			pending.session?.isProcessRunning()
		).length;
	}

	/** Stable snapshots for the advanced FFmpeg work surface. */
	getActiveSessions(): Array<{
		playbackSessionId: string;
		recordingId: string;
		state: string;
		startedAt: string;
		profile: string;
		hwaccel: HwaccelKind | null;
		clientCount: number;
		pipelineSpeed: number | null;
	}> {
		return [...this.sessions.values()].flatMap((pending) => {
			const session = pending.session;
			return session &&
				(session.getState() === "starting" || session.isProcessRunning())
				? [
						{
							playbackSessionId: session.sessionId,
							recordingId: pending.recordingId,
							state: session.getState(),
							startedAt: session.startedAt.toISOString(),
							profile: session.profile,
							hwaccel: session.hwaccel,
							clientCount: Math.max(
								session.getViewerCount(),
								pending.viewerIds.size
							),
							pipelineSpeed: session.getPipelineSpeed()
						}
					]
				: [];
		});
	}

	/** Diagnostic lookup used by tests and future status surfaces. */
	getSession(
		recordingId: string,
		startSeconds?: number
	): RecordingPlaybackSession | undefined {
		return [...this.sessions.values()].find(
			(pending) =>
				pending.recordingId === recordingId &&
				(startSeconds === undefined || pending.startSeconds === startSeconds)
		)?.session;
	}

	private async getOrCreate(
		recordingId: string,
		context: RecordingPlaybackRequestContext,
		startSeconds: number,
		viewerId?: string
	): Promise<{
		pending: PendingPlaybackSession;
		session: RecordingPlaybackSession;
	}> {
		const key = playbackKey(recordingId, startSeconds);
		this.assertNotOperatorStopped(key, recordingId);
		let pending = this.sessions.get(key);
		if (!pending) {
			pending = {
				key,
				recordingId,
				cancelled: false,
				viewerIds: new Set<string>(),
				legacyOwner: false,
				requestedStartSeconds: startSeconds,
				startSeconds,
				ready: Promise.resolve(undefined as never)
			};
			pending.ready = this.createSession(
				recordingId,
				pending,
				context,
				startSeconds
			);
			this.sessions.set(key, pending);
		}
		if (viewerId) this.moveViewer(viewerId, pending);
		else {
			pending.legacyOwner = true;
			pending.session?.retainForLegacyRequests();
		}

		let session: RecordingPlaybackSession;
		try {
			session = await pending.ready;
		} catch (error) {
			if (this.sessions.get(key) === pending) {
				this.sessions.delete(key);
			}
			if (
				error instanceof RecordingPlaybackUnavailableError ||
				error instanceof RecordingPlaybackNotFoundError ||
				error instanceof RecordingPlaybackSessionExpiredError ||
				error instanceof RecordingPlaybackStoppedByOperatorError
			) {
				throw error;
			}
			throw this.wrapPreparationError(error);
		}
		if (viewerId && this.viewerSessions.get(viewerId) !== pending) {
			throw new RecordingPlaybackSessionExpiredError();
		}
		return { pending, session };
	}

	private async createSession(
		recordingId: string,
		pending: PendingPlaybackSession,
		context: RecordingPlaybackRequestContext,
		requestedStartSeconds: number
	): Promise<RecordingPlaybackSession> {
		const recording = await this.loadPlayableRecording(recordingId);
		const startSeconds = clampStartSeconds(
			requestedStartSeconds,
			recording.durationSeconds
		);
		pending.startSeconds = startSeconds;
		const hwaccel = await this.resolveHwaccel().catch(() => null);
		let session = this.createPlaybackSession(
			recordingId,
			recording.filePath as string,
			hwaccel,
			startSeconds
		);
		pending.session = session;
		if (pending.legacyOwner) session.retainForLegacyRequests();
		try {
			await session.start();
		} catch (error) {
			// A failed attempt finalizes asynchronously; wait for artifact cleanup
			// before assigning the software process to this shared pending session.
			await session.stop();
			if (pending.cancelled) {
				throw new RecordingPlaybackSessionExpiredError();
			}
			if (!shouldRetryInSoftware(error, hwaccel)) {
				const diagnosticLogged = this.logPreparationFailure(
					recordingId,
					session,
					context
				);
				throw this.wrapPreparationError(error, diagnosticLogged);
			}

			this.publishSoftwareFallback(recordingId, session, hwaccel);
			session = this.createPlaybackSession(
				recordingId,
				recording.filePath as string,
				null,
				startSeconds
			);
			pending.session = session;
			if (pending.legacyOwner) session.retainForLegacyRequests();
			try {
				await session.start();
			} catch (error) {
				await session.stop();
				if (pending.cancelled) {
					throw new RecordingPlaybackSessionExpiredError();
				}
				const diagnosticLogged = this.logPreparationFailure(
					recordingId,
					session,
					context
				);
				throw this.wrapPreparationError(error, diagnosticLogged);
			}
		}
		if (pending.cancelled) {
			await session.stop();
			throw new RecordingPlaybackSessionExpiredError();
		}
		session.onStopped(() => {
			this.cleanupPending(pending, session);
		});
		return session;
	}

	/** Emit one terminal summary after fallback decisions have been exhausted. */
	private logPreparationFailure(
		recordingId: string,
		session: RecordingPlaybackSession,
		context: RecordingPlaybackRequestContext
	): boolean {
		if (!this.logger) return false;
		const diagnostic = session.getFailureDiagnostic() ?? {
			category: "recording_preparation_failed",
			message: "Recording playback preparation failed",
			exitCode: null,
			signal: null
		};
		this.logger.error(
			{
				...(context.requestId ? { requestId: context.requestId } : {}),
				recordingId,
				playbackSessionId: session.sessionId,
				profile: session.profile,
				hwaccel: session.hwaccel ?? "none",
				exitCode: diagnostic.exitCode,
				signal: diagnostic.signal,
				errorCategory: diagnostic.category,
				errorMessage: diagnostic.message
			},
			"Recording playback failed to prepare"
		);
		return true;
	}

	/** Build one playback attempt while keeping hardware and software plans equal. */
	private createPlaybackSession(
		recordingId: string,
		inputPath: string,
		hwaccel: HwaccelKind | null,
		startSeconds: number
	): RecordingPlaybackSession {
		return new RecordingPlaybackSession({
			recordingId,
			inputPath,
			startSeconds,
			hwaccel,
			...(this.bus ? { bus: this.bus } : {}),
			...(this.runner ? { runner: this.runner } : {}),
			...(this.tmpRoot ? { tmpRoot: this.tmpRoot } : {}),
			...(this.idleMs !== undefined ? { idleMs: this.idleMs } : {}),
			...(this.startTimeoutMs !== undefined
				? { startTimeoutMs: this.startTimeoutMs }
				: {}),
			...(this.viewerTimeoutMs !== undefined
				? { viewerTimeoutMs: this.viewerTimeoutMs }
				: {})
		});
	}

	/** Stop one exact pending entry without deleting a newer replacement. */
	private async stopPending(pending: PendingPlaybackSession): Promise<void> {
		pending.cancelled = true;
		try {
			await pending.session?.stop();
			const session = await pending.ready;
			if (session !== pending.session) await session.stop();
		} catch {
			// Failed startup and cancellation perform their own cleanup.
		} finally {
			this.cleanupPending(pending);
		}
	}

	/** Move one viewer reservation without allowing tabs to replace each other. */
	private moveViewer(viewerId: string, pending: PendingPlaybackSession): void {
		const previous = this.viewerSessions.get(viewerId);
		if (previous === pending) {
			pending.session?.attachViewer(viewerId);
			return;
		}
		this.viewerSessions.set(viewerId, pending);
		pending.viewerIds.add(viewerId);
		if (previous) {
			previous.viewerIds.delete(viewerId);
			if (previous.session) {
				previous.session.detachViewer(viewerId, !previous.legacyOwner);
			}
			if (previous.viewerIds.size === 0 && !previous.legacyOwner) {
				void this.stopPending(previous);
			}
		}
		pending.session?.attachViewer(viewerId);
	}

	/** Remove exact indexes and viewer ownership after session cleanup. */
	private cleanupPending(
		pending: PendingPlaybackSession,
		session?: RecordingPlaybackSession
	): void {
		if (session && pending.session !== session) return;
		if (this.sessions.get(pending.key) === pending) {
			this.sessions.delete(pending.key);
		}
		for (const viewerId of pending.viewerIds) {
			if (this.viewerSessions.get(viewerId) === pending) {
				this.viewerSessions.delete(viewerId);
			}
		}
		pending.viewerIds.clear();
	}

	/** Reject automatic retries until requests for the stopped window go quiet. */
	private assertNotOperatorStopped(key: string, recordingId: string): void {
		if (!this.operatorStopBarriers.has(key)) return;
		this.extendOperatorStopBarrier(key);
		throw new RecordingPlaybackStoppedByOperatorError(recordingId);
	}

	/** Extend a restart barrier while an HLS client continues retrying. */
	private extendOperatorStopBarrier(key: string): void {
		const existing = this.operatorStopBarriers.get(key);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			if (this.operatorStopBarriers.get(key) === timer) {
				this.operatorStopBarriers.delete(key);
			}
		}, this.operatorStopQuietMs);
		timer.unref?.();
		this.operatorStopBarriers.set(key, timer);
	}

	/** Publish only the stable category so FFmpeg paths cannot leak to clients. */
	private publishSoftwareFallback(
		recordingId: string,
		session: RecordingPlaybackSession,
		hwaccel: HwaccelKind
	): void {
		this.bus?.publish({
			topic: "recordings",
			event: "recording.playback.software_fallback",
			data: {
				recordingId,
				playbackSessionId: session.sessionId,
				hwaccel,
				reason: "hwaccel_init_failed"
			}
		});
	}

	private async loadPlayableRecording(
		recordingId: string
	): Promise<RecordingRecord> {
		const recording = await this.repository.getById(recordingId);
		if (!recording) throw new RecordingPlaybackNotFoundError(recordingId);
		if (recording.status !== "completed") {
			throw unavailableForStatus(recording);
		}
		if (!recording.filePath) {
			throw new RecordingPlaybackUnavailableError(
				410,
				RECORDING_PLAYBACK_ERROR_CODE.fileMissing,
				"The recording file is missing. Delete this library entry or run a library scan."
			);
		}
		try {
			const info = await stat(recording.filePath);
			if (!info.isFile() || info.size <= 0) {
				throw new Error("recording path is not a non-empty file");
			}
			await access(recording.filePath, constants.R_OK);
		} catch (error) {
			const missing = isNodeError(error) && error.code === "ENOENT";
			throw new RecordingPlaybackUnavailableError(
				missing ? 410 : 422,
				missing
					? RECORDING_PLAYBACK_ERROR_CODE.fileMissing
					: RECORDING_PLAYBACK_ERROR_CODE.fileUnreadable,
				missing
					? "The recording file was deleted or moved. Run a library scan to reconcile it."
					: "The recording file cannot be read. Check storage permissions and file health.",
				undefined,
				error
			);
		}
		return recording;
	}

	private wrapPreparationError(
		error: unknown,
		diagnosticLogged = false
	): RecordingPlaybackUnavailableError {
		if (error instanceof RecordingPlaybackUnavailableError) return error;
		return new RecordingPlaybackUnavailableError(
			422,
			RECORDING_PLAYBACK_ERROR_CODE.fileUnreadable,
			"The recording could not be prepared for browser playback. Check the media file and FFmpeg installation.",
			undefined,
			error,
			diagnosticLogged
		);
	}
}

function unavailableForStatus(
	recording: RecordingRecord
): RecordingPlaybackUnavailableError {
	switch (recording.status) {
		case "scheduled":
		case "recording":
			return new RecordingPlaybackUnavailableError(
				409,
				RECORDING_PLAYBACK_ERROR_CODE.notReady,
				recording.status === "scheduled"
					? "This recording has not started yet."
					: "This recording is still in progress. Try again after it completes.",
				{ status: recording.status }
			);
		case "failed":
			return new RecordingPlaybackUnavailableError(
				409,
				RECORDING_PLAYBACK_ERROR_CODE.failed,
				"This recording failed and has no completed media to play.",
				{
					status: recording.status,
					...(recording.errorMessage
						? { recordingError: recording.errorMessage }
						: {})
				}
			);
		case "cancelled":
			return new RecordingPlaybackUnavailableError(
				409,
				RECORDING_PLAYBACK_ERROR_CODE.cancelled,
				"This recording was cancelled before it completed.",
				{ status: recording.status }
			);
		case "completed":
		default:
			return new RecordingPlaybackUnavailableError(
				409,
				RECORDING_PLAYBACK_ERROR_CODE.notReady,
				"This recording is not ready for playback.",
				{ status: recording.status }
			);
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** Convert untrusted seek values to a stable non-negative whole second. */
function normalizeStartSeconds(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Keep recording and offset identities collision-safe inside process memory. */
function playbackKey(recordingId: string, startSeconds: number): string {
	return `${recordingId}\u001f${startSeconds}`;
}

/** Keep FFmpeg away from an empty timestamp at the exact end of the file. */
function clampStartSeconds(
	value: number,
	durationSeconds: number | null
): number {
	if (!durationSeconds || durationSeconds <= 0) return value;
	return Math.min(value, Math.max(0, durationSeconds - 1));
}

/** Retry only explicit hardware initialization failures from a hardware plan. */
function shouldRetryInSoftware(
	error: unknown,
	hwaccel: HwaccelKind | null
): hwaccel is HwaccelKind {
	return (
		hwaccel !== null &&
		error instanceof RecordingPlaybackFfmpegError &&
		error.category === "hwaccel_init_failed"
	);
}
