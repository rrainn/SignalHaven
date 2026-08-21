import { spawn, type ChildProcess } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	statfs
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type {
	HwaccelKind,
	TranscodeProfile,
	TunerHttpHeaders,
	TunerLease
} from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";

import {
	checkAdaptiveCapacity,
	type AdaptiveCapacityResult
} from "./adaptive-capacity";

import {
	buildFfmpegArgs as buildProfileFfmpegArgs,
	buildAdaptiveFfmpegArgs,
	buildCaptionsFfmpegArgs,
	CAPTIONS_PLAYLIST_NAME,
	escapeCaptionsMovieInput,
	parseFfmpegLine,
	type InputCodecInfo
} from "./transcoder";

/** `auto` selects the complete adaptive graph; named profiles remain locked. */
export type PlaybackProfile = "auto" | TranscodeProfile;

/** The configured encoder cannot safely expose the mandatory adaptive graph. */
export class AdaptiveEncoderCapacityError extends Error {
	constructor(speed: number) {
		super(
			`Adaptive Streaming requires the complete ladder to sustain 1.25x; this encoder measured ${speed.toFixed(2)}x. Select a supported hardware encoder or use a manual quality profile.`
		);
		this.name = "AdaptiveEncoderCapacityError";
	}
}

/** A live source failed before FFmpeg produced a playable HLS manifest. */
export class UpstreamStreamError extends Error {
	readonly category: "input_unreachable" | "invalid_data" | "startup_timeout";

	constructor(
		category: "input_unreachable" | "invalid_data" | "startup_timeout"
	) {
		super("Upstream stream unavailable");
		this.name = "UpstreamStreamError";
		this.category = category;
	}
}

/**
 * Build the FFmpeg arguments used to transcode/remux the upstream URL into a
 * low-latency-friendly HLS playlist + MPEG-TS segments in `outDir`.
 *
 * Thin compatibility wrapper around the profile-aware
 * {@link buildProfileFfmpegArgs} that defaults to the `direct` (passthrough)
 * profile — preserving the original "stream-copy only" semantics for
 * callers that don't yet supply a profile.
 */
export function buildFfmpegArgs(
	input: string,
	outDir: string,
	options: {
		profile?: TranscodeProfile;
		hwaccel?: HwaccelKind | null;
		inputCodecs?: InputCodecInfo;
		httpHeaders?: TunerHttpHeaders;
		captionsEnabled?: boolean;
		timeShiftWindowSeconds?: number;
	} = {}
): string[] {
	return buildProfileFfmpegArgs({
		input,
		outDir,
		profile: options.profile ?? "direct",
		hwaccel: options.hwaccel ?? null,
		captionsEnabled: options.captionsEnabled ?? false,
		...(options.httpHeaders ? { httpHeaders: options.httpHeaders } : {}),
		...(options.timeShiftWindowSeconds !== undefined
			? { timeShiftWindowSeconds: options.timeShiftWindowSeconds }
			: {}),
		...(options.inputCodecs ? { input_codecs: options.inputCodecs } : {})
	});
}

/** Maximum length of a segment file name. Matches the route param schema. */
export const MAX_SEGMENT_NAME_LENGTH = 64;

/**
 * Maximum time we wait for ffmpeg to write its first playlist before
 * declaring the session a failure. Conservative default; can be overridden
 * per-session via {@link StreamSessionOptions.startTimeoutMs}.
 */
export const DEFAULT_START_TIMEOUT_MS = 15_000;

/** Fallback expiry when a browser cannot deliver its unload beacon. */
export const DEFAULT_VIEWER_TIMEOUT_MS = 30_000;

/** Optional inversion-of-control hooks; primarily used by tests. */
export interface StreamSessionRunner {
	/** Spawn the encoder process. Defaults to invoking `ffmpeg`. */
	spawn(args: string[]): ChildProcess;
}

