import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type { HwaccelKind } from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import { DEFAULT_MEDIA_PROBE, type MediaProbe } from "../streaming/media-probe";
import { buildFfmpegArgs, parseFfmpegLine } from "../streaming/transcoder";

/** Default time without manifest or segment reads before a session expires. */
export const DEFAULT_RECORDING_PLAYBACK_IDLE_MS = 5 * 60_000;
/** Fallback lifetime for a browser viewer whose release beacon is lost. */
export const DEFAULT_RECORDING_PLAYBACK_VIEWER_TIMEOUT_MS = 30_000;
/** Maximum time to wait for FFmpeg to publish the initial media playlist. */
export const DEFAULT_RECORDING_PLAYBACK_START_TIMEOUT_MS = 15_000;
/** Recording HLS segments use the same bounded safe-name contract as live TV. */
export const MAX_RECORDING_SEGMENT_NAME_LENGTH = 64;

/** Process and probe seams used by focused lifecycle tests. */
export interface RecordingPlaybackRunner extends MediaProbe {
	spawn(args: string[]): ChildProcess;
}

const DEFAULT_RUNNER: RecordingPlaybackRunner = {
	probe: DEFAULT_MEDIA_PROBE.probe,
	spawn: (args) =>
		spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
};

export interface RecordingPlaybackSessionOptions {
	recordingId: string;
	inputPath: string;
	startSeconds?: number;
	bus?: EventBus;
	runner?: RecordingPlaybackRunner;
	tmpRoot?: string;
	idleMs?: number;
	startTimeoutMs?: number;
	viewerTimeoutMs?: number;
	hwaccel?: HwaccelKind | null;
}

export type RecordingPlaybackSessionState = "starting" | "ready" | "stopped";

/** Sanitized terminal details retained for one durable operator diagnostic. */
export interface RecordingPlaybackFailureDiagnostic {
	category: string;
	message: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

/** FFmpeg startup failure with a conservative machine-readable category. */
export class RecordingPlaybackFfmpegError extends Error {
	constructor(
		message: string,
		public readonly category?: string
	) {
		super(message);
		this.name = "RecordingPlaybackFfmpegError";
	}
}

/**
 * Owns the FFmpeg process and temporary VOD HLS files for one recording.
 * Requests touch the idle timer; the session keeps every generated segment
 * until it expires so seeks and playlist reloads remain stable.
 */
export class RecordingPlaybackSession {
	readonly recordingId: string;
	/** Absolute recording timestamp represented by media time zero. */
	readonly startSeconds: number;
	readonly sessionId = randomUUID();
	readonly startedAt = new Date();
	readonly profile = "original-quality" as const;
	readonly hwaccel: HwaccelKind | null;

	private readonly inputPath: string;
	private readonly bus: EventBus | undefined;
	private readonly runner: RecordingPlaybackRunner;
	private readonly tmpRoot: string;
	private readonly idleMs: number;
	private readonly startTimeoutMs: number;
	private readonly viewerTimeoutMs: number;
	private readonly stoppedListeners = new Set<(error?: Error) => void>();
	/** Stable viewer heartbeats distinguish browser tabs from short HLS requests. */
	private readonly viewerIds = new Map<string, number>();

	private state: RecordingPlaybackSessionState = "starting";
	private outDir = "";
	private process: ChildProcess | undefined;
	private args: string[] = [];
	private idleTimer: NodeJS.Timeout | undefined;
	private viewerTimer: NodeJS.Timeout | undefined;
	private stopTimer: NodeJS.Timeout | undefined;
	private startPromise: Promise<void> | undefined;
	private readyPromise: Promise<void> | undefined;
	private resolveReady: (() => void) | undefined;
	private rejectReady: ((error: Error) => void) | undefined;
	private resolveStopped: (() => void) | undefined;
	private readonly stoppedPromise: Promise<void>;
	private finalized = false;
	private stopRequested = false;
	private retainedByLegacyRequests = false;
	private lastError: Error | undefined;
	private failureDiagnostic: RecordingPlaybackFailureDiagnostic | undefined;

