import type {
	HwaccelKind,
	TranscodeProfile,
	TunerLease,
	TunerLeasePurpose
} from "@signalhaven/shared";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventBus } from "../events/event-bus";
import { TunerAllocator } from "../tuners/tuner-allocator";

import {
	StreamSession,
	type StreamSessionLogger,
	type StreamSessionRunner
} from "./stream-session";
import type { InputCodecInfo } from "./transcoder";

/** Default linger window once the last client disconnects. */
export const DEFAULT_LINGER_MS = 10_000;
/** Require a quiet request window after an operator explicitly stops work. */
export const DEFAULT_OPERATOR_STOP_QUIET_MS = 10_000;

/**
 * What the streaming layer needs to learn about a channel before it can
 * spin up an ffmpeg session: which tuner to lease against, what id the
 * provider knows the channel by, and the upstream URL to feed ffmpeg.
 */
export interface ResolvedStreamSource {
	/** Physical source row chosen from a logical channel group. */
	sourceChannelId?: string;
	providerId: string;
	/** Per-tuner channel id (passed to allocator + recorded on the lease). */
	providerChannelId: string;
	/** Upstream URL fed to ffmpeg. */
	upstreamUrl: string;
	/** Optional probe data for the upstream's elementary streams. */
	inputCodecs?: InputCodecInfo;
	/**
	 * Per-channel default profile override. When set and no `?profile=`
	 * query is supplied, this wins over the global default.
	 */
	defaultProfile?: TranscodeProfile;
}

/**
 * Resolves a public channel id (e.g. the `channels.id` UUID exposed by the
 * API) into the upstream coordinates ffmpeg needs. Implementations may
 * lookup the persisted channel row, walk the tuner provider's lineup, etc.
 */
export interface StreamSourceResolver {
	resolve(channelId: string): Promise<ResolvedStreamSource>;
	/** Ordered fallback candidates; legacy resolvers may expose only resolve(). */
	resolveCandidates?(channelId: string): Promise<ResolvedStreamSource[]>;
}

export class ChannelNotStreamableError extends Error {
	constructor(channelId: string, message?: string) {
		super(message ?? `Channel ${channelId} cannot be streamed`);
		this.name = "ChannelNotStreamableError";
	}
}

/** A playlist retry attempted to recreate work explicitly stopped by an operator. */
export class StreamStoppedByOperatorError extends Error {
	constructor(channelId: string) {
		super(`Stream ${channelId} was stopped by an operator`);
		this.name = "StreamStoppedByOperatorError";
	}
}

export interface StreamingServiceOptions {
	allocator: TunerAllocator;
	resolver: StreamSourceResolver;
	bus?: EventBus;
	/** Linger window before tearing down once the last client disconnects. */
	lingerMs?: number;
	/** Quiet window required before an operator-stopped stream may restart. */
	operatorStopQuietMs?: number;
	/** Test seam: swap out the ffmpeg invocation. */
	runner?: StreamSessionRunner;
	/** Application logger used for durable stream failure summaries. */
	logger?: StreamSessionLogger;
	/** Custom temp dir root; defaults to the OS tmp dir. */
	tmpRoot?: string;
	/** Lease priority for live viewers. Defaults to `0`. */
	livePriority?: number;
	/**
	 * Resolves the (profile, hwaccel) pair to use for a session at attach
	 * time. Re-evaluated on every fresh attach so live updates to the
	 * settings document take effect on the next viewer (existing sessions
	 * are not torn down — they simply continue with their original config).
	 */
	transcodingResolver?: TranscodingResolver;
	/** Supplies the current rolling-buffer policy for each new session. */
	timeShiftResolver?: TimeShiftResolver;
	/** Test seam for expiring viewers whose unload beacon is lost. */
	viewerTimeoutMs?: number;
}