/** Structured logger surface used for one terminal startup-failure record. */
export interface StreamSessionLogger {
	error(context: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: StreamSessionLogger = {
	error: () => {}
};

const DEFAULT_RUNNER: StreamSessionRunner = {
	spawn: (args) =>
		spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
};

export interface StreamSessionOptions {
	/** Stable profile-aware id used to look up and fan out the session. */
	sessionId: string;
	/** Public channel UUID, kept separate from the profile-aware session key. */
	channelId?: string;
	/** Upstream URL fed to ffmpeg. */
	upstreamUrl: string;
	/** Provider-required request headers forwarded to FFmpeg. */
	httpHeaders?: TunerHttpHeaders;
	/** Tuner lease this session owns; released on tear-down. */
	lease: TunerLease;
	/** Hook invoked during tear-down so the manager can release the lease. */
	releaseLease: () => void;
	/** Linger window before tearing down once the last client detaches. */
	lingerMs: number;
	/** Optional bus to publish session lifecycle events. */
	bus?: EventBus | undefined;
	/** Test seam for swapping out the ffmpeg invocation. */
	runner?: StreamSessionRunner;
	/** Application logger used for durable operational diagnostics. */
	logger?: StreamSessionLogger;
	/** Custom temp dir root; defaults to the OS tmp dir. */
	tmpRoot?: string;
	/**
	 * How long to wait for ffmpeg to write its first playlist before the
	 * session is declared dead. Defaults to {@link DEFAULT_START_TIMEOUT_MS}.
	 */
	startTimeoutMs?: number;
	/** Output profile fed to {@link buildProfileFfmpegArgs}. */
	profile?: PlaybackProfile;
	/** Hwaccel backend (already resolved against the user preference). */
	hwaccel?: HwaccelKind | null;
	/** Probed input codec metadata; lets the builder skip needless re-encode. */
	inputCodecs?: InputCodecInfo;
	/**
	 * Extract EIA-608/708 closed captions from the upstream into a WebVTT
	 * subtitle track served alongside the media playlist (rrainn/SignalHaven#23).
	 * Spawns a sidecar ffmpeg whose lifetime is bound to the main session;
	 * its failures are isolated so the video stream survives a missing /
	 * unsupported caption source.
	 */
	captionsEnabled?: boolean;
	/** Retained HLS window in seconds; omitted uses the short live fallback. */
	timeShiftWindowSeconds?: number;
	/** Hard per-session disk ceiling used by the buffer monitor. */
	maxBufferBytes?: number;
	/** Reports current usage so the owning service can enforce its global cap. */
	onBufferUsage?: ((session: StreamSession, bytes: number) => void) | undefined;
	/** Test seam for speeding up disk-limit checks. */
	bufferCheckIntervalMs?: number;
	/** Test seam for observing the files measured by the buffer monitor. */
	bufferStat?: (path: string) => Promise<{ size: number }>;
	/** Inactivity window before an orphaned logical viewer expires. */
	viewerTimeoutMs?: number;
	/** Test seam for the synthetic full-ladder benchmark. */
	capacityChecker?: () => Promise<AdaptiveCapacityResult>;
}

export type StreamSessionState = "starting" | "ready" | "lingering" | "stopped";
export type StreamPipelineHealth = "starting" | "healthy" | "slow" | "stalled";

export interface StreamPipelineStatus {
	mode: "remux" | "transcode";
	health: StreamPipelineHealth;
	speed: number | null;
	fps: number | null;
	outputTimeSeconds: number | null;
	lastProgressAt: string | null;
	progressAgeSeconds: number | null;
}

/**
 * Per-channel streaming session. Owns one ffmpeg process and a temp dir,
 * counts attached HTTP clients, and tears itself down (releasing the tuner
 * lease) after a configurable linger once the last client disconnects.
 *
 * Multiple HTTP clients on the same channel share the same `StreamSession`
 * instance: they call {@link attach} / {@link detach} and read playlist /
 * segment bytes via {@link readPlaylist} / {@link readSegment}.
 */
export class StreamSession {
	readonly sessionId: string;
	readonly lease: TunerLease;
	readonly startedAt = new Date();
	readonly profile: PlaybackProfile;
	readonly hwaccel: HwaccelKind | null;
	readonly captionsEnabled: boolean;

	private readonly upstreamUrl: string;
	private readonly httpHeaders: TunerHttpHeaders | undefined;
	private readonly channelId: string;
	private readonly releaseLease: () => void;
	private readonly lingerMs: number;
	private readonly bus: EventBus | undefined;
	private readonly runner: StreamSessionRunner;
	private readonly logger: StreamSessionLogger;
	private readonly tmpRoot: string;
	private readonly startTimeoutMs: number;
	private readonly inputCodecs: InputCodecInfo | undefined;
	private readonly timeShiftWindowSeconds: number | undefined;
	private readonly maxBufferBytes: number | undefined;
	private readonly onBufferUsage:
		| ((session: StreamSession, bytes: number) => void)
		| undefined;
	private readonly bufferCheckIntervalMs: number;
	private readonly bufferStat: (path: string) => Promise<{ size: number }>;

	private outDir = "";
	private process: ChildProcess | undefined;
	/**
	 * Sidecar ffmpeg that produces the WebVTT captions track, when enabled.
	 * Lives only as long as the main session; its exit/error handlers are
	 * isolated so a dead caption pipeline never tears the video down.
	 */
	private captionsProcess: ChildProcess | undefined;
	private refCount = 0;
	/** Stable browser viewer ids keep short HLS requests tied to one tab. */
	private readonly viewerIds = new Map<string, number>();
	private readonly viewerTimeoutMs: number;
	private viewerTimer: NodeJS.Timeout | undefined;
	private state: StreamSessionState = "starting";
	private lingerTimer: NodeJS.Timeout | undefined;
	/** Resolves when the playlist is first written (or rejects on early exit). */
	private readyPromise: Promise<void> | undefined;
	private resolveReady: (() => void) | undefined;
	private rejectReady: ((err: Error) => void) | undefined;
	private readonly stoppedListeners = new Set<(err?: Error) => void>();
	private startError: Error | undefined;
	/** Set to true exactly once, inside `finalize()`. */
	private finalized = false;
	/** Resolves only after disposable files have been removed. */
	private cleanupPromise: Promise<void> = Promise.resolve();
	/** Tracks whether {@link stop} was called so 'exit' isn't treated as crash. */
	private stopRequested = false;
	/** Most useful sanitized FFmpeg diagnostic, retained only for logging. */
	private lastDiagnostic:
		| { category?: string | undefined; message: string }
		| undefined;
	/** Generic viewer-safe failure surfaced via the status API. */
	private lastError:
		| { category?: string | undefined; message: string; ts: string }
		| undefined;
	/** Prevent duplicate records when both child `error` and `exit` fire. */
	private startupFailureLogged = false;
	private bufferUsageBytes = 0;
	private bufferTimer: NodeJS.Timeout | undefined;
	private checkingBuffer = false;
	/** Finalized HLS segments are immutable, so their sizes only need one stat. */
	private readonly bufferFileSizes = new Map<string, number>();
	/** FFmpeg progress fields accumulated until its next `progress=` marker. */
	private readonly pendingProgress = new Map<string, string>();
	private processingMode: StreamPipelineStatus["mode"] = "remux";
	private latestProgress:
		| {
				speed: number | null;
				fps: number | null;
				outputTimeSeconds: number | null;
				updatedAtMs: number;
		  }
		| undefined;
	/** Sustained under-speed output is an encoder failure, not a network stall. */
	private underSpeedSamples = 0;
	private adaptiveCapacityPassed = false;
	private adaptiveCapacitySpeed: number | null = null;
	private readonly capacityChecker: () => Promise<AdaptiveCapacityResult>;

	constructor(options: StreamSessionOptions) {
		this.sessionId = options.sessionId;
		this.channelId = options.channelId ?? options.sessionId;
		this.upstreamUrl = options.upstreamUrl;
		this.httpHeaders = options.httpHeaders;
		this.lease = options.lease;
		this.releaseLease = options.releaseLease;
		this.lingerMs = options.lingerMs;
		this.bus = options.bus;
		this.runner = options.runner ?? DEFAULT_RUNNER;
		this.logger = options.logger ?? NOOP_LOGGER;
		this.tmpRoot = options.tmpRoot ?? tmpdir();
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.profile = options.profile ?? "direct";
		this.hwaccel = options.hwaccel ?? null;
		this.captionsEnabled = options.captionsEnabled ?? false;
		this.inputCodecs = options.inputCodecs;
		this.timeShiftWindowSeconds = options.timeShiftWindowSeconds;
		this.maxBufferBytes = options.maxBufferBytes;
		this.onBufferUsage = options.onBufferUsage;
		this.bufferCheckIntervalMs = options.bufferCheckIntervalMs ?? 5_000;
		this.bufferStat = options.bufferStat ?? stat;
		this.viewerTimeoutMs = Math.max(
			1,
			options.viewerTimeoutMs ?? DEFAULT_VIEWER_TIMEOUT_MS
		);
		this.capacityChecker =
			options.capacityChecker ??
			(options.runner
				? async () => ({ passed: true, speed: 1.25 })
				: () => checkAdaptiveCapacity(this.hwaccel));
	}

	/**
	 * Spawns ffmpeg and resolves once the playlist is written (i.e. the session
	 * is ready to serve clients). Should only be called once; subsequent
	 * callers should use {@link waitForReady}.
	 */
	async start(): Promise<void> {
		if (this.process) {
			return this.waitForReady();
		}

		if (this.profile === "auto") {
			const capacity = await this.capacityChecker();
			this.adaptiveCapacityPassed = capacity.passed;
			this.adaptiveCapacitySpeed = capacity.speed;
			if (!capacity.passed) {
				this.lastError = {
					category: "encoder_capacity",
					message: "Adaptive encoder failed the sustained 1.25x capacity check",
					ts: new Date().toISOString()
				};
				const error = new AdaptiveEncoderCapacityError(capacity.speed);
				this.startError = error;
				this.publish("session.error", {
					category: "encoder_capacity",
					message: this.lastError.message
				});
				this.finalize(error);
				throw error;
			}
		}

		// A configured time-shift root may not exist yet on a fresh install.
		await mkdir(this.tmpRoot, { recursive: true });
		this.outDir = await mkdtemp(
			join(this.tmpRoot, `signalhaven-stream-${process.pid}-`)
		);
		if (this.profile === "auto") {
			// FFmpeg writes each rendition atomically but does not create `%v` folders.
			await Promise.all(
				["1080p", "720p", "480p"].map((rendition) =>
					mkdir(join(this.outDir, rendition), { recursive: true })
				)
			);
		}
		const args =
			this.profile === "auto"
				? buildAdaptiveFfmpegArgs({
						input: this.upstreamUrl,
						...(this.httpHeaders ? { httpHeaders: this.httpHeaders } : {}),
						outDir: this.outDir,
						hwaccel: this.hwaccel,
						...(this.timeShiftWindowSeconds !== undefined
							? { timeShiftWindowSeconds: this.timeShiftWindowSeconds }
							: {}),
						...(this.inputCodecs ? { input_codecs: this.inputCodecs } : {})
					})
				: buildFfmpegArgs(this.upstreamUrl, this.outDir, {
						profile: this.profile,
						...(this.httpHeaders ? { httpHeaders: this.httpHeaders } : {}),
						hwaccel: this.hwaccel,
						captionsEnabled: this.captionsEnabled,
						...(this.timeShiftWindowSeconds !== undefined
							? { timeShiftWindowSeconds: this.timeShiftWindowSeconds }
							: {}),
						...(this.inputCodecs ? { inputCodecs: this.inputCodecs } : {})
					});
		this.processingMode = ffmpegProcessingMode(args);

		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});

		let child: ChildProcess;
		try {
			child = this.runner.spawn(args);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.startError = error;
			this.state = "stopped";
			void this.cleanupTmp();
			this.releaseLease();
			this.logStartupFailure(null, null, error);
			this.publish("session.error", { message: "Playback error" });
			throw error;
		}
		this.process = child;
		this.publish("session.started", {});

		// Parse every stderr line so the terminal log can retain the most useful
		// error without writing the chatty output from a healthy ffmpeg.
		//
		// ffmpeg writes its diagnostics in arbitrary chunk sizes, so a single
		// logical line can be split across multiple `data` events (and a
		// single chunk can hold many lines plus a trailing partial). Buffer
		// the tail until we see a newline so we never classify half a line
		// as a separate message.
		let stderrBuffer = "";
		const consume = (raw: string): void => {
			const line = redactUpstreamDiagnostic(raw.trimEnd(), this.upstreamUrl);
			if (line.length === 0) {
				return;
			}
			if (this.consumeProgressLine(line)) {
				return;
			}
			const parsed = parseFfmpegLine(line);
			if (parsed.level === "error") {
				const diagnostic = {
					...(parsed.category !== undefined
						? { category: parsed.category }
						: {}),
					message: sanitizeDiagnostic(parsed.message, this.upstreamUrl)
				};
				// Prefer categorized errors over generic trailing FFmpeg summaries.
				if (
					diagnostic.category !== undefined ||
					this.lastDiagnostic?.category === undefined
				) {
					this.lastDiagnostic = diagnostic;
				}
				this.lastError = {
					...(parsed.category !== undefined
						? { category: parsed.category }
						: {}),
					message: "Playback error",
					ts: new Date().toISOString()
				};
				this.publish("session.error", {
					message: "Playback error"
				});
			}
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString("utf8");
			const parts = stderrBuffer.split(/\r?\n/);
			stderrBuffer = parts.pop() ?? "";
			for (const raw of parts) {
				consume(raw);
			}
		});
		child.stderr?.once("end", () => {
			if (stderrBuffer.length > 0) {
				consume(stderrBuffer);
				stderrBuffer = "";
			}
		});