	constructor(options: RecordingPlaybackSessionOptions) {
		this.recordingId = options.recordingId;
		this.startSeconds = options.startSeconds ?? 0;
		this.inputPath = options.inputPath;
		this.bus = options.bus;
		this.runner = options.runner ?? DEFAULT_RUNNER;
		this.tmpRoot = options.tmpRoot ?? tmpdir();
		this.idleMs = options.idleMs ?? DEFAULT_RECORDING_PLAYBACK_IDLE_MS;
		this.startTimeoutMs =
			options.startTimeoutMs ?? DEFAULT_RECORDING_PLAYBACK_START_TIMEOUT_MS;
		this.viewerTimeoutMs = Math.max(
			1,
			options.viewerTimeoutMs ?? DEFAULT_RECORDING_PLAYBACK_VIEWER_TIMEOUT_MS
		);
		this.hwaccel = options.hwaccel ?? null;
		this.stoppedPromise = new Promise<void>((resolve) => {
			this.resolveStopped = resolve;
		});
	}

	/** Start transcoding once and wait until the first playlist is readable. */
	start(): Promise<void> {
		this.startPromise ??= this.startInternal();
		return this.startPromise;
	}

	/** Refresh session ownership after a valid manifest or segment request. */
	touch(): void {
		if (this.finalized) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.idleMs <= 0) {
			void this.stop();
			return;
		}
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			void this.stop();
		}, this.idleMs);
		this.idleTimer.unref?.();
	}

	/** Read and rewrite the VOD playlist with this session's opaque token. */
	async readPlaylist(viewerId?: string): Promise<string> {
		await this.start();
		if (viewerId) this.attachViewer(viewerId);
		this.touch();
		const playlist = await readFile(join(this.outDir, "playlist.m3u8"), "utf8");
		return exposeRecordingSegmentUris(playlist, this.sessionId, viewerId);
	}

	/** Read one immutable segment while enforcing output-directory containment. */
	async readSegment(name: string, viewerId?: string): Promise<Buffer> {
		await this.start();
		if (!isSafeRecordingSegmentName(name)) {
			throw new Error(`Invalid recording segment name: ${name}`);
		}
		if (viewerId) this.attachViewer(viewerId);
		this.touch();
		const safeName = basename(name);
		const baseDir = resolve(this.outDir);
		const target = resolve(baseDir, safeName);
		if (
			target !== join(baseDir, safeName) ||
			!target.startsWith(baseDir + sep)
		) {
			throw new Error(`Invalid recording segment name: ${name}`);
		}
		return readFile(target);
	}

	/** Register or refresh one logical browser viewer. */
	attachViewer(viewerId: string): void {
		if (this.finalized) return;
		this.viewerIds.set(viewerId, Date.now());
		this.scheduleViewerExpiration();
	}

	/** Release a logical browser viewer and stop when it was the final owner. */
	detachViewer(viewerId: string, stopWhenEmpty = true): boolean {
		if (!this.viewerIds.delete(viewerId)) return false;
		this.scheduleViewerExpiration();
		if (stopWhenEmpty && this.viewerIds.size === 0 && !this.finalized) {
			void this.stop();
		}
		return true;
	}

	/** Number of browser viewers currently retaining this playback window. */
	getViewerCount(): number {
		return this.viewerIds.size;
	}

	/** Preserve idle-based cleanup for clients that do not send viewer IDs. */
	retainForLegacyRequests(): void {
		this.retainedByLegacyRequests = true;
	}

	/** Whether FFmpeg is still producing media rather than serving retained files. */
	isProcessRunning(): boolean {
		return Boolean(
			this.process &&
			this.process.exitCode === null &&
			this.process.signalCode === null
		);
	}

	/** Stop FFmpeg, remove generated artifacts, and notify the manager. */
	async stop(): Promise<void> {
		if (this.finalized) return this.stoppedPromise;
		this.stopRequested = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		const child = this.process;
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
				this.stopTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// A concurrent exit already released the process.
					}
					void this.finalize();
				}, 2_000);
				this.stopTimer.unref?.();
			} catch {
				void this.finalize();
			}
		} else {
			void this.finalize();
		}
		return this.stoppedPromise;
	}

	getState(): RecordingPlaybackSessionState {
		return this.state;
	}

	/** FFmpeg argv retained for diagnostics and copy/transcode tests. */
	getArgs(): string[] {
		return [...this.args];
	}

	/** Most recent startup or FFmpeg error, if the session failed. */
	getLastError(): Error | undefined {
		return this.lastError;
	}

	/** Return only the sanitized terminal details suitable for server logs. */
	getFailureDiagnostic(): RecordingPlaybackFailureDiagnostic | undefined {
		return this.failureDiagnostic ? { ...this.failureDiagnostic } : undefined;
	}

	/** Subscribe to completed cleanup; late subscribers run on a microtask. */
	onStopped(listener: (error?: Error) => void): () => void {
		if (this.finalized) {
			queueMicrotask(() => listener(this.lastError));
			return () => undefined;
		}
		this.stoppedListeners.add(listener);
		return () => this.stoppedListeners.delete(listener);
	}

	/** Test-only visibility into the temp directory cleanup contract. */
	getOutputDirectory(): string {
		return this.outDir;
	}

	/** Re-arm cleanup from the oldest viewer heartbeat. */
	private scheduleViewerExpiration(): void {
		if (this.viewerTimer) clearTimeout(this.viewerTimer);
		this.viewerTimer = undefined;
		if (this.viewerIds.size === 0 || this.finalized) return;
		const oldestSeenAt = Math.min(...this.viewerIds.values());
		const delay = Math.max(0, oldestSeenAt + this.viewerTimeoutMs - Date.now());
		this.viewerTimer = setTimeout(() => {
			this.viewerTimer = undefined;
			this.expireInactiveViewers();
		}, delay);
		this.viewerTimer.unref?.();
	}

	/** Stop orphaned sessions after every viewer heartbeat has expired. */
	private expireInactiveViewers(): void {
		const cutoff = Date.now() - this.viewerTimeoutMs;
		for (const [viewerId, seenAt] of this.viewerIds) {
			if (seenAt <= cutoff) this.viewerIds.delete(viewerId);
		}
		if (
			this.viewerIds.size === 0 &&
			!this.retainedByLegacyRequests &&
			!this.finalized
		) {
			void this.stop();
			return;
		}
		this.scheduleViewerExpiration();
	}

	private async startInternal(): Promise<void> {
		if (this.stopRequested || this.finalized) {
			throw new Error("Recording playback session stopped");
		}
		try {
			this.outDir = await mkdtemp(
				join(this.tmpRoot, "signalhaven-recording-playback-")
			);
			const codecs = await this.runner.probe(this.inputPath);
			this.args = buildFfmpegArgs({
				input: this.inputPath,
				outDir: this.outDir,
				profile: "original-quality",
				hwaccel: this.hwaccel,
				input_codecs: codecs,
				outputMode: "vod",
				inputSeekSeconds: this.startSeconds
			});
		} catch (error) {
			const normalized = normalizeError(error);
			this.lastError = normalized;
			this.setFailureDiagnostic("recording_preparation_failed", normalized);
			this.publishFailure();
			await this.finalize(normalized);
			throw normalized;
		}
		if (this.stopRequested || this.finalized) {
			// Cancellation may arrive while the media probe is in flight. Do not
			// spawn FFmpeg after cleanup has already taken ownership of the session.
			await this.stoppedPromise;
			throw new Error("Recording playback session stopped");
		}

		try {
			this.process = this.runner.spawn(this.args);
		} catch (error) {
			const normalized = normalizeError(error);
			this.lastError = normalized;
			this.setFailureDiagnostic("ffmpeg_spawn_failed", normalized);
			this.publishFailure();
			await this.finalize(normalized);
			throw normalized;
		}
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.bindProcess(this.process);
		this.publish("recording.playback.started", {});
		void this.pollForPlaylist();
		await this.readyPromise;
		this.touch();
	}

	private bindProcess(child: ChildProcess): void {
		let stderrBuffer = "";
		const consume = (raw: string): void => {
			const parsed = parseFfmpegLine(raw);
			if (parsed.level === "error") {
				const currentCategory = this.failureDiagnostic?.category;
				// FFmpeg often follows the useful hardware root cause with a generic
				// filter error. Preserve the classified cause unless a later line has
				// its own category, such as invalid input data.
				if (
					currentCategory === "hwaccel_init_failed" &&
					parsed.category === undefined
				) {
					return;
				}
				this.lastError = new RecordingPlaybackFfmpegError(
					parsed.message,
					parsed.category
				);
				this.failureDiagnostic = {
					category: parsed.category ?? "ffmpeg_stderr_error",
					message: this.sanitizeDiagnostic(parsed.message),
					exitCode: null,
					signal: null
				};
			}
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString("utf8");
			const lines = stderrBuffer.split(/\r?\n/);
			stderrBuffer = lines.pop() ?? "";
			for (const line of lines) consume(line);
		});
		child.stderr?.once("end", () => {
			if (stderrBuffer.length > 0) consume(stderrBuffer);
			stderrBuffer = "";
		});
		child.once("error", (error) => {
			if (this.finalized) return;
			const normalized = normalizeError(error);
			this.setFailureDiagnostic("ffmpeg_spawn_failed", normalized);
			this.fail(normalized);
		});
		child.once("exit", (code, signal) => {
			if (this.finalized) return;
			this.process = undefined;
			if (this.stopRequested) {
				void this.finalize();
				return;
			}
			if (code === 0) {
				void this.handleSuccessfulExit();
				return;
			}
			if (this.failureDiagnostic) {
				this.failureDiagnostic = {
					...this.failureDiagnostic,
					exitCode: code,
					signal
				};
			} else {
				this.failureDiagnostic = {
					category: "ffmpeg_process_failed",
					message: `FFmpeg exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
					exitCode: code,
					signal
				};
			}
			this.fail(
				this.lastError ??
					new Error(
						`ffmpeg exited unexpectedly (code=${code ?? "null"}, signal=${
							signal ?? "null"
						})`
					)
			);
		});
	}

	private async handleSuccessfulExit(): Promise<void> {
		if (this.state === "starting") {
			try {
				await readFile(join(this.outDir, "playlist.m3u8"));
				this.markReady();
			} catch {
				const error = new Error(
					"FFmpeg completed without producing an HLS playlist"
				);
				this.setFailureDiagnostic("ffmpeg_output_missing", error, 0, null);
				this.fail(error);
				return;
			}
		}
		this.publish("recording.playback.transcode_completed", {});
	}

	private async pollForPlaylist(): Promise<void> {
		const started = Date.now();
		while (this.state === "starting" && !this.finalized) {
			try {
				await readFile(join(this.outDir, "playlist.m3u8"));
				this.markReady();
				return;
			} catch {
				// FFmpeg writes the playlist asynchronously after its first segment.
			}
			if (Date.now() - started > this.startTimeoutMs) {
				const error = new Error("Timed out waiting for recording HLS output");
				this.setFailureDiagnostic("ffmpeg_start_timeout", error);
				this.fail(error);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	private markReady(): void {
		if (this.state !== "starting" || this.finalized) return;
		this.state = "ready";
		this.resolveReady?.();
		this.publish("recording.playback.ready", {});
	}

	private fail(error: Error): void {
		if (this.finalized) return;
		this.lastError = error;
		this.failureDiagnostic ??= {
			category: "ffmpeg_process_failed",
			message: this.sanitizeDiagnostic(error.message),
			exitCode: null,
			signal: null
		};
		this.rejectReady?.(error);
		this.publishFailure();
		void this.finalize(error);
	}

	/** Retain a safe classification without exposing process arguments or paths. */
	private setFailureDiagnostic(
		category: string,
		error: Error,
		exitCode: number | null = null,
		signal: NodeJS.Signals | null = null
	): void {
		this.failureDiagnostic = {
			category,
			message: this.sanitizeDiagnostic(error.message),
			exitCode,
			signal
		};
	}

	/** Publish only safe state; the structured logger owns detailed diagnostics. */
	private publishFailure(): void {
		this.publish("recording.playback.error", {
			message: "Playback error",
			...(this.failureDiagnostic
				? { category: this.failureDiagnostic.category }
				: {})
		});
	}

	/** Redact recording paths, URLs, and common secret-bearing parameters. */
	private sanitizeDiagnostic(message: string): string {
		const exactPaths = [this.inputPath, this.outDir]
			.filter((path) => path.length > 0)
			.sort((left, right) => right.length - left.length);
		let sanitized = exactPaths.reduce(
			(value, path) => value.split(path).join("<redacted recording path>"),
			message
		);
		sanitized = sanitized
			.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<redacted URL>")
			.replace(
				/\b(token|access_token|api_key|apikey|password|passwd|secret|authorization|auth)=([^\s&]+)/gi,
				"$1=<redacted>"
			)
			.replace(
				/\b[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]+/g,
				"<redacted path>"
			)
			.replace(
				/(^|[\s("'=])\/(?:[^/\s"'<>:]+\/)+[^/\s"'<>:]*/g,
				"$1<redacted path>"
			);
		return sanitized;
	}

	private async finalize(error?: Error): Promise<void> {
		if (this.finalized) return;
		const wasStarting = this.state === "starting";
		this.finalized = true;
		this.state = "stopped";
		if (error) this.lastError = error;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.viewerTimer) clearTimeout(this.viewerTimer);
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.idleTimer = undefined;
		this.viewerTimer = undefined;
		this.stopTimer = undefined;
		this.viewerIds.clear();
		if (this.readyPromise && wasStarting) {
			this.rejectReady?.(
				this.lastError ?? new Error("Recording playback session stopped")
			);
		}
		const child = this.process;
		this.process = undefined;
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {
				// The process may have exited between the state check and signal.
			}
		}
		if (this.outDir) {
			await rm(this.outDir, { recursive: true, force: true }).catch(
				() => undefined
			);
		}
		this.publish("recording.playback.stopped", {
			...(this.lastError ? { message: "Playback error" } : {})
		});
		for (const listener of [...this.stoppedListeners]) {
			try {
				listener(this.lastError);
			} catch {
				// Manager cleanup must not depend on diagnostic listeners.
			}
		}
		this.stoppedListeners.clear();
		this.resolveStopped?.();
	}

	private publish(event: string, data: Record<string, unknown>): void {
		this.bus?.publish({
			topic: "recordings",
			event,
			data: {
				recordingId: this.recordingId,
				playbackSessionId: this.sessionId,
				...data
			}
		});
	}
}

/** Only plain MPEG-TS segment names produced by our FFmpeg template are valid. */
export function isSafeRecordingSegmentName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= MAX_RECORDING_SEGMENT_NAME_LENGTH &&
		/^[A-Za-z0-9_-]+\.ts$/.test(name) &&
		!name.includes("..")
	);
}

/** Point bare FFmpeg segment names at the recording-scoped segment route. */
export function exposeRecordingSegmentUris(
	playlist: string,
	sessionId: string,
	viewerId?: string
): string {
	const lineBreak = playlist.includes("\r\n") ? "\r\n" : "\n";
	const query = new URLSearchParams({ session: sessionId });
	if (viewerId) query.set("viewerId", viewerId);
	return playlist
		.split(lineBreak)
		.map((line) =>
			isSafeRecordingSegmentName(line) ? `segments/${line}?${query}` : line
		)
		.join(lineBreak);
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