/** Resolved disposable-buffer policy used for one live session. */
export interface TimeShiftSessionConfig {
	enabled: boolean;
	bufferPath: string | null;
	durationSeconds: number;
	maxDiskBytes: number;
	idleGraceMs: number;
}

export interface TimeShiftResolver {
	resolve(): Promise<TimeShiftSessionConfig>;
}

/**
 * Pluggable supplier of the per-attach transcoding configuration. The
 * default resolver is supplied by `app.ts`, where it consults the
 * `SettingsService` for the current default profile + hwaccel preference.
 */
export interface TranscodingResolver {
	/**
	 * @param requestedProfile - The `?profile=` query value, or `undefined`
	 *   when the route default should be used.
	 * @param channelDefault   - Per-channel default profile (when set).
	 */
	resolve(
		requestedProfile: TranscodeProfile | undefined,
		channelDefault: TranscodeProfile | undefined
	): Promise<{
		profile: TranscodeProfile;
		hwaccel: HwaccelKind | null;
		captionsEnabled: boolean;
	}>;
}

const DEFAULT_TRANSCODING_RESOLVER: TranscodingResolver = {
	resolve: async (requestedProfile) => ({
		profile: requestedProfile ?? "direct",
		hwaccel: null,
		captionsEnabled: false
	})
};

const DISABLED_TIME_SHIFT: TimeShiftSessionConfig = {
	enabled: false,
	bufferPath: null,
	durationSeconds: 0,
	maxDiskBytes: 0,
	idleGraceMs: 0
};

const DEFAULT_TIME_SHIFT_RESOLVER: TimeShiftResolver = {
	resolve: async () => DISABLED_TIME_SHIFT
};

interface PendingSession {
	session: StreamSession;
	ready: Promise<StreamSession>;
}

/**
 * Coordinates per-channel `StreamSession`s. Multiple HTTP clients on the
 * same channel are fanned out to a single ffmpeg process (and a single
 * tuner lease). When the last client detaches the session lingers for a
 * short window before tearing down — handles channel-flipping by the same
 * viewer without thrashing the tuner.
 *
 * Sessions are keyed on `(channelId, profile)` so two viewers asking for
 * the same channel at different qualities each get their own ffmpeg
 * process (each consuming its own tuner lease — the allocator handles
 * preempting recordings if capacity runs out).
 */
export class StreamingService {
	private readonly allocator: TunerAllocator;
	private readonly resolver: StreamSourceResolver;
	private readonly bus: EventBus | undefined;
	private readonly lingerMs: number;
	private readonly operatorStopQuietMs: number;
	private readonly runner: StreamSessionRunner | undefined;
	private readonly logger: StreamSessionLogger | undefined;
	private readonly tmpRoot: string | undefined;
	private readonly livePriority: number;
	private readonly purpose: TunerLeasePurpose = "live";
	private readonly transcodingResolver: TranscodingResolver;
	private readonly timeShiftResolver: TimeShiftResolver;
	private readonly viewerTimeoutMs: number | undefined;
	private readonly unsubscribeFromTuners: (() => void) | undefined;

	/**
	 * One entry per active (or starting) session, keyed by
	 * `${channelId}::${profile}`. Cleared when the underlying session has
	 * fully torn down.
	 */
	private readonly sessions = new Map<string, PendingSession>();
	/** Restart barriers keep stale HLS retries from undoing an operator stop. */
	private readonly operatorStopBarriers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	/** Latest disposable-byte measurement for global quota enforcement. */
	private readonly bufferUsage = new Map<
		StreamSession,
		{ bytes: number; maxBytes: number }
	>();
	/** One orphan-cleanup pass per configured disposable root. */
	private readonly preparedBufferRoots = new Map<string, Promise<void>>();