		child.once("error", (err) => {
			const error = err instanceof Error ? err : new Error(String(err));
			this.startError ??= error;
			this.handleProcessExit(error, null, null);
		});
		child.once("exit", (code, signal) => {
			let error: Error | undefined;
			if (!this.stopRequested && code !== 0 && signal !== "SIGTERM") {
				error = new Error(
					`ffmpeg exited unexpectedly (code=${code ?? "null"}, signal=${
						signal ?? "null"
					})`
				);
			}
			this.handleProcessExit(error, code, signal);
		});

		// Poll the output dir for the playlist; LL-HLS support varies between
		// ffmpeg builds so we look at the file the muxer always writes.
		const playlistPath = join(
			this.outDir,
			this.profile === "auto" ? "master.m3u8" : "playlist.m3u8"
		);
		void this.pollForPlaylist(playlistPath);

		// Adaptive mode keeps one upstream ingest; it never opens a caption sidecar.
		if (this.captionsEnabled && this.profile !== "auto") {
			this.spawnCaptionsSidecar();
		}

		return this.waitForReady();
	}

	/**
	 * Best-effort WebVTT extraction sidecar (rrainn/SignalHaven#23). Failures
	 * here MUST NOT take down the main video session: the upstream may
	 * not carry CC data, may not allow concurrent reads, or may be a
	 * format the lavfi `movie` filter can't open. We log the error,
	 * publish a `session.captions_error` notification, and leave the
	 * video session running without subtitles.
	 */
	private spawnCaptionsSidecar(): void {
		const args = buildCaptionsFfmpegArgs(
			this.upstreamUrl,
			this.outDir,
			this.timeShiftWindowSeconds
		);
		let child: ChildProcess;
		try {
			child = this.runner.spawn(args);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.publish("session.captions_error", { error: error.message });
			return;
		}
		this.captionsProcess = child;

		let stderrBuffer = "";
		const consume = (raw: string): void => {
			const line = redactUpstreamDiagnostic(raw.trimEnd(), this.upstreamUrl);
			if (line.length === 0) {
				return;
			}
			const parsed = parseFfmpegLine(line);
			this.publish("session.captions_log", { line, level: parsed.level });
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString("utf8");
			const parts = stderrBuffer.split(/\r?\n/);
			stderrBuffer = parts.pop() ?? "";
			for (const raw of parts) {
				consume(raw);
			}
		});
		child.stderr?.once("end", () => {
			if (stderrBuffer.length > 0) {
				consume(stderrBuffer);
				stderrBuffer = "";
			}
		});
		child.once("error", (err) => {
			const error = err instanceof Error ? err : new Error(String(err));
			this.publish("session.captions_error", { error: error.message });
		});
		child.once("exit", (code, signal) => {
			this.captionsProcess = undefined;
			// An unexpected exit is informational only — we keep the main
			// session running. The user-visible effect is a missing track.
			if (!this.stopRequested && code !== 0 && signal !== "SIGTERM") {
				this.publish("session.captions_error", {
					error: `captions ffmpeg exited (code=${code ?? "null"}, signal=${
						signal ?? "null"
					})`
				});
			}
		});
	}

	/**
	 * Returns the same promise `start()` resolved with: the playlist exists
	 * (or rejects if the session failed before becoming ready).
	 */
	waitForReady(): Promise<void> {
		if (this.state === "ready") {
			return Promise.resolve();
		}
		if (this.state === "stopped") {
			return Promise.reject(
				this.startError ?? new Error("Stream session has stopped")
			);
		}
		return this.readyPromise ?? Promise.resolve();
	}

	/** Increment the client refcount. Cancels any pending linger tear-down. */
	attach(): void {
		if (this.state === "stopped") {
			throw new Error("Cannot attach to a stopped stream session");
		}
		this.refCount += 1;
		if (this.lingerTimer) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
		if (this.state === "lingering") {
			this.state = "ready";
		}
	}

	/**
	 * Decrement the client refcount. When it drops to zero we start the linger
	 * timer; if no client re-attaches during the linger we tear down ffmpeg
	 * and release the tuner lease.
	 */
	detach(): void {
		if (this.refCount === 0) {
			return;
		}
		this.refCount -= 1;
		if (this.refCount > 0) {
			return;
		}
		if (this.state === "stopped") {
			return;
		}
		this.state = "lingering";
		if (this.lingerMs <= 0) {
			this.stop();
			return;
		}
		this.lingerTimer = setTimeout(() => {
			this.lingerTimer = undefined;
			if (this.refCount === 0 && this.state === "lingering") {
				this.stop();
			}
		}, this.lingerMs);
	}

	/**
	 * Retain this session for one logical player. HLS repeatedly fetches short
	 * resources, so a stable id is required to distinguish viewers from requests.
	 */
	attachViewer(viewerId: string): void {
		if (this.viewerIds.has(viewerId)) {
			this.viewerIds.set(viewerId, Date.now());
			this.scheduleViewerExpiration();
			return;
		}
		this.attach();
		this.viewerIds.set(viewerId, Date.now());
		this.scheduleViewerExpiration();
	}

	/**
	 * Release one logical player and stop immediately when it was the final
	 * registered viewer. Repeated unload beacons are intentionally harmless.
	 */
	detachViewer(viewerId: string): boolean {
		if (!this.viewerIds.delete(viewerId)) {
			return false;
		}
		this.detach();
		if (this.viewerIds.size === 0 && this.state !== "stopped") {
			this.stop();
		}
		return true;
	}

	/** Force tear-down regardless of refcount. Idempotent. */
	stop(): void {
		if (this.finalized) {
			return;
		}
		this.stopRequested = true;
		if (this.lingerTimer) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
		if (this.viewerTimer) {
			clearTimeout(this.viewerTimer);
			this.viewerTimer = undefined;
		}
		// Captions sidecar (if any) is best-effort and isn't tracked by
		// the main exit-driven `finalize()` path; kill it eagerly so it
		// doesn't outlive the video session.
		const captions = this.captionsProcess;
		if (
			captions &&
			captions.exitCode === null &&
			captions.signalCode === null
		) {
			try {
				captions.kill("SIGTERM");
			} catch {
				// Already gone.
			}
		}
		this.captionsProcess = undefined;
		const proc = this.process;
		if (proc && proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.kill("SIGTERM");
				// finalize() runs from the 'exit' handler.
				return;
			} catch {
				// Already gone; fall through to synchronous finalize.
			}
		}
		// Process already exited (or never spawned); tear down synchronously.
		this.finalize();
	}

	/** Current ref count of attached clients (for diagnostics / tests). */
	getRefCount(): number {
		return this.refCount;
	}

	/** Number of browser players currently retaining this session. */
	getViewerCount(): number {
		return this.viewerIds.size;
	}

	getState(): StreamSessionState {
		return this.state;
	}

	/** Viewer-safe error state used by the status route. */
	getLastError():
		| { category?: string | undefined; message: string; ts: string }
		| undefined {
		return this.lastError;
	}

	/** Snapshot of whether FFmpeg is producing playable output in real time. */
	getPipelineStatus(nowMs = Date.now()): StreamPipelineStatus {
		const progress = this.latestProgress;
		const ageSeconds = progress
			? Math.max(0, (nowMs - progress.updatedAtMs) / 1_000)
			: null;
		let health: StreamPipelineHealth;
		if (!progress) {
			health =
				nowMs - this.startedAt.getTime() < 5_000 ? "starting" : "stalled";
		} else if ((ageSeconds ?? 0) > 5) {
			health = "stalled";
		} else if (progress.speed !== null && progress.speed < 0.9) {
			health = "slow";
		} else {
			health = "healthy";
		}

		return {
			mode: this.processingMode,
			health,
			speed: progress?.speed ?? null,
			fps: progress?.fps ?? null,
			outputTimeSeconds: progress?.outputTimeSeconds ?? null,
			lastProgressAt: progress
				? new Date(progress.updatedAtMs).toISOString()
				: null,
			progressAgeSeconds: ageSeconds
		};
	}

	/** Adaptive availability is gated by the configured encoder's live graph. */
	getCapacityStatus(): {
		status: "checking" | "passed" | "not-applicable";
		requiredSpeed: number | null;
		measuredSpeed: number | null;
	} {
		if (this.profile !== "auto") {
			return {
				status: "not-applicable",
				requiredSpeed: null,
				measuredSpeed: null
			};
		}
		return {
			status: this.adaptiveCapacityPassed ? "passed" : "checking",
			requiredSpeed: 1.25,
			measuredSpeed: this.adaptiveCapacitySpeed
		};
	}

	/** Consume one `-progress` key/value line and commit complete samples. */
	private consumeProgressLine(line: string): boolean {
		const match = /^([a-z_]+)=(.*)$/i.exec(line);
		if (!match?.[1]) {
			return false;
		}
		const key = match[1];
		const value = match[2] ?? "";
		this.pendingProgress.set(key, value);
		if (key !== "progress") {
			return true;
		}
		this.latestProgress = {
			speed: parseProgressNumber(this.pendingProgress.get("speed"), /x$/i),
			fps: parseProgressNumber(this.pendingProgress.get("fps")),
			outputTimeSeconds: parseProgressMicroseconds(
				this.pendingProgress.get("out_time_us")
			),
			updatedAtMs: Date.now()
		};
		const speed = this.latestProgress.speed;
		// Live inputs are clocked at ~1.0×; only a real wall-clock deficit is unhealthy.
		if (this.profile === "auto" && speed !== null && speed < 0.95) {
			this.underSpeedSamples += 1;
		} else {
			this.underSpeedSamples = 0;
		}
		if (this.underSpeedSamples >= 5) {
			this.lastError = {
				category: "encoder_capacity",
				message: "Adaptive encoder cannot sustain real-time output",
				ts: new Date().toISOString()
			};
			this.publish("session.error", {
				category: this.lastError.category,
				message: this.lastError.message
			});
			this.stop();
		}
		this.pendingProgress.clear();
		return true;
	}

	/** Subscribe to "session has fully torn down" notifications. */
	onStopped(listener: (err?: Error) => void): () => void {
		if (this.finalized) {
			void this.cleanupPromise.then(() => listener(this.startError));
			return () => {};
		}
		this.stoppedListeners.add(listener);
		return () => this.stoppedListeners.delete(listener);
	}

	/** Read the bytes of a generated segment file by name. */
	async readSegment(name: string): Promise<Buffer> {
		if (!isSafeSegmentName(name)) {
			throw new Error(`Invalid segment name: ${name}`);
		}
		// `basename()` strips any path separators that snuck past the regex —
		// belt-and-braces against path traversal. We then resolve and verify
		// the final path stays inside `outDir` so CodeQL/security scanners can
		// see the containment check explicitly.
		const safeName = basename(name);
		const baseDir = resolve(this.outDir);
		const target = resolve(baseDir, safeName);
		if (
			target !== join(baseDir, safeName) ||
			!target.startsWith(baseDir + sep)
		) {
			throw new Error(`Invalid segment name: ${name}`);
		}
		return readFile(target);
	}

	/** Read the current media playlist. */
	async readPlaylist(mediaTicket?: string, viewerId?: string): Promise<string> {
		if (this.profile === "auto") {
			throw new Error("Adaptive sessions require a rendition playlist");
		}
		const buf = await readFile(join(this.outDir, "playlist.m3u8"));
		return exposeSegmentUris(
			buf.toString("utf8"),
			this.profile,
			mediaTicket,
			viewerId
		);
	}

	/** Read one validated adaptive rendition playlist. */
	async readRenditionPlaylist(
		rendition: string,
		mediaTicket?: string,
		viewerId?: string
	): Promise<string> {
		if (this.profile !== "auto" || !isAdaptiveRendition(rendition)) {
			throw new Error(`Invalid adaptive rendition: ${rendition}`);
		}
		const body = await readFile(
			join(this.outDir, rendition, "playlist.m3u8"),
			"utf8"
		);
		return exposeAdaptiveArtifactUris(body, mediaTicket, viewerId);
	}

	/** Read immutable bytes from a closed rendition directory. */
	async readRenditionSegment(rendition: string, name: string): Promise<Buffer> {
		if (!isAdaptiveRendition(rendition) || !isSafeSegmentName(name)) {
			throw new Error("Invalid adaptive segment path");
		}
		return readFile(join(this.outDir, rendition, basename(name)));
	}

	/** Return FFmpeg's authoritative master or the legacy synthetic master. */
	async readMasterPlaylist(
		viewerId?: string,
		mediaTicket?: string
	): Promise<string> {
		if (this.profile !== "auto") {
			return this.buildMasterPlaylist(viewerId, mediaTicket);
		}
		const body = await readFile(join(this.outDir, "master.m3u8"), "utf8");
		const query = new URLSearchParams({ profile: "auto" });
		if (viewerId) query.set("viewerId", viewerId);
		if (mediaTicket) query.set("mediaTicket", mediaTicket);
		return body.replace(
			/^(?!#)(1080p|720p|480p)\/playlist\.m3u8$/gm,
			`variants/$1/playlist.m3u8?${query.toString()}`
		);
	}

	/**
	 * Read the WebVTT captions playlist (rrainn/SignalHaven#23). FFmpeg waits for its
	 * first caption packet before creating this file, so return an empty live
	 * playlist while the rendition is pending. This keeps the track advertised
	 * and lets HLS players poll normally instead of treating startup as a 404.
	 */
	async readCaptionsPlaylist(
		mediaTicket?: string,
		viewerId?: string
	): Promise<string> {
		if (this.profile === "auto") {
			throw new Error("Adaptive captions remain in the shared ingest graph");
		}
		try {
			const buf = await readFile(join(this.outDir, CAPTIONS_PLAYLIST_NAME));
			return exposeSegmentUris(
				buf.toString("utf8"),
				this.profile,
				mediaTicket,
				viewerId
			);
		} catch (error) {
			if (isFileNotFoundError(error)) {
				return buildPendingCaptionsPlaylist();
			}
			throw error;
		}
	}

	/**
	 * Build a synthetic master playlist that points at the relative media
	 * playlist. Peak and average bandwidth values are chosen from the session
	 * profile. Video codec metadata is omitted when the copy path or encoder
	 * can produce different AVC profiles and levels for different inputs.
	 *
	 * When captions extraction is enabled (rrainn/SignalHaven#23) the master
	 * also declares a `SUBTITLES` rendition group pointing at the WebVTT
	 * playlist produced by the per-session caption sidecar; HLS players
	 * with native track support pick it up automatically.
	 */
	buildMasterPlaylist(viewerId?: string, mediaTicket?: string): string {
		if (this.profile === "auto") {
			throw new Error("Adaptive master playlists are generated by FFmpeg");
		}
		const { bandwidth, averageBandwidth, codecs } = masterMetaFor(this.profile);
		const query = new URLSearchParams({ profile: this.profile });
		if (viewerId) {
			query.set("viewerId", viewerId);
		}
		if (mediaTicket) query.set("mediaTicket", mediaTicket);
		const profileQuery = `?${query.toString()}`;
		const subtitlesAttr = this.captionsEnabled ? `,SUBTITLES="subs"` : "";
		const averageBandwidthAttr =
			averageBandwidth === null ? "" : `,AVERAGE-BANDWIDTH=${averageBandwidth}`;
		const streamInf =
			codecs === null
				? `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${averageBandwidthAttr}${subtitlesAttr}`
				: `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${averageBandwidthAttr},CODECS="${codecs}"${subtitlesAttr}`;
		const lines: string[] = [
			"#EXTM3U",
			"#EXT-X-VERSION:6",
			"#EXT-X-INDEPENDENT-SEGMENTS"
		];
		if (this.captionsEnabled) {
			lines.push(
				`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Captions",` +
					`AUTOSELECT=YES,DEFAULT=NO,FORCED=NO,` +
					`URI="${CAPTIONS_PLAYLIST_NAME}${profileQuery}"`
			);
		}
		lines.push(streamInf, `playlist.m3u8${profileQuery}`, "");
		return lines.join("\n");
	}

	// ---------- internals ----------

	private async pollForPlaylist(playlistPath: string): Promise<void> {
		const start = Date.now();
		while (this.state === "starting") {
			try {
				await readFile(playlistPath);
				if (
					this.state === "starting" &&
					(this.profile !== "auto" || this.adaptiveCapacityPassed)
				) {
					this.state = "ready";
					this.resolveReady?.();
					this.publish("session.ready", {});
					this.startBufferMonitor();
				}
				if (this.state !== "starting") return;
			} catch {
				// Not ready yet.
			}
			if (Date.now() - start > this.startTimeoutMs) {
				const err =
					this.profile === "auto" && !this.adaptiveCapacityPassed
						? new Error(
								"Adaptive encoder failed the sustained 1.25x capacity check"
							)
						: new UpstreamStreamError("startup_timeout");
				if (this.profile === "auto" && !this.adaptiveCapacityPassed) {
					this.lastError = {
						category: "encoder_capacity",
						message:
							"Adaptive encoder cannot sustain the complete quality ladder",
						ts: new Date().toISOString()
					};
				}
				this.startError = err;
				this.rejectReady?.(err);
				this.logStartupFailure(null, null, err);
				this.stop();
				return;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	/** Refresh the fallback timeout from the oldest active viewer heartbeat. */
	private scheduleViewerExpiration(): void {
		if (this.viewerTimer) {
			clearTimeout(this.viewerTimer);
			this.viewerTimer = undefined;
		}
		if (this.viewerIds.size === 0 || this.state === "stopped") {
			return;
		}
		const oldestSeenAt = Math.min(...this.viewerIds.values());
		const delay = Math.max(0, oldestSeenAt + this.viewerTimeoutMs - Date.now());
		this.viewerTimer = setTimeout(() => {
			this.viewerTimer = undefined;
			this.expireInactiveViewers();
		}, delay);
		this.viewerTimer.unref?.();
	}

	/** Remove viewers whose playlist heartbeat disappeared without a beacon. */
	private expireInactiveViewers(): void {
		const cutoff = Date.now() - this.viewerTimeoutMs;
		let expired = 0;
		for (const [viewerId, seenAt] of this.viewerIds) {
			if (seenAt <= cutoff) {
				this.viewerIds.delete(viewerId);
				expired += 1;
			}
		}
		for (let index = 0; index < expired; index += 1) {
			this.detach();
		}
		if (expired > 0 && this.viewerIds.size === 0 && this.state !== "stopped") {
			this.stop();
			return;
		}
		this.scheduleViewerExpiration();
	}

	private handleProcessExit(
		error: Error | undefined,
		exitCode: number | null,
		signal: NodeJS.Signals | null
	): void {
		if (this.finalized) {
			return;
		}
		if (this.lingerTimer) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
		const reportedError = error ? this.classifyStartupError(error) : undefined;
		if (reportedError && this.rejectReady) {
			this.rejectReady(reportedError);
		}
		if (reportedError && this.state === "starting" && !this.stopRequested) {
			this.logStartupFailure(exitCode, signal, error ?? reportedError);
		}
		this.finalize(reportedError);
	}

	/** Keep infrastructure failures distinct while making source failures actionable. */
	private classifyStartupError(error: Error): Error {
		if (this.state !== "starting") return error;
		const category = this.lastDiagnostic?.category;
		if (category === "input_unreachable" || category === "invalid_data") {
			return new UpstreamStreamError(category);
		}
		return error;
	}

	/** Emit the single durable summary required to diagnose startup failures. */
	private logStartupFailure(
		exitCode: number | null,
		signal: NodeJS.Signals | null,
		fallbackError: Error
	): void {
		if (this.startupFailureLogged) {
			return;
		}
		this.startupFailureLogged = true;
		const diagnostic = this.lastDiagnostic ?? {
			category: "ffmpeg_process_failed",
			message: sanitizeDiagnostic(fallbackError.message, this.upstreamUrl)
		};
		this.logger.error(
			{
				channelId: this.channelId,
				providerId: this.lease.providerId,
				profile: this.profile,
				hwaccel: this.hwaccel ?? "none",
				exitCode,
				signal,
				...(diagnostic.category !== undefined
					? { errorCategory: diagnostic.category }
					: {}),
				errorMessage: diagnostic.message
			},
			"Stream session failed to start"
		);
	}

	private finalize(error?: Error): void {
		if (this.finalized) {
			return;
		}
		this.finalized = true;
		if (this.bufferTimer) {
			clearInterval(this.bufferTimer);
			this.bufferTimer = undefined;
		}
		if (this.viewerTimer) {
			clearTimeout(this.viewerTimer);
			this.viewerTimer = undefined;
		}
		this.onBufferUsage?.(this, 0);
		this.bufferFileSizes.clear();
		this.state = "stopped";
		if (this.startError === undefined && error) {
			this.startError = error;
		}
		// Reap the captions sidecar in case the main process exited on its
		// own (without anyone calling `stop()`); we don't want a stray
		// ffmpeg outliving the session.
		const captions = this.captionsProcess;
		if (
			captions &&
			captions.exitCode === null &&
			captions.signalCode === null
		) {
			try {
				captions.kill("SIGTERM");
			} catch {
				// Already gone.
			}
		}
		this.captionsProcess = undefined;
		this.cleanupPromise = this.cleanupTmp();
		try {
			this.releaseLease();
		} catch {
			// Already released; ignore.
		}
		this.publish("session.stopped", error ? { message: "Playback error" } : {});
		void this.cleanupPromise.finally(() => {
			for (const listener of [...this.stoppedListeners]) {
				try {
					listener(error);
				} catch {
					// Listener errors must not break tear-down.
				}
			}
			this.stoppedListeners.clear();
		});
	}

	private async cleanupTmp(): Promise<void> {
		if (!this.outDir) {
			return;
		}
		try {
			await rm(this.outDir, { recursive: true, force: true });
		} catch {
			// Best-effort; the OS will GC tmpdirs eventually.
		}
	}

	/** Stop a session whose disposable media exceeded the configured budget. */
	stopForBufferLimit(totalBytes: number, maxBytes: number): void {
		if (this.finalized || this.stopRequested) {
			return;
		}
		this.lastError = {
			category: "time_shift_disk_limit",
			message: "The live TV buffer reached its disk limit.",
			ts: new Date().toISOString()
		};
		this.logger.error(
			{
				channelId: this.channelId,
				sessionId: this.sessionId,
				bufferBytes: this.bufferUsageBytes,
				totalBufferBytes: totalBytes,
				maxBufferBytes: maxBytes
			},
			"Time-shift buffer reached its disk limit"
		);
		this.publish("session.buffer_limit", {
			message: this.lastError.message,
			bufferBytes: this.bufferUsageBytes,
			totalBufferBytes: totalBytes,
			maxBufferBytes: maxBytes
		});
		this.stop();
	}

	/** End playback promptly when a higher-priority recording takes the tuner. */
	stopForPreemption(): void {
		if (this.finalized || this.stopRequested) {
			return;
		}
		this.lastError = {
			category: "tuner_preempted",
			message: "Live TV stopped because the tuner was needed for a recording.",
			ts: new Date().toISOString()
		};
		this.publish("session.preempted", { message: this.lastError.message });
		this.stop();
	}

	/** Snapshot used by the status route and operational diagnostics. */
	getTimeShiftStatus(): {
		enabled: boolean;
		windowSeconds: number;
		bufferBytes: number;
		maxBufferBytes: number | null;
	} {
		return {
			enabled: this.timeShiftWindowSeconds !== undefined,
			windowSeconds: this.timeShiftWindowSeconds ?? 0,
			bufferBytes: this.bufferUsageBytes,
			maxBufferBytes: this.maxBufferBytes ?? null
		};
	}

	/** Periodically measures the disposable directory without blocking playback. */
	private startBufferMonitor(): void {
		if (this.maxBufferBytes === undefined || this.bufferTimer) {
			return;
		}
		void this.checkBufferUsage();
		this.bufferTimer = setInterval(() => {
			void this.checkBufferUsage();
		}, this.bufferCheckIntervalMs);
		this.bufferTimer.unref?.();
	}

	private async checkBufferUsage(): Promise<void> {
		if (this.checkingBuffer || this.finalized || !this.outDir) {
			return;
		}
		this.checkingBuffer = true;
		try {
			const [entries, filesystem] = await Promise.all([
				readdir(this.outDir, { withFileTypes: true }),
				statfs(this.outDir)
			]);
			const fileNames = new Set(
				entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
			);
			// FFmpeg deletes old segments as the rolling window advances.
			const nextFileSizes = new Map(
				[...this.bufferFileSizes].filter(([name]) => fileNames.has(name))
			);
			const measuredFiles = await Promise.all(
				[...fileNames]
					.filter(
						(name) => !nextFileSizes.has(name) || isMutableBufferFile(name)
					)
					.map(async (name) => {
						try {
							const file = await this.bufferStat(join(this.outDir, name));
							return [name, file.size] as const;
						} catch (error) {
							// Segment deletion can race the directory scan on an active stream.
							if (isFileNotFoundError(error)) {
								return [name, undefined] as const;
							}
							throw error;
						}
					})
			);
			// Cleanup can finish while filesystem calls are still in flight.
			if (this.finalized) {
				return;
			}
			for (const [name, size] of measuredFiles) {
				if (size === undefined) {
					nextFileSizes.delete(name);
				} else {
					nextFileSizes.set(name, size);
				}
			}
			this.bufferFileSizes.clear();
			for (const [name, size] of nextFileSizes) {
				this.bufferFileSizes.set(name, size);
			}
			this.bufferUsageBytes = [...this.bufferFileSizes.values()].reduce(
				(total, size) => total + size,
				0
			);
			this.onBufferUsage?.(this, this.bufferUsageBytes);
			if (
				!this.onBufferUsage &&
				this.maxBufferBytes !== undefined &&
				this.bufferUsageBytes > this.maxBufferBytes
			) {
				this.stopForBufferLimit(this.bufferUsageBytes, this.maxBufferBytes);
				return;
			}

			const availableBytes = Number(filesystem.bavail * filesystem.bsize);
			const minimumFreeBytes = 128 * 1024 ** 2;
			if (availableBytes < minimumFreeBytes) {
				this.stopForBufferLimit(
					this.bufferUsageBytes,
					this.maxBufferBytes ?? this.bufferUsageBytes
				);
			}
		} catch (error) {
			if (!this.finalized) {
				this.publish("session.buffer_check_error", {
					message:
						error instanceof Error ? error.message : "Buffer check failed"
				});
			}
		} finally {
			this.checkingBuffer = false;
		}
	}

	private publish(event: string, data: Record<string, unknown>): void {
		if (!this.bus) {
			return;
		}
		this.bus.publish({
			topic: "tuners",
			event,
			data: {
				sessionId: this.sessionId,
				leaseId: this.lease.leaseId,
				...data
			}
		});
	}
}

/**
 * Removes the upstream URL from FFmpeg diagnostics before they leave the
 * session boundary. The captions sidecar may print lavfi's escaped form,
 * while either process can print the original URL with tuner credentials or
 * sensitive query parameters.
 */
function redactUpstreamDiagnostic(line: string, upstreamUrl: string): string {
	const redaction = "<redacted upstream URL>";
	const escapedUrl = escapeCaptionsMovieInput(upstreamUrl);

	return [...new Set([upstreamUrl, escapedUrl])]
		.filter((candidate) => candidate.length > 0)
		.sort((left, right) => right.length - left.length)
		.reduce(
			(diagnostic, candidate) => diagnostic.split(candidate).join(redaction),
			line
		);
}

/** Detect whether any selected codec requires real-time encoding. */
function ffmpegProcessingMode(args: readonly string[]): "remux" | "transcode" {
	for (let index = 0; index < args.length - 1; index += 1) {
		if (["-c", "-c:v", "-c:a"].includes(args[index] ?? "")) {
			if (args[index + 1] !== "copy") return "transcode";
		}
	}
	return "remux";
}

/** Parse finite progress values while accepting FFmpeg's unit suffixes. */
function parseProgressNumber(
	value: string | undefined,
	suffix?: RegExp
): number | null {
	if (!value || value === "N/A") return null;
	const normalized = suffix ? value.replace(suffix, "") : value;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Convert FFmpeg's microsecond progress clock to seconds. */
function parseProgressMicroseconds(value: string | undefined): number | null {
	const parsed = parseProgressNumber(value);
	return parsed === null ? null : parsed / 1_000_000;
}

/** Remove URLs and common secret-bearing parameters from retained messages. */
function sanitizeDiagnostic(line: string, upstreamUrl: string): string {
	return redactUpstreamDiagnostic(line, upstreamUrl)
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<redacted URL>")
		.replace(
			/\b(token|access_token|api_key|apikey|password|passwd|secret|authorization|auth)=([^\s&]+)/gi,
			"$1=<redacted>"
		);
}

/**
 * Reject anything that isn't a plain segment file in our output dir. Stops
 * `..`/path traversal, absolute paths, and accidental fetches of the
 * playlist via the segment route.
 */
function isSafeSegmentName(name: string): boolean {
	if (name.length === 0 || name.length > MAX_SEGMENT_NAME_LENGTH) {
		return false;
	}
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		return false;
	}
	if (name.startsWith(".") || name.includes("..")) {
		return false;
	}
	return (
		name.endsWith(".ts") ||
		name.endsWith(".m4s") ||
		name.endsWith(".mp4") ||
		name.endsWith(".vtt")
	);
}

/** Closed rendition names keep adaptive filesystem access non-user-controlled. */
function isAdaptiveRendition(value: string): boolean {
	return value === "1080p" || value === "720p" || value === "480p";
}

/** Identify the expected pending-file state without hiding other I/O errors. */
function isFileNotFoundError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

/** Identify FFmpeg outputs whose contents can grow or be atomically replaced. */
function isMutableBufferFile(name: string): boolean {
	return name.endsWith(".m3u8") || name.endsWith(".tmp");
}

/** Build a live subtitle rendition that remains valid before the first cue. */
function buildPendingCaptionsPlaylist(): string {
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		"#EXT-X-TARGETDURATION:6",
		"#EXT-X-MEDIA-SEQUENCE:0",
		""
	].join("\n");
}

/**
 * Point FFmpeg's bare output names at the public segment route and pin every
 * request to this session's profile. Pinning avoids a settings change or a
 * concurrent profile from sending later playlist requests to another session.
 */
function exposeSegmentUris(
	playlist: string,
	profile: TranscodeProfile,
	mediaTicket?: string,
	viewerId?: string
): string {
	const lineBreak = playlist.includes("\r\n") ? "\r\n" : "\n";
	const query = new URLSearchParams({ profile });
	if (mediaTicket) query.set("mediaTicket", mediaTicket);
	if (viewerId) query.set("viewerId", viewerId);
	const profileQuery = `?${query.toString()}`;
	return playlist
		.split(lineBreak)
		.map((line) =>
			isSafeSegmentName(line) ? `segments/${line}${profileQuery}` : line
		)
		.join(lineBreak);
}

/** Route fMP4 initialization and media fragments through the validated API path. */
function exposeAdaptiveArtifactUris(
	playlist: string,
	mediaTicket?: string,
	viewerId?: string
): string {
	const query = new URLSearchParams({ profile: "auto" });
	if (mediaTicket) query.set("mediaTicket", mediaTicket);
	if (viewerId) query.set("viewerId", viewerId);
	const serializedQuery = query.toString();
	return playlist
		.replace(
			/#EXT-X-MAP:URI="([^"\r\n]+\.mp4)"/g,
			`#EXT-X-MAP:URI="segments/$1?${serializedQuery}"`
		)
		.replace(
			/^(?!#)([^\r\n]+\.(?:m4s|mp4|ts))$/gm,
			`segments/$1?${serializedQuery}`
		);
}

/**
 * Describe peak and average variant bandwidth for native HLS players.
 * BANDWIDTH must cover peak segment bitrate; under-declaring it causes
 * AVFoundation to reject otherwise valid segments. Video CODECS are omitted
 * because copy paths and encoder-selected AVC levels vary with the input.
 */
function masterMetaFor(profile: TranscodeProfile): {
	bandwidth: number;
	averageBandwidth: number | null;
	codecs: string | null;
} {
	switch (profile) {
		case "audio-only":
			return {
				bandwidth: 256_000,
				averageBandwidth: 192_000,
				codecs: "mp4a.40.2"
			};
		case "480p":
			return {
				bandwidth: 3_000_000,
				averageBandwidth: 1_500_000,
				codecs: null
			};
		case "720p":
			return {
				bandwidth: 7_500_000,
				averageBandwidth: 3_500_000,
				codecs: null
			};
		case "1080p":
			return {
				bandwidth: 15_000_000,
				averageBandwidth: 6_500_000,
				codecs: null
			};
		case "original-quality":
			return {
				bandwidth: 20_000_000,
				averageBandwidth: 8_500_000,
				codecs: null
			};
		case "direct":
		default:
			// Source streams have no encoder ceiling, so use a conservative ATSC peak.
			return { bandwidth: 25_000_000, averageBandwidth: null, codecs: null };
	}
}