	constructor(options: StreamingServiceOptions) {
		this.allocator = options.allocator;
		this.resolver = options.resolver;
		this.bus = options.bus;
		this.lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
		this.operatorStopQuietMs =
			options.operatorStopQuietMs ?? DEFAULT_OPERATOR_STOP_QUIET_MS;
		this.runner = options.runner;
		this.logger = options.logger;
		this.tmpRoot = options.tmpRoot;
		this.livePriority = options.livePriority ?? 0;
		this.transcodingResolver =
			options.transcodingResolver ?? DEFAULT_TRANSCODING_RESOLVER;
		this.timeShiftResolver =
			options.timeShiftResolver ?? DEFAULT_TIME_SHIFT_RESOLVER;
		this.viewerTimeoutMs = options.viewerTimeoutMs;
		this.unsubscribeFromTuners = this.bus?.subscribe("tuners", (message) => {
			if (message.event !== "lease.preempted") {
				return;
			}
			const leaseId = (message.data as { lease?: { leaseId?: unknown } }).lease
				?.leaseId;
			if (typeof leaseId !== "string") {
				return;
			}
			for (const entry of this.sessions.values()) {
				if (entry.session.lease.leaseId === leaseId) {
					entry.session.stopForPreemption();
				}
			}
		});
	}

	/**
	 * Attach a new HTTP client to the stream for `channelId`. Resolves the
	 * channel, picks a profile (per-call override > channel default >
	 * settings default > `direct`), acquires a tuner lease (the first time
	 * for this `(channelId, profile)`), spawns ffmpeg (the first time), and
	 * increments the refcount. Subsequent attaches at the same profile
	 * reuse the existing session.
	 *
	 * The caller MUST eventually invoke `session.detach()` for every
	 * successful `attach()` (typically from a request `close` handler).
	 */
	async attach(
		channelId: string,
		requestedProfile?: TranscodeProfile
	): Promise<StreamSession> {
		const sources = this.resolver.resolveCandidates
			? await this.resolver.resolveCandidates(channelId)
			: [await this.resolver.resolve(channelId)];
		const firstSource = sources[0];
		if (!firstSource) {
			throw new ChannelNotStreamableError(channelId);
		}
		const [transcoding, timeShift] = await Promise.all([
			this.transcodingResolver.resolve(
				requestedProfile,
				firstSource.defaultProfile
			),
			this.timeShiftResolver.resolve()
		]);
		const bufferRoot = timeShift.enabled
			? (timeShift.bufferPath ?? this.tmpRoot ?? tmpdir())
			: undefined;
		if (bufferRoot) {
			await this.prepareBufferRoot(bufferRoot);
		}
		const key = sessionKey(channelId, transcoding.profile);
		this.assertNotOperatorStopped(key, channelId);

		const existing = this.sessions.get(key);
		if (existing) {
			const session = await existing.ready;
			session.attach();
			return session;
		}

		let source = firstSource;
		let lease: TunerLease | undefined;
		let allocationError: unknown;
		for (const candidate of sources) {
			try {
				lease = await this.allocator.acquire({
					providerId: candidate.providerId,
					channelId: candidate.providerChannelId,
					purpose: this.purpose,
					priority: this.livePriority
				});
				source = candidate;
				break;
			} catch (error) {
				allocationError = error;
			}
		}
		if (!lease)
			throw allocationError ?? new ChannelNotStreamableError(channelId);
		try {
			// Stop may race with tuner allocation, so check again before spawning.
			this.assertNotOperatorStopped(key, channelId);
		} catch (error) {
			this.allocator.release(lease.leaseId);
			throw error;
		}

		const sessionOptions = {
			sessionId: key,
			channelId,
			upstreamUrl: source.upstreamUrl,
			lease,
			releaseLease: () => this.allocator.release(lease.leaseId),
			lingerMs: timeShift.enabled ? timeShift.idleGraceMs : this.lingerMs,
			bus: this.bus,
			profile: transcoding.profile,
			hwaccel: transcoding.hwaccel,
			captionsEnabled: transcoding.captionsEnabled,
			...(source.inputCodecs ? { inputCodecs: source.inputCodecs } : {}),
			...(this.runner ? { runner: this.runner } : {}),
			...(this.logger ? { logger: this.logger } : {}),
			...(this.viewerTimeoutMs !== undefined
				? { viewerTimeoutMs: this.viewerTimeoutMs }
				: {}),
			...(bufferRoot
				? { tmpRoot: bufferRoot }
				: this.tmpRoot
					? { tmpRoot: this.tmpRoot }
					: {}),
			...(timeShift.enabled
				? {
						timeShiftWindowSeconds: timeShift.durationSeconds,
						maxBufferBytes: timeShift.maxDiskBytes,
						onBufferUsage: (active: StreamSession, bytes: number) =>
							this.updateBufferUsage(active, bytes, timeShift.maxDiskBytes)
					}
				: {})
		};
		const session = new StreamSession(sessionOptions);

		session.onStopped(() => {
			this.bufferUsage.delete(session);
			// Drop the session entry only if it hasn't already been replaced.
			const current = this.sessions.get(key);
			if (current && current.session === session) {
				this.sessions.delete(key);
			}
		});

		const ready: Promise<StreamSession> = session
			.start()
			.then(() => session)
			.catch((err) => {
				// Start failed: ensure we don't leak an entry pointing at a dead
				// session. The session itself releases the lease in `finalize()`.
				const current = this.sessions.get(key);
				if (current && current.session === session) {
					this.sessions.delete(key);
				}
				throw err;
			});

		this.sessions.set(key, { session, ready });

		const resolved = await ready;
		resolved.attach();
		return resolved;
	}

	/**
	 * Look up an active session by public channel id. When `profile` is
	 * supplied, returns the session at exactly that profile; otherwise
	 * returns any active session for the channel (preferring exact-match on
	 * the `direct` profile for backward compatibility with callers that
	 * predate profile-aware streaming).
	 */
	getSession(
		channelId: string,
		profile?: TranscodeProfile
	): StreamSession | undefined {
		if (profile) {
			return this.sessions.get(sessionKey(channelId, profile))?.session;
		}
		// Profile not supplied: return any active session for this channel,
		// preferring `direct` (the historical default) when present.
		const direct = this.sessions.get(sessionKey(channelId, "direct"));
		if (direct) {
			return direct.session;
		}
		const prefix = `${channelId}\u001f`;
		for (const [key, entry] of this.sessions) {
			if (key.startsWith(prefix)) {
				return entry.session;
			}
		}
		return undefined;
	}

	/**
	 * Release a browser viewer from an exact profile session. The session owns
	 * idempotency because page lifecycle events may deliver duplicate beacons.
	 */
	releaseViewer(
		channelId: string,
		viewerId: string,
		profile?: TranscodeProfile
	): boolean {
		if (profile) {
			return (
				this.getSession(channelId, profile)?.detachViewer(viewerId) ?? false
			);
		}
		// Auto-profile viewers do not know which backend default was resolved.
		// The UUID is viewer-unique, so search this channel's profile siblings.
		const prefix = `${channelId}\u001f`;
		for (const [key, entry] of this.sessions) {
			if (key.startsWith(prefix) && entry.session.detachViewer(viewerId)) {
				return true;
			}
		}
		return false;
	}

	/** Tear down every active session. Used during shutdown. */
	async stopAll(): Promise<void> {
		for (const timer of this.operatorStopBarriers.values()) {
			clearTimeout(timer);
		}
		this.operatorStopBarriers.clear();
		const pending: Promise<void>[] = [];
		for (const entry of [...this.sessions.values()]) {
			pending.push(
				new Promise<void>((resolve) => {
					entry.session.onStopped(() => resolve());
					entry.session.stop();
				})
			);
		}
		await Promise.all(pending);
		this.unsubscribeFromTuners?.();
	}

	/** Number of currently active (or starting) stream sessions. */
	getActiveSessionCount(): number {
		return this.sessions.size;
	}

	/** Stable operational snapshots for the advanced FFmpeg work page. */
	getActiveSessions(): Array<{
		id: string;
		channelId: string;
		state: string;
		startedAt: string;
		profile: TranscodeProfile;
		hwaccel: HwaccelKind | null;
		clientCount: number;
	}> {
		return [...this.sessions.entries()].map(([id, entry]) => ({
			id,
			channelId: id.split("\u001f", 1)[0] ?? id,
			state: entry.session.getState(),
			startedAt: entry.session.startedAt.toISOString(),
			profile: entry.session.profile,
			hwaccel: entry.session.hwaccel,
			clientCount: entry.session.getRefCount()
		}));
	}

	/** Stop exactly one operator-selected session without affecting siblings. */
	stopSession(id: string): boolean {
		const entry = this.sessions.get(id);
		if (!entry) return false;
		this.extendOperatorStopBarrier(id);
		entry.session.stop();
		return true;
	}

	/** Reject retries until this stream has received no requests for one window. */
	private assertNotOperatorStopped(key: string, channelId: string): void {
		if (!this.operatorStopBarriers.has(key)) {
			return;
		}
		this.extendOperatorStopBarrier(key);
		throw new StreamStoppedByOperatorError(channelId);
	}

	/** Extend a restart barrier so continuously retrying players stay stopped. */
	private extendOperatorStopBarrier(key: string): void {
		const existing = this.operatorStopBarriers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			if (this.operatorStopBarriers.get(key) === timer) {
				this.operatorStopBarriers.delete(key);
			}
		}, this.operatorStopQuietMs);
		timer.unref?.();
		this.operatorStopBarriers.set(key, timer);
	}

	/** Enforce one aggregate allowance across every profile/channel buffer. */
	private updateBufferUsage(
		session: StreamSession,
		bytes: number,
		maxBytes: number
	): void {
		if (bytes <= 0) {
			this.bufferUsage.delete(session);
			return;
		}
		this.bufferUsage.set(session, { bytes, maxBytes });
		const totalBytes = [...this.bufferUsage.values()].reduce(
			(total, item) => total + item.bytes,
			0
		);
		if (totalBytes <= maxBytes) {
			return;
		}

		// Prefer dropping an idle buffer; otherwise stop the session whose
		// latest write crossed the hard global boundary.
		const idle = [...this.bufferUsage.keys()].find(
			(candidate) => candidate.getRefCount() === 0
		);
		const victim = idle ?? session;
		this.bufferUsage.delete(victim);
		victim.stopForBufferLimit(totalBytes, maxBytes);
	}

	/** Remove directories left by processes that no longer exist. */
	private prepareBufferRoot(root: string): Promise<void> {
		const existing = this.preparedBufferRoots.get(root);
		if (existing) {
			return existing;
		}
		const preparing = (async () => {
			await mkdir(root, { recursive: true });
			const entries = await readdir(root, { withFileTypes: true });
			await Promise.all(
				entries
					.filter(
						(entry) =>
							entry.isDirectory() &&
							entry.name.startsWith("signalhaven-stream-")
					)
					.map(async (entry) => {
						const owner = /^signalhaven-stream-(\d+)-/.exec(entry.name)?.[1];
						if (owner && isProcessRunning(Number(owner))) {
							return;
						}
						await rm(join(root, entry.name), { recursive: true, force: true });
					})
			);
		})();
		this.preparedBufferRoots.set(root, preparing);
		return preparing;
	}
}

/** A permission error still proves that the owning process exists. */
function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function sessionKey(channelId: string, profile: TranscodeProfile): string {
	// Use the ASCII Unit Separator control character (0x1f) so a channelId
	// containing the visually similar `::` sequence (allowed by the route
	// schema's permissive 1-128 char regex) cannot collide with the
	// composite key. Profiles are a closed enum so the suffix is safe.
	return `${channelId}\u001f${profile}`;
}
