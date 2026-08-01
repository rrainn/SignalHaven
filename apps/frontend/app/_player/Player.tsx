"use client";

import type {
	ChannelQuality,
	CommercialMarker,
	PlaybackStallCause,
	StreamStatus,
	TranscodeProfile
} from "@signalhaven/shared";
import {
	Airplay,
	Captions,
	CaptionsOff,
	CircleHelp,
	Maximize,
	Minimize,
	Pause,
	PictureInPicture2,
	Play,
	Radio,
	RotateCcw,
	SlidersHorizontal,
	Volume2,
	VolumeX
} from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent
} from "react";

import { Button } from "../_ui/Button";
import { IconButton } from "../_ui/IconButton";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "../_ui/Select";
import { Slider } from "../_ui/Slider";
import { Spinner } from "../_ui/Spinner";
import { cn } from "../_ui/cn";
import { useAdvancedModeOptional } from "../_advanced/AdvancedModeProvider";
import { getChannelQuality, getStreamStatus } from "../../lib/api-client";
import { reportPlaybackTelemetry } from "../../lib/playback-telemetry";
import { useHls, type HlsModule } from "./useHls";

/**
 * Quality options surfaced in the picker. Mirrors the S2 transcode
 * profile enum from `@signalhaven/shared`, plus a virtual `auto` entry that
 * defers to the backend's per-stream default. The labels are
 * intentionally short for the picker's narrow trigger.
 */
export type PlayerQuality = "auto" | TranscodeProfile;

/**
 * Minimal duck-typed shape we rely on from the HLS.js Hls instance. Used
 * instead of the real type so the player module can avoid importing
 * `hls.js` types eagerly (the runtime module is only dynamically
 * `import()`-ed from {@link useHls}).
 */
interface HlsInstance {
	destroy(): void;
	loadSource(url: string): void;
	stopLoad(): void;
	attachMedia(el: HTMLMediaElement): void;
	recoverMediaError(): void;
	on(event: string, handler: (...args: unknown[]) => void): void;
	/** Mutable latency target allows gradual recovery after a stable period. */
	readonly config?: {
		liveSyncDuration?: number;
		liveSyncOnStallIncrease?: number;
	};
	readonly bandwidthEstimate?: number;
	readonly currentLevel?: number;
	/** HLS.js derives live-edge latency from playlist timing more accurately than TimeRanges. */
	readonly latency?: number;
	/** Playback target that already accounts for playlist timing and recent stalls. */
	readonly liveSyncPosition?: number | null;
	readonly levels?: Array<{
		bitrate?: number;
		width?: number;
		height?: number;
	}>;
}

interface PlaybackStats {
	streamBitrateMbps: number | null;
	connectionMbps: number | null;
	resolution: string;
	fps: number | null;
	bufferedSeconds: number;
	bufferEvents: BufferEventSummary;
	latencySeconds: number | null;
	droppedFrames: number | null;
	totalFrames: number | null;
	profile: string | null;
	hwaccel: string | null;
	serverState: string | null;
	classifiedCause: string | null;
	capacityStatus: string | null;
	pipeline: {
		mode: "remux" | "transcode";
		health: "starting" | "healthy" | "slow" | "stalled";
		speed: number | null;
		fps: number | null;
		progressAgeSeconds: number | null;
	} | null;
	sourceQuality: ChannelQuality | null;
	timeShift: {
		enabled: boolean;
		windowSeconds: number;
		bufferBytes: number;
	} | null;
}

/** Completed playback interruptions caused by depleted media buffers. */
interface BufferEventSummary {
	count: number;
	averageDurationSeconds: number | null;
	minimumDurationSeconds: number | null;
	maximumDurationSeconds: number | null;
}

/** Mutable buffering telemetry kept outside React's render cycle. */
interface BufferEventAccumulator {
	playbackStarted: boolean;
	activeStartedAt: number | null;
	count: number;
	totalDurationMs: number;
	minimumDurationMs: number | null;
	maximumDurationMs: number | null;
}

/** Loading phases explain whether the player is starting or recovering. */
type LoadingStage =
	| "connecting"
	| "preparing"
	| "buffering"
	| "reconnecting"
	| "returning-live";

const QUALITY_LABELS: Record<PlayerQuality, string> = {
	auto: "Auto",
	direct: "Direct",
	"original-quality": "Original resolution",
	"1080p": "1080p",
	"720p": "720p",
	"480p": "480p",
	"audio-only": "Audio only"
};

/** Short guidance keeps codec strategy understandable without exposing FFmpeg. */
const QUALITY_DESCRIPTIONS: Partial<Record<PlayerQuality, string>> = {
	auto: "Choose the most reliable profile",
	direct: "No conversion",
	"original-quality": "Convert for browser playback",
	"audio-only": "Play audio without video"
};

const LOADING_STAGE_LABELS: Record<LoadingStage, string> = {
	connecting: "Connecting to stream",
	preparing: "Preparing stream",
	buffering: "Buffering video",
	reconnecting: "Reconnecting playback",
	"returning-live": "Returning to live TV"
};

const ALL_QUALITIES: PlayerQuality[] = [
	"auto",
	"direct",
	"original-quality",
	"1080p",
	"720p",
	"480p",
	"audio-only"
];

/** Grace period (ms) after pointer activity before auto-hiding controls. */
const CONTROLS_HIDE_DELAY_MS = 2_500;
/** Maximum gap (ms) between two taps to count as a double-tap seek. */
const DOUBLE_TAP_WINDOW_MS = 300;
/** Seek delta applied by ←/→ arrows or double-tap (recordings only). */
const SEEK_STEP_SECONDS = 10;
/** Volume delta applied by ↑/↓ arrows. */
const VOLUME_STEP = 0.05;
/** Give MediaSource a moment to settle before the second recovery attempt. */
const HLS_MEDIA_RECOVERY_DELAY_MS = 1_000;
/** Keep automatic recovery useful without allowing an infinite loop. */
const HLS_MEDIA_RECOVERY_MAX_ATTEMPTS = 2;
/** Avoid Safari's unstable exact seekable-end boundary. */
const LIVE_EDGE_SEEK_BACKOFF_SECONDS = 0.5;
/** Seek further into buffered media when the first Go Live attempt stalls. */
const GO_LIVE_RECOVERY_BACKOFF_SECONDS = 2;
/** Bound each Go Live attempt so the loading overlay cannot persist forever. */
const GO_LIVE_STALL_TIMEOUT_MS = 4_000;
/** Smooth short decoder scheduling spikes without hiding sustained FPS changes. */
const FRAME_RATE_SMOOTHING_WEIGHT = 0.25;
/** Reliability-first target, raised after stalls and recovered after stability. */
const LIVE_TARGET_SECONDS = 6;
const LIVE_STALL_INCREASE_SECONDS = 2;
const LIVE_MAX_LATENCY_SECONDS = 18;
const LIVE_STABLE_RECOVERY_DELAY_MS = 120_000;
const LIVE_RECOVERY_INTERVAL_MS = 60_000;

export interface PlayerPersistence {
	/** Latest known volume in [0..1]; player initialises from this. */
	volume: number;
	muted: boolean;
	/** Whether captions should be on by default. */
	captionsEnabled: boolean;
	/** Quality pinned for *this* channel; `undefined` means follow `auto`. */
	quality: PlayerQuality | undefined;
}

export interface PlayerSavePayload {
	volume?: number;
	muted?: boolean;
	captionsEnabled?: boolean;
	/** When set the caller pins this profile for the player's channelId. */
	quality?: PlayerQuality;
}

export interface PlayerProps {
	/** Channel id used to build the master playlist URL + persist quality. */
	channelId: string;
	/** Human-readable channel or recording name retained during startup. */
	mediaTitle?: string | undefined;
	/** Optional program or episode context shown beneath the media title. */
	mediaSubtitle?: string | undefined;
	/**
	 * Whether this is a recording (vs. live). Affects gestures (double-tap
	 * seek is recordings-only per the U6 acceptance criteria) and shows
	 * the seek bar.
	 */
	isRecording?: boolean | undefined;
	/**
	 * Completed recording length from persisted metadata. Progressive HLS
	 * playlists only expose segments generated so far, so this keeps the seek
	 * timeline stable while FFmpeg continues preparing later segments.
	 */
	recordingDurationSeconds?: number | null | undefined;
	/** Absolute timestamp represented by media-element time zero. */
	recordingStartSeconds?: number | undefined;
	/** Request a new lazy transcode window for an unavailable recording time. */
	onRecordingSeek?: ((positionSeconds: number) => void) | undefined;
	/** Normalized commercial regions rendered against the recording timeline. */
	commercialMarkers?: readonly CommercialMarker[] | undefined;
	/**
	 * Master playlist URL. Defaults to the live stream endpoint
	 * (`/api/v1/stream/<channelId>/master.m3u8`).
	 */
	src?: string | undefined;
	/** Persisted preferences; if omitted, sensible defaults are used. */
	initial?: Partial<PlayerPersistence> | undefined;
	/**
	 * Persistence callback invoked whenever the user mutates volume, mute,
	 * captions, or quality. Throwing / rejecting is swallowed so the UI
	 * never throws on a transient settings PATCH failure.
	 */
	onPersist?: ((patch: PlayerSavePayload) => void | Promise<void>) | undefined;
	/**
	 * Optional dismissal callback wired to swipe-down gesture and to the
	 * Escape key while inside a modal context. When unset the gesture is
	 * a no-op (the player is rendered standalone).
	 */
	onDismiss?: (() => void) | undefined;
	/**
	 * Test seam: inject the HLS class so unit tests don't have to spin up
	 * the real (jsdom-incompatible) hls.js bundle.
	 */
	hlsCtorOverride?: HlsModule | undefined;
	className?: string | undefined;
	style?: CSSProperties | undefined;
}

export interface PlayerHandle {
	/** Underlying `<video>` for tests / parent integrations. */
	readonly video: HTMLVideoElement | null;
	/** Absolute position, including a lazy recording session's input offset. */
	readonly playbackPositionSeconds: number;
}

interface SubtitleTrackInfo {
	/** TextTrack id (or fallback index when the runtime doesn't set one). */
	id: string;
	label: string;
	language: string;
	index: number;
}

/** Safari's vendor-prefixed AirPlay surface is not included in TypeScript's DOM types. */
interface AirPlayVideoElement extends HTMLVideoElement {
	readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
	webkitShowPlaybackTargetPicker?: () => void;
}

/** AirPlay target discovery distinguishes initial detection from a known empty list. */
type AirPlayAvailability =
	| "unsupported"
	| "unknown"
	| "available"
	| "not-available";

/** Safari supplies target availability on its vendor-prefixed media event. */
interface AirPlayAvailabilityEvent extends Event {
	readonly availability?: "available" | "not-available";
}

/**
 * Build the master playlist URL for a channel; respects the optional
 * `quality` pin by appending `?profile=<profile>`. `auto` requests the
 * multivariant graph so hls.js can change renditions before buffer exhaustion.
 */
function buildSrc(
	channelId: string,
	quality: PlayerQuality | undefined,
	viewerId?: string
): string {
	const base = `/api/v1/stream/${encodeURIComponent(channelId)}/master.m3u8`;
	const profile = !quality || quality === "auto" ? "auto" : quality;
	const search = new URLSearchParams({ profile });
	if (viewerId) {
		search.set("viewerId", viewerId);
	}
	return `${base}?${search.toString()}`;
}

/** Create the stable id that joins one player's short HLS requests together. */
function createViewerId(): string {
	return crypto.randomUUID();
}

/** Create empty per-source telemetry so quality and channel changes do not mix. */
function createBufferEventAccumulator(): BufferEventAccumulator {
	return {
		playbackStarted: false,
		activeStartedAt: null,
		count: 0,
		totalDurationMs: 0,
		minimumDurationMs: null,
		maximumDurationMs: null
	};
}

/** Convert mutable millisecond totals into the seconds shown by the overlay. */
function summarizeBufferEvents(
	accumulator: BufferEventAccumulator
): BufferEventSummary {
	return {
		count: accumulator.count,
		averageDurationSeconds:
			accumulator.count === 0
				? null
				: accumulator.totalDurationMs / accumulator.count / 1_000,
		minimumDurationSeconds:
			accumulator.minimumDurationMs === null
				? null
				: accumulator.minimumDurationMs / 1_000,
		maximumDurationSeconds:
			accumulator.maximumDurationMs === null
				? null
				: accumulator.maximumDurationMs / 1_000
	};
}

/** Build the beacon URL that releases one logical browser viewer. */
function buildViewerReleaseUrl(
	channelId: string,
	quality: PlayerQuality,
	viewerId: string
): string {
	const query = new URLSearchParams({ profile: quality });
	return `/api/v1/stream/${encodeURIComponent(channelId)}/viewers/${encodeURIComponent(viewerId)}/release?${query.toString()}`;
}

/**
 * Frontend video player (rrainn/SignalHaven#U6-player).
 *
 * Wraps an `<video>` element with HLS.js (lazy-loaded), exposes a custom
 * controls overlay, and wires up keyboard shortcuts + mobile gestures
 * per the U6 acceptance criteria. Persistence is pushed back to the
 * caller via `onPersist` so the component itself stays storage-agnostic.
 */
export const Player = forwardRef<PlayerHandle, PlayerProps>(
	function Player(props, ref) {
		const {
			channelId,
			mediaTitle,
			mediaSubtitle,
			isRecording = false,
			recordingDurationSeconds,
			recordingStartSeconds = 0,
			onRecordingSeek,
			commercialMarkers = [],
			src: srcProp,
			initial,
			onPersist,
			onDismiss,
			hlsCtorOverride,
			className,
			style
		} = props;
		const advancedMode = useAdvancedModeOptional();
		const advancedEnabled = advancedMode?.enabled ?? false;

		const initialVolume = initial?.volume ?? 1;
		const initialMuted = initial?.muted ?? false;
		const initialCaptions = initial?.captionsEnabled ?? false;
		const initialQuality: PlayerQuality = initial?.quality ?? "auto";

		// Refs ────────────────────────────────────────────────────────────────
		const containerRef = useRef<HTMLDivElement | null>(null);
		const videoRef = useRef<HTMLVideoElement | null>(null);
		const hlsInstanceRef = useRef<HlsInstance | null>(null);
		const hlsMediaRecoveryAttemptsRef = useRef(0);
		const hlsMediaRecoveryTimerRef = useRef<number | null>(null);
		const hasLoadedManifestRef = useRef(false);
		const resumeAfterSourceChangeRef = useRef(true);
		// Recording seek windows reuse a zero-based media timeline, so callbacks
		// must prove they still belong to the active window before changing state.
		const sourceGenerationRef = useRef(0);
		const goLiveStallTimerRef = useRef<number | null>(null);
		const goLiveTargetTimeRef = useRef<number | null>(null);
		const lastFatalHlsErrorWasMediaRef = useRef(false);
		const advancedEnabledRef = useRef(advancedEnabled);
		const frameSampleRef = useRef<{
			frames: number;
			at: number;
			fps: number | null;
		} | null>(null);
		const bufferEventAccumulatorRef = useRef<BufferEventAccumulator>(
			createBufferEventAccumulator()
		);
		const playbackRequestedAtRef = useRef(performance.now());
		const stableSinceRef = useRef(performance.now());
		const liveTargetSecondsRef = useRef(LIVE_TARGET_SECONDS);
		const statusRequestInFlightRef = useRef(false);
		const lastTapRef = useRef<{ at: number; side: "left" | "right" | null }>({
			at: 0,
			side: null
		});
		const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const focusWithinRef = useRef(false);
		const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(
			null
		);

		useImperativeHandle(
			ref,
			() => ({
				get video() {
					return videoRef.current;
				},
				get playbackPositionSeconds() {
					return recordingStartSeconds + (videoRef.current?.currentTime ?? 0);
				}
			}),
			[recordingStartSeconds]
		);

		// State ───────────────────────────────────────────────────────────────
		const [quality, setQuality] = useState<PlayerQuality>(initialQuality);
		const [muted, setMuted] = useState<boolean>(initialMuted);
		const [volume, setVolume] = useState<number>(initialVolume);
		const [captionsOn, setCaptionsOn] = useState<boolean>(initialCaptions);
		const [tracks, setTracks] = useState<SubtitleTrackInfo[]>([]);
		const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
		const [playing, setPlaying] = useState(false);
		const [duration, setDuration] = useState(0);
		const [currentTime, setCurrentTime] = useState(0);
		const [scrubPosition, setScrubPosition] = useState<number | null>(null);
		const [seekRange, setSeekRange] = useState({ start: 0, end: 0 });
		const [adaptiveLivePosition, setAdaptiveLivePosition] = useState<
			number | null
		>(null);
		// Native HLS does not expose its latency target, so preserve user intent
		// rather than guessing a connection-specific threshold.
		const [nativeTimeShifted, setNativeTimeShifted] = useState(false);
		const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
		const [isFullscreen, setIsFullscreen] = useState(false);
		const [isPip, setIsPip] = useState(false);
		const [airPlayAvailability, setAirPlayAvailability] =
			useState<AirPlayAvailability>("unsupported");
		const [isAirPlaying, setIsAirPlaying] = useState(false);
		const [controlsVisible, setControlsVisible] = useState(true);
		const [focusWithin, setFocusWithin] = useState(false);
		const [loading, setLoading] = useState(true);
		const [loadingStage, setLoadingStage] =
			useState<LoadingStage>("connecting");
		const [error, setError] = useState<string | null>(null);
		const [errorDetail, setErrorDetail] = useState<string | null>(null);
		const [secondaryControlsOpen, setSecondaryControlsOpen] = useState(false);
		const [controlsHelpOpen, setControlsHelpOpen] = useState(false);
		const [fullscreenSupported, setFullscreenSupported] = useState(false);
		const [pipSupported, setPipSupported] = useState(false);
		const [extraStats, setExtraStats] = useState(false);
		const [contextMenu, setContextMenu] = useState<{
			x: number;
			y: number;
		} | null>(null);
		const [playbackStats, setPlaybackStats] = useState<PlaybackStats | null>(
			null
		);

		useEffect(() => {
			advancedEnabledRef.current = advancedEnabled;
			if (!advancedEnabled) {
				setExtraStats(false);
				setContextMenu(null);
			}
		}, [advancedEnabled]);

		useEffect(() => {
			const video = videoRef.current as
				| (HTMLVideoElement & {
						requestPictureInPicture?: () => Promise<unknown>;
				  })
				| null;
			const doc = document as Document & { pictureInPictureEnabled?: boolean };
			setFullscreenSupported(
				typeof containerRef.current?.requestFullscreen === "function"
			);
			setPipSupported(
				Boolean(doc.pictureInPictureEnabled && video?.requestPictureInPicture)
			);
		}, []);

		const knownRecordingDuration =
			isRecording &&
			recordingDurationSeconds !== null &&
			recordingDurationSeconds !== undefined &&
			Number.isFinite(recordingDurationSeconds) &&
			recordingDurationSeconds > 0
				? recordingDurationSeconds
				: 0;
		const timelineDuration = knownRecordingDuration || duration;
		const absoluteCurrentTime = isRecording
			? recordingStartSeconds + currentTime
			: currentTime;
		const displayedCurrentTime = scrubPosition ?? absoluteCurrentTime;
		const activeCommercial = commercialMarkers.find(
			(marker) =>
				absoluteCurrentTime * 1_000 >= marker.startMs &&
				absoluteCurrentTime * 1_000 < marker.endMs
		);

		const viewerId = useMemo(
			() => (srcProp || isRecording ? null : createViewerId()),
			[channelId, isRecording, quality, srcProp]
		);
		const effectiveSrc = useMemo(
			() => srcProp ?? buildSrc(channelId, quality, viewerId ?? undefined),
			[srcProp, channelId, quality, viewerId]
		);

		useEffect(() => {
			if (!viewerId) return;
			const releaseUrl = buildViewerReleaseUrl(channelId, quality, viewerId);
			let released = false;
			const release = (): void => {
				if (released) return;
				released = true;
				// Beacon survives navigation and tab closure; keepalive is the fallback
				// for browsers that do not expose or cannot queue sendBeacon.
				try {
					if (navigator.sendBeacon?.(releaseUrl)) return;
				} catch {
					// A rejected beacon can still fall back to a keepalive request.
				}
				void fetch(releaseUrl, { method: "POST", keepalive: true }).catch(
					() => undefined
				);
			};
			const restore = (event: PageTransitionEvent): void => {
				if (event.persisted) released = false;
			};
			window.addEventListener("pagehide", release);
			window.addEventListener("pageshow", restore);
			return () => {
				window.removeEventListener("pagehide", release);
				window.removeEventListener("pageshow", restore);
				release();
			};
		}, [channelId, quality, viewerId]);

		useEffect(() => {
			if (!isRecording) return;
			// Each offset URL exposes a fresh relative media timeline beginning at
			// zero, while the controls continue presenting absolute DVR time.
			const video = videoRef.current;
			if (video) video.currentTime = 0;
			setCurrentTime(0);
		}, [isRecording, recordingStartSeconds]);

		useEffect(() => {
			// A new source starts under automatic live-edge management.
			setAdaptiveLivePosition(null);
			setNativeTimeShifted(false);
			bufferEventAccumulatorRef.current = createBufferEventAccumulator();
			playbackRequestedAtRef.current = performance.now();
			stableSinceRef.current = performance.now();
			liveTargetSecondsRef.current = LIVE_TARGET_SECONDS;
		}, [effectiveSrc]);

		// ── HLS setup ─────────────────────────────────────────────────────────
		const {
			Hls: hlsLoaded,
			nativeHls: detectedNative,
			loadError,
			reload
		} = useHls(!hlsCtorOverride);
		const HlsCtor = hlsCtorOverride ?? hlsLoaded ?? null;
		const hlsJsSupported =
			hlsCtorOverride !== undefined || Boolean(hlsLoaded?.isSupported());
		// HLS.js handles source transport streams more consistently than Safari's
		// native decoder. Native HLS remains available for platforms without MSE.
		const useNativeHls =
			hlsCtorOverride === undefined &&
			detectedNative &&
			(loadError !== null || (hlsLoaded !== null && !hlsJsSupported));
		const playbackUnsupported =
			hlsCtorOverride === undefined &&
			hlsLoaded !== null &&
			!hlsJsSupported &&
			!detectedNative;

		// Source attachment re-runs when the playlist changes. The video element
		// remains mounted; live sources reuse HLS.js while zero-based recording
		// windows replace its MediaSource to keep their timelines isolated.
		useEffect(() => {
			const video = videoRef.current;
			if (!video) return;
			const sourceGeneration = ++sourceGenerationRef.current;
			const isCurrentSource = (): boolean =>
				!isRecording || sourceGenerationRef.current === sourceGeneration;
			if (!hasLoadedManifestRef.current) {
				resumeAfterSourceChangeRef.current = true;
			}
			const preservePlaybackIntent = (): void => {
				// Source cleanup can pause media, so capture intent before detaching it.
				if (hasLoadedManifestRef.current) {
					resumeAfterSourceChangeRef.current = !video.paused;
				}
			};
			setLoading(true);
			setLoadingStage("connecting");
			setError(null);
			setErrorDetail(null);

			if (useNativeHls) {
				setLoadingStage("preparing");
				video.src = effectiveSrc;
				if (resumeAfterSourceChangeRef.current) {
					// Best-effort autoplay; modern browsers gate this behind muted.
					const playPromise = video.play();
					if (playPromise && typeof playPromise.catch === "function") {
						playPromise.catch(() => {
							/* user gesture required; controls let them recover */
						});
					}
				}
				hasLoadedManifestRef.current = true;
				return () => {
					preservePlaybackIntent();
					video.removeAttribute("src");
					video.load();
				};
			}

			if (!HlsCtor || !hlsJsSupported) return; // still loading or unsupported

			// Reuse existing hls instance across quality changes — only the
			// playlist URL needs to change.
			let hls = hlsInstanceRef.current;
			if (!hls) {
				const real = new HlsCtor(
					isRecording
						? {
								// Recordings trade latency for resilience under sustained throttling.
								maxBufferLength: 60,
								maxMaxBufferLength: 120,
								startFragPrefetch: true
							}
						: {
								liveSyncDuration: LIVE_TARGET_SECONDS,
								liveMaxLatencyDuration: LIVE_MAX_LATENCY_SECONDS,
								liveSyncOnStallIncrease: LIVE_STALL_INCREASE_SECONDS,
								maxLiveSyncPlaybackRate: 1.05,
								abrBandWidthFactor: 0.8,
								abrBandWidthUpFactor: 0.65
							}
				);
				const createdHls = real as unknown as HlsInstance;
				hls = createdHls;
				hlsInstanceRef.current = createdHls;
				createdHls.attachMedia(video);
				// Exhaust bounded media recovery before asking the user to retry.
				const Events = (
					HlsCtor as unknown as { Events: Record<string, string> }
				).Events;
				const ErrorTypes = (
					HlsCtor as unknown as { ErrorTypes?: Record<string, string> }
				).ErrorTypes;
				const errorEvent = Events["ERROR"] ?? "hlsError";
				const manifestEvent = Events["MANIFEST_PARSED"] ?? "hlsManifestParsed";
				const levelSwitchedEvent =
					Events["LEVEL_SWITCHED"] ?? "hlsLevelSwitched";
				const mediaErrorType = ErrorTypes?.["MEDIA_ERROR"] ?? "mediaError";
				createdHls.on(errorEvent, (..._args: unknown[]) => {
					if (!isCurrentSource()) return;
					const data = _args[1] as
						| {
								fatal?: boolean;
								type?: string;
								details?: string;
								reason?: string;
								response?: { code?: number; text?: string };
						  }
						| undefined;
					if (data?.fatal) {
						reportPlaybackTelemetry({
							event: "fatal_error",
							media: isRecording ? "recording" : "live",
							client: "web",
							profile: quality,
							cause: data.type === mediaErrorType ? "decoder" : "network"
						});
						lastFatalHlsErrorWasMediaRef.current = data.type === mediaErrorType;
						if (data.type === mediaErrorType) {
							// Ignore duplicate fatal events while the delayed recovery is
							// already pending; they describe the same failed pipeline.
							if (hlsMediaRecoveryTimerRef.current !== null) {
								setError(null);
								setLoading(true);
								setLoadingStage(
									bufferEventAccumulatorRef.current.playbackStarted
										? "reconnecting"
										: "preparing"
								);
								return;
							}
							const attempt = hlsMediaRecoveryAttemptsRef.current;
							if (attempt < HLS_MEDIA_RECOVERY_MAX_ATTEMPTS) {
								hlsMediaRecoveryAttemptsRef.current = attempt + 1;
								setError(null);
								setLoading(true);
								setLoadingStage(
									bufferEventAccumulatorRef.current.playbackStarted
										? "reconnecting"
										: "preparing"
								);
								if (attempt === 0) {
									createdHls.recoverMediaError();
								} else {
									// The second attempt replaces the successful manual Retry
									// users previously had to click during startup.
									hlsMediaRecoveryTimerRef.current = window.setTimeout(() => {
										hlsMediaRecoveryTimerRef.current = null;
										if (hlsInstanceRef.current === createdHls) {
											createdHls.recoverMediaError();
										}
									}, HLS_MEDIA_RECOVERY_DELAY_MS);
								}
								return;
							}
						}
						if (hlsMediaRecoveryTimerRef.current !== null) {
							window.clearTimeout(hlsMediaRecoveryTimerRef.current);
							hlsMediaRecoveryTimerRef.current = null;
						}
						setError("Playback stopped. Try again or switch Quality to Auto.");
						setErrorDetail(formatPlaybackDiagnostic(data));
						setLoading(false);
						if (advancedEnabledRef.current && !isRecording) {
							void getStreamStatus(channelId, quality)
								.then((status) => {
									if (status.lastError) {
										setErrorDetail(
											formatExternalDiagnostic(status.lastError.message)
										);
									}
								})
								.catch(() => undefined);
						}
					}
				});
				createdHls.on(levelSwitchedEvent, (...args: unknown[]) => {
					if (!isCurrentSource()) return;
					const data = args[1] as { level?: number } | undefined;
					const level =
						typeof data?.level === "number"
							? createdHls.levels?.[data.level]
							: undefined;
					const rendition =
						level?.height === 1080 ||
						level?.height === 720 ||
						level?.height === 480
							? (`${level.height}p` as "1080p" | "720p" | "480p")
							: "unknown";
					reportPlaybackTelemetry({
						event: "rendition_changed",
						media: isRecording ? "recording" : "live",
						client: "web",
						profile: rendition,
						cause: "unknown"
					});
				});
				createdHls.on(manifestEvent, () => {
					if (!isCurrentSource()) return;
					lastFatalHlsErrorWasMediaRef.current = false;
					setLoading(true);
					setLoadingStage("buffering");
					hasLoadedManifestRef.current = true;
					if (resumeAfterSourceChangeRef.current) {
						const playPromise = video.play();
						if (playPromise && typeof playPromise.catch === "function") {
							playPromise.catch(() => undefined);
						}
					}
				});
			}
			// A new source deserves its own bounded automatic recovery attempts.
			if (hlsMediaRecoveryTimerRef.current !== null) {
				window.clearTimeout(hlsMediaRecoveryTimerRef.current);
				hlsMediaRecoveryTimerRef.current = null;
			}
			if (goLiveStallTimerRef.current !== null) {
				window.clearTimeout(goLiveStallTimerRef.current);
				goLiveStallTimerRef.current = null;
			}
			goLiveTargetTimeRef.current = null;
			hlsMediaRecoveryAttemptsRef.current = 0;
			lastFatalHlsErrorWasMediaRef.current = false;
			setLoadingStage("preparing");
			hls.loadSource(effectiveSrc);
			return () => {
				preservePlaybackIntent();
				if (isRecording) {
					// Lazy windows all begin at media time zero. Reusing their SourceBuffer
					// can mix old and new fragments at identical timestamps after a seek.
					sourceGenerationRef.current += 1;
					if (hlsInstanceRef.current === hls) {
						try {
							hls.destroy();
						} catch {
							/* A concurrent media teardown already released the pipeline. */
						}
						hlsInstanceRef.current = null;
					}
					return;
				}
				// Live profile changes retain one timeline and can safely reuse MSE.
				hls.stopLoad();
			};
		}, [effectiveSrc, HlsCtor, hlsJsSupported, isRecording, useNativeHls]);

		// Sample browser and server playback state only while the operator overlay is visible.
		useEffect(() => {
			if (!advancedEnabled || !extraStats) return;
			let disposed = false;
			const sample = () => {
				const video = videoRef.current;
				if (!video) return;
				const hls = hlsInstanceRef.current;
				const qualityInfo = video.getVideoPlaybackQuality?.();
				const now = performance.now();
				let fps: number | null = null;
				if (qualityInfo) {
					const previous = frameSampleRef.current;
					if (previous && now > previous.at) {
						const decodedFrames =
							qualityInfo.totalVideoFrames - previous.frames;
						// A stall says nothing about the source frame rate. Preserve the
						// last useful sample instead of making FPS plunge toward zero.
						if (decodedFrames <= 0) {
							fps = previous.fps;
						} else {
							const sampledFps = (decodedFrames * 1_000) / (now - previous.at);
							// Decoder timing has harmless short spikes, so keep the overlay
							// readable while still converging when the source rate changes.
							fps =
								previous.fps === null
									? sampledFps
									: previous.fps * (1 - FRAME_RATE_SMOOTHING_WEIGHT) +
										sampledFps * FRAME_RATE_SMOOTHING_WEIGHT;
						}
					}
					frameSampleRef.current = {
						frames: qualityInfo.totalVideoFrames,
						at: now,
						fps
					};
				}
				const bufferedEnd = getCurrentBufferedEnd(video);
				const seekableEnd = video.seekable.length
					? video.seekable.end(video.seekable.length - 1)
					: null;
				const level = hls?.levels?.[hls.currentLevel ?? -1];
				setPlaybackStats({
					streamBitrateMbps: level?.bitrate ? level.bitrate / 1_000_000 : null,
					connectionMbps: hls?.bandwidthEstimate
						? hls.bandwidthEstimate / 1_000_000
						: null,
					resolution:
						video.videoWidth && video.videoHeight
							? `${video.videoWidth}×${video.videoHeight}`
							: level?.width && level.height
								? `${level.width}×${level.height}`
								: "Unknown",
					fps,
					bufferedSeconds: Math.max(0, bufferedEnd - video.currentTime),
					bufferEvents: summarizeBufferEvents(
						bufferEventAccumulatorRef.current
					),
					latencySeconds: isRecording
						? null
						: Number.isFinite(hls?.latency)
							? Math.max(0, hls?.latency ?? 0)
							: seekableEnd === null
								? null
								: Math.max(0, seekableEnd - video.currentTime),
					droppedFrames: qualityInfo?.droppedVideoFrames ?? null,
					totalFrames: qualityInfo?.totalVideoFrames ?? null,
					profile: isRecording ? "recording playback" : null,
					hwaccel: null,
					serverState: null,
					classifiedCause: null,
					capacityStatus: null,
					pipeline: null,
					sourceQuality: null,
					timeShift: null
				});
				if (!isRecording && !statusRequestInFlightRef.current) {
					statusRequestInFlightRef.current = true;
					void Promise.allSettled([
						getStreamStatus(channelId, quality),
						getChannelQuality(channelId)
					])
						.then(([serverResult, qualityResult]) => {
							if (disposed) return;
							setPlaybackStats((current) =>
								current
									? {
											...current,
											...(serverResult.status === "fulfilled"
												? {
														profile: serverResult.value.profile,
														hwaccel: serverResult.value.hwaccel,
														serverState: serverResult.value.state,
														classifiedCause:
															serverResult.value.lastError?.category ??
															(serverResult.value.pipeline.health === "healthy"
																? null
																: classifyStallCause(serverResult.value)),
														capacityStatus: serverResult.value.capacity.status,
														pipeline: serverResult.value.pipeline,
														timeShift: {
															enabled: serverResult.value.timeShift.enabled,
															windowSeconds:
																serverResult.value.timeShift.windowSeconds,
															bufferBytes:
																serverResult.value.timeShift.bufferBytes
														}
													}
												: {}),
											sourceQuality:
												qualityResult.status === "fulfilled" &&
												qualityResult.value.active
													? qualityResult.value
													: null
										}
									: current
							);
						})
						.finally(() => {
							statusRequestInFlightRef.current = false;
						});
				}
			};
			sample();
			const timer = window.setInterval(sample, 2_000);
			return () => {
				disposed = true;
				window.clearInterval(timer);
				frameSampleRef.current = null;
			};
		}, [advancedEnabled, channelId, extraStats, isRecording, quality]);

		// Unmount cleanup for the HLS instance and recovery watchdogs.
		useEffect(() => {
			return () => {
				if (hlsMediaRecoveryTimerRef.current !== null) {
					window.clearTimeout(hlsMediaRecoveryTimerRef.current);
				}
				if (goLiveStallTimerRef.current !== null) {
					window.clearTimeout(goLiveStallTimerRef.current);
				}
				const hls = hlsInstanceRef.current;
				if (hls) {
					try {
						hls.destroy();
					} catch {
						/* swallow cleanup races */
					}
					hlsInstanceRef.current = null;
				}
			};
		}, []);

		// Mirror persistence-derived state to the underlying element.
		useEffect(() => {
			const v = videoRef.current;
			if (!v) return;
			v.volume = volume;
			v.muted = muted;
		}, [volume, muted]);

		// Discover and toggle subtitle tracks (S3 SUBTITLES rendition).
		useEffect(() => {
			const v = videoRef.current;
			if (!v) return;
			const update = () => {
				const list: SubtitleTrackInfo[] = [];
				const textTracks = v.textTracks;
				for (let i = 0; i < textTracks.length; i++) {
					const tt = textTracks[i];
					if (!tt) continue;
					if (tt.kind !== "subtitles" && tt.kind !== "captions") continue;
					list.push({
						id: tt.id || `track-${i}`,
						label: tt.label || tt.language || "Captions",
						language: tt.language || "",
						index: i
					});
				}
				setTracks(list);
				if (list.length > 0 && activeTrackId === null) {
					setActiveTrackId(list[0]!.id);
				}
			};
			update();
			v.textTracks.addEventListener?.("addtrack", update);
			v.textTracks.addEventListener?.("removetrack", update);
			return () => {
				v.textTracks.removeEventListener?.("addtrack", update);
				v.textTracks.removeEventListener?.("removetrack", update);
			};
		}, [activeTrackId, effectiveSrc]);

		// Sync chosen captions state to the actual TextTracks API.
		useEffect(() => {
			const v = videoRef.current;
			if (!v) return;
			const textTracks = v.textTracks;
			for (let i = 0; i < textTracks.length; i++) {
				const tt = textTracks[i];
				if (!tt) continue;
				if (tt.kind !== "subtitles" && tt.kind !== "captions") continue;
				const id = tt.id || `track-${i}`;
				tt.mode = captionsOn && id === activeTrackId ? "showing" : "disabled";
			}
		}, [captionsOn, activeTrackId, tracks]);

		// ── Persistence helpers ───────────────────────────────────────────────
		const persist = useCallback(
			(patch: PlayerSavePayload) => {
				if (!onPersist) return;
				const reportFailure = (): void => {
					setRecoveryMessage(
						"That player preference couldn't be saved. Playback will continue with the current setting."
					);
				};
				try {
					const ret = onPersist(patch);
					if (ret && typeof (ret as Promise<void>).catch === "function") {
						(ret as Promise<void>).catch(reportFailure);
					}
				} catch {
					reportFailure();
				}
			},
			[onPersist]
		);

		// ── Control handlers ──────────────────────────────────────────────────
		const togglePlay = useCallback(() => {
			const v = videoRef.current;
			if (!v) return;
			if (v.paused) {
				const p = v.play();
				if (p && typeof p.catch === "function") {
					p.catch(() => {
						setRecoveryMessage(
							"Playback couldn't start. Select Play again or check this browser's media permissions."
						);
					});
				}
			} else {
				v.pause();
			}
		}, []);

		const setVolumeAndPersist = useCallback(
			(next: number) => {
				const clamped = Math.max(0, Math.min(1, next));
				setVolume(clamped);
				// Tweaking volume implicitly unmutes (matches YouTube/Netflix UX).
				if (clamped > 0 && muted) {
					setMuted(false);
					persist({ volume: clamped, muted: false });
				} else {
					persist({ volume: clamped });
				}
			},
			[muted, persist]
		);

		const toggleMute = useCallback(() => {
			setMuted((prev) => {
				const next = !prev;
				persist({ muted: next });
				return next;
			});
		}, [persist]);

		const toggleCaptions = useCallback(() => {
			setCaptionsOn((prev) => {
				const next = !prev;
				persist({ captionsEnabled: next });
				return next;
			});
		}, [persist]);

		const changeQuality = useCallback(
			(next: PlayerQuality) => {
				setQuality(next);
				persist({ quality: next });
			},
			[persist]
		);

		const toggleFullscreen = useCallback(async () => {
			const el = containerRef.current;
			if (!el) return;
			if (!fullscreenSupported) {
				setRecoveryMessage("Fullscreen isn't available in this browser.");
				return;
			}
			try {
				if (document.fullscreenElement) {
					await document.exitFullscreen?.();
				} else {
					await el.requestFullscreen?.();
				}
			} catch {
				setRecoveryMessage(
					"Fullscreen couldn't open. Check this browser's site permissions and try again."
				);
			}
		}, [fullscreenSupported]);

		const togglePip = useCallback(async () => {
			const v = videoRef.current;
			if (!v) return;
			const doc = document as Document & {
				pictureInPictureEnabled?: boolean;
				pictureInPictureElement?: Element | null;
				exitPictureInPicture?: () => Promise<void>;
			};
			const vid = v as HTMLVideoElement & {
				requestPictureInPicture?: () => Promise<unknown>;
			};
			if (!doc.pictureInPictureEnabled || !vid.requestPictureInPicture) {
				setRecoveryMessage(
					"Picture in picture isn't available in this browser."
				);
				return;
			}
			try {
				if (doc.pictureInPictureElement === v) {
					await doc.exitPictureInPicture?.();
				} else {
					await vid.requestPictureInPicture();
				}
			} catch {
				setRecoveryMessage(
					"Picture in picture couldn't open. Start playback, then try again."
				);
			}
		}, []);

		const showAirPlayPicker = useCallback(() => {
			const video = videoRef.current as AirPlayVideoElement | null;
			if (!video?.webkitShowPlaybackTargetPicker) return;
			try {
				// Safari requires this native picker call to remain inside a user gesture.
				video.webkitShowPlaybackTargetPicker();
			} catch {
				setRecoveryMessage(
					"AirPlay couldn't open while the stream was changing. Try again in a moment."
				);
			}
		}, []);

		const seekRecordingTo = useCallback(
			(requestedSeconds: number) => {
				const v = videoRef.current;
				if (!v) return;
				const lastPlayableSecond = Math.max(0, timelineDuration - 1);
				const target = Math.max(
					0,
					Math.min(lastPlayableSecond, requestedSeconds)
				);
				const relativeTarget = target - recordingStartSeconds;
				let locallySeekable = false;
				for (let index = 0; index < v.seekable.length; index += 1) {
					if (
						relativeTarget >= v.seekable.start(index) &&
						relativeTarget <= v.seekable.end(index)
					) {
						locallySeekable = true;
						break;
					}
				}
				if (locallySeekable || !onRecordingSeek) {
					v.currentTime = relativeTarget;
					setCurrentTime(relativeTarget);
				} else {
					// The parent swaps to a new offset URL, allowing FFmpeg to skip work
					// for the unrequested middle of a long recording.
					onRecordingSeek?.(target);
				}
				setRecoveryMessage(null);
			},
			[onRecordingSeek, recordingStartSeconds, timelineDuration]
		);

		const seekBy = useCallback(
			(deltaSec: number) => {
				const v = videoRef.current;
				if (!v) return;
				if (isRecording) {
					seekRecordingTo(absoluteCurrentTime + deltaSec);
					return;
				}
				const hasLiveRange = !isRecording && v.seekable.length > 0;
				const start = hasLiveRange ? v.seekable.start(0) : 0;
				const end = hasLiveRange
					? v.seekable.end(v.seekable.length - 1)
					: timelineDuration;
				const target = Math.max(start, Math.min(end, v.currentTime + deltaSec));
				v.currentTime = target;
				setCurrentTime(target);
				setNativeTimeShifted(target < end);
			},
			[absoluteCurrentTime, isRecording, seekRecordingTo, timelineDuration]
		);

		const goLive = useCallback(() => {
			const v = videoRef.current;
			if (!v || v.seekable.length === 0) return;
			if (goLiveStallTimerRef.current !== null) {
				window.clearTimeout(goLiveStallTimerRef.current);
			}
			const seekNearLiveEdge = (backoffSeconds: number) => {
				const rangeIndex = v.seekable.length - 1;
				const rangeStart = v.seekable.start(rangeIndex);
				const rangeEnd = v.seekable.end(rangeIndex);
				const hlsTarget = hlsInstanceRef.current?.liveSyncPosition;
				// HLS.js continuously adapts this target to manifest timing and
				// playback stalls. Never seek ahead of it; the boundary backoff
				// still protects native HLS and a deeper recovery attempt.
				const target =
					hlsTarget !== null &&
					hlsTarget !== undefined &&
					Number.isFinite(hlsTarget)
						? Math.max(
								rangeStart,
								Math.min(rangeEnd - backoffSeconds, hlsTarget)
							)
						: Math.max(rangeStart, rangeEnd - backoffSeconds);
				v.currentTime = target;
				setCurrentTime(target);
				setNativeTimeShifted(false);
				goLiveTargetTimeRef.current = target;
			};
			const play = () => {
				const promise = v.play();
				if (promise && typeof promise.catch === "function") {
					promise.catch(() => {
						setRecoveryMessage(
							"Live playback couldn't resume. Select Go Live again or check this browser's media permissions."
						);
					});
				}
			};
			setError(null);
			setRecoveryMessage(null);
			seekNearLiveEdge(LIVE_EDGE_SEEK_BACKOFF_SECONDS);
			goLiveStallTimerRef.current = window.setTimeout(() => {
				// A second seek inside the buffered range avoids Safari repeatedly
				// waiting on a segment that is still being finalized at the edge.
				setLoading(true);
				setLoadingStage("returning-live");
				seekNearLiveEdge(GO_LIVE_RECOVERY_BACKOFF_SECONDS);
				hlsInstanceRef.current?.recoverMediaError();
				play();
				goLiveStallTimerRef.current = window.setTimeout(() => {
					goLiveStallTimerRef.current = null;
					goLiveTargetTimeRef.current = null;
					setLoading(false);
					setError(
						"Playback stalled while returning to live TV. Try again or switch Quality to Auto."
					);
					setErrorDetail("Live-edge recovery timed out after two attempts.");
				}, GO_LIVE_STALL_TIMEOUT_MS);
			}, GO_LIVE_STALL_TIMEOUT_MS);
			play();
		}, []);

		// Poll <video> events for UI state.
		useEffect(() => {
			const v = videoRef.current;
			if (!v) return;
			const onPlay = () => setPlaying(true);
			const onPause = () => setPlaying(false);
			const updateTimeline = () => {
				setCurrentTime(v.currentTime);
				setDuration(Number.isFinite(v.duration) ? v.duration : 0);
				const goLiveTarget = goLiveTargetTimeRef.current;
				if (goLiveTarget !== null && v.currentTime > goLiveTarget + 0.05) {
					if (goLiveStallTimerRef.current !== null) {
						window.clearTimeout(goLiveStallTimerRef.current);
						goLiveStallTimerRef.current = null;
					}
					goLiveTargetTimeRef.current = null;
					setLoading(false);
				}
				if (isRecording || v.seekable.length === 0) return;
				const start = v.seekable.start(0);
				const end = v.seekable.end(v.seekable.length - 1);
				setSeekRange({ start, end });
				const hlsTarget = hlsInstanceRef.current?.liveSyncPosition;
				setAdaptiveLivePosition(
					hlsTarget !== null &&
						hlsTarget !== undefined &&
						Number.isFinite(hlsTarget)
						? hlsTarget
						: null
				);
				if (v.currentTime > 0 && v.currentTime < start - 0.5) {
					v.currentTime = start;
					setCurrentTime(start);
					setNativeTimeShifted(true);
					setRecoveryMessage(
						"The paused program expired from the buffer. Playback resumed at the earliest available point."
					);
					const promise = v.play();
					if (promise && typeof promise.catch === "function") {
						promise.catch(() => undefined);
					}
				}
			};
			const onTime = () => updateTimeline();
			const onDur = () => updateTimeline();
			const onLoadedMetadata = () => {
				updateTimeline();
				if (!bufferEventAccumulatorRef.current.playbackStarted) {
					setLoadingStage("buffering");
				}
			};
			const onWaiting = () => {
				setLoading(true);
				const accumulator = bufferEventAccumulatorRef.current;
				setLoadingStage(
					accumulator.playbackStarted ? "reconnecting" : "buffering"
				);
				// Initial startup delay is load time, not interrupted playback.
				if (
					accumulator.playbackStarted &&
					accumulator.activeStartedAt === null
				) {
					accumulator.activeStartedAt = performance.now();
					stableSinceRef.current = performance.now();
					if (!isRecording && !nativeTimeShifted) {
						liveTargetSecondsRef.current = Math.min(
							LIVE_MAX_LATENCY_SECONDS,
							liveTargetSecondsRef.current + LIVE_STALL_INCREASE_SECONDS
						);
						const config = hlsInstanceRef.current?.config;
						if (config) {
							// Own the target after the first stall so recovery can lower it later.
							config.liveSyncOnStallIncrease = 0;
							config.liveSyncDuration = liveTargetSecondsRef.current;
						}
					}
					reportPlaybackTelemetry({
						event: "stall_started",
						media: isRecording ? "recording" : "live",
						client: "web",
						profile: quality,
						cause: "unknown"
					});
				}
			};
			const onPlaying = () => {
				const accumulator = bufferEventAccumulatorRef.current;
				const wasStarted = accumulator.playbackStarted;
				if (accumulator.activeStartedAt !== null) {
					const durationMs = Math.max(
						0,
						performance.now() - accumulator.activeStartedAt
					);
					accumulator.count += 1;
					accumulator.totalDurationMs += durationMs;
					accumulator.minimumDurationMs = Math.min(
						accumulator.minimumDurationMs ?? durationMs,
						durationMs
					);
					accumulator.maximumDurationMs = Math.max(
						accumulator.maximumDurationMs ?? durationMs,
						durationMs
					);
					const telemetry = {
						event: "stall_ended",
						media: isRecording ? "recording" : "live",
						client: "web",
						profile: quality,
						cause: "unknown",
						durationSeconds: durationMs / 1_000,
						...(!isRecording && hlsInstanceRef.current?.latency !== undefined
							? { latencySeconds: hlsInstanceRef.current.latency }
							: {})
					} as const;
					if (isRecording) {
						reportPlaybackTelemetry(telemetry);
					} else {
						void getStreamStatus(channelId, quality)
							.then((status) => {
								reportPlaybackTelemetry({
									...telemetry,
									cause: classifyStallCause(status)
								});
							})
							.catch(() => reportPlaybackTelemetry(telemetry));
					}
					accumulator.activeStartedAt = null;
				}
				accumulator.playbackStarted = true;
				if (!wasStarted) {
					reportPlaybackTelemetry({
						event: "startup_completed",
						media: isRecording ? "recording" : "live",
						client: "web",
						profile: quality,
						cause: "unknown",
						durationSeconds:
							(performance.now() - playbackRequestedAtRef.current) / 1_000
					});
				}
				setLoading(false);
				hlsMediaRecoveryAttemptsRef.current = 0;
				lastFatalHlsErrorWasMediaRef.current = false;
				if (hlsMediaRecoveryTimerRef.current !== null) {
					window.clearTimeout(hlsMediaRecoveryTimerRef.current);
					hlsMediaRecoveryTimerRef.current = null;
				}
				if (goLiveStallTimerRef.current !== null) {
					window.clearTimeout(goLiveStallTimerRef.current);
					goLiveStallTimerRef.current = null;
				}
				goLiveTargetTimeRef.current = null;
			};
			const onError = () => {
				const mediaError = v.error;
				setError("Playback stopped. Try again or switch Quality to Auto.");
				setErrorDetail(formatMediaError(mediaError));
			};
			const onEnterPip = () => setIsPip(true);
			const onLeavePip = () => setIsPip(false);
			v.addEventListener("play", onPlay);
			v.addEventListener("pause", onPause);
			v.addEventListener("timeupdate", onTime);
			v.addEventListener("durationchange", onDur);
			v.addEventListener("progress", updateTimeline);
			v.addEventListener("loadedmetadata", onLoadedMetadata);
			v.addEventListener("waiting", onWaiting);
			v.addEventListener("playing", onPlaying);
			v.addEventListener("error", onError);
			v.addEventListener("enterpictureinpicture", onEnterPip);
			v.addEventListener("leavepictureinpicture", onLeavePip);
			return () => {
				v.removeEventListener("play", onPlay);
				v.removeEventListener("pause", onPause);
				v.removeEventListener("timeupdate", onTime);
				v.removeEventListener("durationchange", onDur);
				v.removeEventListener("progress", updateTimeline);
				v.removeEventListener("loadedmetadata", onLoadedMetadata);
				v.removeEventListener("waiting", onWaiting);
				v.removeEventListener("playing", onPlaying);
				v.removeEventListener("error", onError);
				v.removeEventListener("enterpictureinpicture", onEnterPip);
				v.removeEventListener("leavepictureinpicture", onLeavePip);
			};
		}, [isRecording, nativeTimeShifted, quality, useNativeHls]);

		// Stable live playback slowly returns to the six-second reliability target.
		useEffect(() => {
			if (isRecording) return;
			const timer = window.setInterval(() => {
				const video = videoRef.current;
				if (
					!video ||
					video.paused ||
					nativeTimeShifted ||
					performance.now() - stableSinceRef.current <
						LIVE_STABLE_RECOVERY_DELAY_MS ||
					liveTargetSecondsRef.current <= LIVE_TARGET_SECONDS
				) {
					return;
				}
				const bufferedAhead =
					video.buffered.length > 0
						? video.buffered.end(video.buffered.length - 1) - video.currentTime
						: 0;
				if (bufferedAhead < LIVE_TARGET_SECONDS) return;
				liveTargetSecondsRef.current = Math.max(
					LIVE_TARGET_SECONDS,
					liveTargetSecondsRef.current - 1
				);
				const config = hlsInstanceRef.current?.config;
				if (config) config.liveSyncDuration = liveTargetSecondsRef.current;
			}, LIVE_RECOVERY_INTERVAL_MS);
			return () => window.clearInterval(timer);
		}, [isRecording, nativeTimeShifted]);

		useEffect(() => {
			return () => {
				const accumulator = bufferEventAccumulatorRef.current;
				reportPlaybackTelemetry({
					event: "session_ended",
					media: isRecording ? "recording" : "live",
					client: "web",
					profile: quality,
					cause: "unknown",
					watchedDurationSeconds: Math.max(
						0,
						(performance.now() - playbackRequestedAtRef.current) / 1_000
					),
					stallDurationSeconds: accumulator.totalDurationMs / 1_000
				});
			};
		}, [isRecording, quality]);

		// Safari exposes AirPlay through vendor-prefixed media events. Registering
		// only when the picker exists avoids target discovery work in other browsers.
		useEffect(() => {
			const video = videoRef.current as AirPlayVideoElement | null;
			if (!video?.webkitShowPlaybackTargetPicker) return;

			setAirPlayAvailability("unknown");
			const onAvailabilityChanged = (event: Event) => {
				const availability = (event as AirPlayAvailabilityEvent).availability;
				if (availability) setAirPlayAvailability(availability);
			};
			const onWirelessTargetChanged = () => {
				setIsAirPlaying(Boolean(video.webkitCurrentPlaybackTargetIsWireless));
			};
			video.addEventListener(
				"webkitplaybacktargetavailabilitychanged",
				onAvailabilityChanged
			);
			video.addEventListener(
				"webkitcurrentplaybacktargetiswirelesschanged",
				onWirelessTargetChanged
			);
			onWirelessTargetChanged();

			return () => {
				video.removeEventListener(
					"webkitplaybacktargetavailabilitychanged",
					onAvailabilityChanged
				);
				video.removeEventListener(
					"webkitcurrentplaybacktargetiswirelesschanged",
					onWirelessTargetChanged
				);
			};
		}, []);

		// Track fullscreen changes initiated externally (Esc key, etc.).
		useEffect(() => {
			const handler = () =>
				setIsFullscreen(Boolean(document.fullscreenElement));
			document.addEventListener("fullscreenchange", handler);
			return () => document.removeEventListener("fullscreenchange", handler);
		}, []);

		// Auto-hide controls a couple seconds after the last interaction.
		const showControls = useCallback(() => {
			setControlsVisible(true);
			if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
			hideTimerRef.current = setTimeout(() => {
				// Don't hide while paused — playing users want a clean view; paused
				// users, keyboard focus, and open utility panels need stable controls.
				const v = videoRef.current;
				if (
					v &&
					!v.paused &&
					!focusWithinRef.current &&
					!secondaryControlsOpen &&
					!controlsHelpOpen
				) {
					setControlsVisible(false);
				}
			}, CONTROLS_HIDE_DELAY_MS);
		}, [controlsHelpOpen, secondaryControlsOpen]);

		useEffect(() => {
			return () => {
				if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
			};
		}, []);

		// ── Keyboard shortcuts ────────────────────────────────────────────────
		const onKeyDown = useCallback(
			(event: KeyboardEvent<HTMLDivElement>) => {
				// Ignore shortcuts originating from form controls inside the overlay.
				const target = event.target as HTMLElement | null;
				if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
				const key = event.key;
				switch (key) {
					case "Escape":
						event.preventDefault();
						if (secondaryControlsOpen || controlsHelpOpen || contextMenu) {
							setSecondaryControlsOpen(false);
							setControlsHelpOpen(false);
							setContextMenu(null);
						} else {
							onDismiss?.();
						}
						break;
					case " ":
					case "k":
					case "K":
						event.preventDefault();
						togglePlay();
						showControls();
						break;
					case "ArrowLeft":
						event.preventDefault();
						if (isRecording || seekRange.end > seekRange.start) {
							seekBy(-SEEK_STEP_SECONDS);
						}
						showControls();
						break;
					case "ArrowRight":
						event.preventDefault();
						if (isRecording || seekRange.end > seekRange.start) {
							seekBy(SEEK_STEP_SECONDS);
						}
						showControls();
						break;
					case "ArrowUp":
						event.preventDefault();
						setVolumeAndPersist(volume + VOLUME_STEP);
						showControls();
						break;
					case "ArrowDown":
						event.preventDefault();
						setVolumeAndPersist(volume - VOLUME_STEP);
						showControls();
						break;
					case "m":
					case "M":
						event.preventDefault();
						toggleMute();
						showControls();
						break;
					case "f":
					case "F":
						event.preventDefault();
						void toggleFullscreen();
						break;
					case "c":
					case "C":
						event.preventDefault();
						toggleCaptions();
						showControls();
						break;
					case "?":
						event.preventDefault();
						setSecondaryControlsOpen(false);
						setControlsHelpOpen((current) => !current);
						showControls();
						break;
					default:
						break;
				}
			},
			[
				isRecording,
				contextMenu,
				controlsHelpOpen,
				onDismiss,
				secondaryControlsOpen,
				seekRange.end,
				seekRange.start,
				seekBy,
				setVolumeAndPersist,
				showControls,
				toggleCaptions,
				toggleFullscreen,
				toggleMute,
				togglePlay,
				volume
			]
		);

		// ── Touch / pointer gestures ──────────────────────────────────────────
		const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
			if (event.pointerType !== "touch") return;
			swipeStartRef.current = {
				x: event.clientX,
				y: event.clientY,
				t: performance.now()
			};
		}, []);

		const onPointerUp = useCallback(
			(event: PointerEvent<HTMLDivElement>) => {
				// Tap handling — single click toggles overlay; double-tap (touch
				// only) on the left/right half seeks within recordings.
				const startedTouch = event.pointerType === "touch";
				const start = swipeStartRef.current;
				swipeStartRef.current = null;

				// Swipe-down dismiss (touch only): vertical drag > 80px in < 600ms.
				if (startedTouch && start) {
					const dx = event.clientX - start.x;
					const dy = event.clientY - start.y;
					const dt = performance.now() - start.t;
					if (dy > 80 && Math.abs(dx) < 60 && dt < 600 && onDismiss) {
						onDismiss();
						return;
					}
				}

				const container = containerRef.current;
				const now = performance.now();
				const within = now - lastTapRef.current.at < DOUBLE_TAP_WINDOW_MS;
				const side: "left" | "right" =
					container &&
					event.clientX <
						container.getBoundingClientRect().left + container.clientWidth / 2
						? "left"
						: "right";

				if (
					startedTouch &&
					within &&
					lastTapRef.current.side === side &&
					(isRecording || seekRange.end > seekRange.start)
				) {
					// Recordings-only double-tap seek.
					seekBy(side === "left" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS);
					lastTapRef.current = { at: 0, side: null };
					showControls();
					return;
				}

				lastTapRef.current = { at: now, side };
				// Single-tap (any input) toggles the overlay.
				setControlsVisible((v) => !v);
				showControls();
			},
			[
				isRecording,
				onDismiss,
				seekBy,
				seekRange.end,
				seekRange.start,
				showControls
			]
		);

		// ── Render helpers ────────────────────────────────────────────────────
		const showOverlay =
			controlsVisible ||
			focusWithin ||
			!playing ||
			loading ||
			error !== null ||
			secondaryControlsOpen ||
			controlsHelpOpen;
		const showTimelineHours = timelineDuration >= 3_600;

		const surfaceLoadError = loadError && !useNativeHls;
		const initializationError = playbackUnsupported
			? "This browser can't play this stream. Try a current version of Safari, Chrome, Firefox, or Edge."
			: surfaceLoadError
				? "The video player couldn't start. Check your connection, then try again."
				: null;
		const liveDelaySeconds =
			adaptiveLivePosition === null
				? Math.max(0, seekRange.end - currentTime)
				: Math.max(0, adaptiveLivePosition - currentTime);
		const isDelayed =
			!isRecording &&
			(adaptiveLivePosition === null
				? nativeTimeShifted
				: currentTime < adaptiveLivePosition);

		return (
			<div
				ref={containerRef}
				data-testid="player"
				className={cn(
					"relative aspect-video w-full overflow-hidden rounded bg-black text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
					className
				)}
				style={style}
				tabIndex={0}
				role="region"
				aria-label="Video player"
				onKeyDown={onKeyDown}
				onMouseMove={showControls}
				onFocusCapture={() => {
					// Focus can enter after the rail fades, so reveal it before the user
					// must identify or activate the newly focused control.
					focusWithinRef.current = true;
					setFocusWithin(true);
					setControlsVisible(true);
					if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
				}}
				onBlurCapture={(event) => {
					if (event.currentTarget.contains(event.relatedTarget)) return;
					focusWithinRef.current = false;
					setFocusWithin(false);
					showControls();
				}}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerUp}
				onContextMenu={(event) => {
					if (!advancedEnabled) return;
					event.preventDefault();
					const bounds = containerRef.current?.getBoundingClientRect();
					setContextMenu({
						x: event.clientX - (bounds?.left ?? 0),
						y: event.clientY - (bounds?.top ?? 0)
					});
				}}
			>
				{/* The video element intentionally omits a default <track> — the
        captions toggle below surfaces SUBTITLES tracks discovered from
        the HLS master playlist (rrainn/SignalHaven#23). */}
				<video
					ref={videoRef}
					data-testid="player-video"
					className="h-full w-full bg-black"
					playsInline
					crossOrigin="anonymous"
					preload="auto"
					{...{ "x-webkit-airplay": "allow" }}
				/>

				{extraStats && playbackStats ? (
					<dl
						data-testid="player-extra-stats"
						className="pointer-events-none absolute left-2 top-2 z-20 grid max-w-[calc(100%-1rem)] grid-cols-[auto_1fr] gap-x-2 rounded bg-black/80 p-2 font-mono text-[10px] leading-4 sm:left-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)] sm:gap-x-3 sm:p-3 sm:text-[11px] sm:leading-5"
					>
						<dt>Stream bitrate</dt>
						<dd>
							{playbackStats.streamBitrateMbps === null
								? "Unknown"
								: `${playbackStats.streamBitrateMbps.toFixed(2)} Mbps`}
						</dd>
						<dt>Connection estimate</dt>
						<dd>
							{playbackStats.connectionMbps === null
								? "Unknown"
								: `${playbackStats.connectionMbps.toFixed(2)} Mbps`}
						</dd>
						<dt>Resolution</dt>
						<dd>{playbackStats.resolution}</dd>
						<dt>FPS</dt>
						<dd>
							{playbackStats.fps === null
								? "Unknown"
								: playbackStats.fps.toFixed(1)}
						</dd>
						<dt>Buffer ahead</dt>
						<dd>{playbackStats.bufferedSeconds.toFixed(1)} s</dd>
						<dt>Buffer events</dt>
						<dd>{formatBufferEvents(playbackStats.bufferEvents)}</dd>
						<dt>Behind live</dt>
						<dd>
							{playbackStats.latencySeconds === null
								? "N/A"
								: `${playbackStats.latencySeconds.toFixed(1)} s`}
						</dd>
						<dt>Dropped frames</dt>
						<dd>
							{formatDroppedFrames(
								playbackStats.droppedFrames,
								playbackStats.totalFrames
							)}
						</dd>
						<dt>Profile</dt>
						<dd>{playbackStats.profile ?? "Unknown"}</dd>
						<dt>Encoder</dt>
						<dd>{playbackStats.hwaccel ?? "Software/direct"}</dd>
						<dt>Server status</dt>
						<dd>{formatServerState(playbackStats.serverState)}</dd>
						<dt>Pipeline health</dt>
						<dd>{formatPipelineHealth(playbackStats.pipeline)}</dd>
						<dt>Classified cause</dt>
						<dd>{playbackStats.classifiedCause ?? "None detected"}</dd>
						<dt>Adaptive capacity</dt>
						<dd>{playbackStats.capacityStatus ?? "N/A"}</dd>
						<dt>Tuner/source</dt>
						<dd>{formatSourceQuality(playbackStats.sourceQuality)}</dd>
						<dt>Live rewind</dt>
						<dd>
							{playbackStats.timeShift === null
								? "N/A"
								: playbackStats.timeShift.enabled
									? `Up to ${formatTimeWindow(playbackStats.timeShift.windowSeconds)} · ${formatBytes(playbackStats.timeShift.bufferBytes)} on disk`
									: "Off"}
						</dd>
					</dl>
				) : null}

				{contextMenu ? (
					<div
						role="menu"
						data-testid="player-context-menu"
						aria-label="Advanced player controls"
						className="absolute z-40 max-w-[calc(100%-1rem)] rounded-md border border-white/20 bg-black/95 p-1 text-sm shadow-xl"
						style={{ left: contextMenu.x, top: contextMenu.y }}
						onBlur={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget)) {
								setContextMenu(null);
							}
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								setContextMenu(null);
								containerRef.current?.focus();
							}
						}}
					>
						<button
							autoFocus
							type="button"
							role="menuitem"
							className="min-h-11 rounded-md px-3 py-2 text-left hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
							onClick={() => {
								setExtraStats((current) => !current);
								setContextMenu(null);
							}}
						>
							{extraStats ? "Hide Extra Stats" : "Show Extra Stats"}
						</button>
					</div>
				) : null}

				{loading && !error ? (
					<div
						data-testid="player-loading"
						className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 p-4 text-center"
					>
						<div className="max-w-[min(28rem,calc(100%-2rem))]">
							<Spinner
								aria-label={LOADING_STAGE_LABELS[loadingStage]}
								label={LOADING_STAGE_LABELS[loadingStage]}
							/>
							<p
								data-testid="player-loading-stage"
								className="mt-2 text-sm font-medium text-white"
							>
								{LOADING_STAGE_LABELS[loadingStage]}
							</p>
							{mediaTitle ? (
								<p className="mt-1 truncate text-sm text-white/90">
									{mediaTitle}
								</p>
							) : null}
							{mediaSubtitle ? (
								<p className="truncate text-xs text-white/70">
									{mediaSubtitle}
								</p>
							) : null}
						</div>
					</div>
				) : null}

				{error || initializationError ? (
					<div
						data-testid="player-error"
						role="alert"
						className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-sm"
					>
						<p className="max-w-prose font-medium">
							{error ?? initializationError}
						</p>
						{advancedEnabled && errorDetail ? (
							<details className="max-w-prose text-left text-xs text-white/75">
								<summary className="cursor-pointer rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
									Technical details
								</summary>
								<p className="mt-1 break-words px-2">{errorDetail}</p>
							</details>
						) : null}
						{!playbackUnsupported ? (
							<div className="flex flex-wrap items-center justify-center gap-2">
								<Button
									variant="outline"
									className="border-white/30 text-white hover:bg-white/10"
									onClick={() => {
										setError(null);
										setErrorDetail(null);
										if (surfaceLoadError) {
											reload();
										} else {
											const v = videoRef.current;
											if (v) {
												setLoading(true);
												setLoadingStage(
													bufferEventAccumulatorRef.current.playbackStarted
														? "reconnecting"
														: "preparing"
												);
												// Force a re-attach by re-setting the source.
												if (useNativeHls) {
													v.src = effectiveSrc;
												} else if (hlsInstanceRef.current) {
													if (lastFatalHlsErrorWasMediaRef.current) {
														// A playlist reload cannot clear a failed MediaSource.
														if (hlsMediaRecoveryTimerRef.current !== null) {
															window.clearTimeout(
																hlsMediaRecoveryTimerRef.current
															);
															hlsMediaRecoveryTimerRef.current = null;
														}
														// Manual retry starts a fresh bounded recovery cycle.
														hlsMediaRecoveryAttemptsRef.current = 1;
														hlsInstanceRef.current.recoverMediaError();
													} else {
														hlsInstanceRef.current.loadSource(effectiveSrc);
													}
												}
											}
										}
									}}
								>
									<RotateCcw aria-hidden="true" className="h-4 w-4" />
									Try again
								</Button>
								{quality !== "auto" && !isRecording ? (
									<Button
										variant="secondary"
										onClick={() => {
											setError(null);
											setErrorDetail(null);
											changeQuality("auto");
										}}
									>
										Use Auto quality
									</Button>
								) : null}
							</div>
						) : null}
					</div>
				) : null}

				{recoveryMessage ? (
					<p
						role="status"
						className="absolute left-3 right-16 top-3 z-20 rounded-md border border-white/15 bg-black/85 px-3 py-2 text-center text-sm md:right-3"
					>
						{recoveryMessage}
					</p>
				) : null}

				<IconButton
					aria-label="More playback controls"
					aria-expanded={secondaryControlsOpen}
					aria-controls="player-secondary-controls"
					size="lg"
					className={cn(
						"absolute right-2 top-2 z-20 border border-white/15 bg-black/75 text-white hover:bg-black/90 md:hidden",
						showOverlay ? "opacity-100" : "pointer-events-none opacity-0"
					)}
					onClick={() => {
						setControlsHelpOpen(false);
						setSecondaryControlsOpen((current) => !current);
						showControls();
					}}
				>
					<SlidersHorizontal aria-hidden="true" />
				</IconButton>

				<div
					data-testid="player-controls"
					data-visible={showOverlay ? "true" : "false"}
					className={cn(
						"pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 border-t border-white/15 bg-black/85 p-2 transition-opacity duration-200 sm:p-3",
						showOverlay ? "opacity-100" : "opacity-0"
					)}
				>
					<div className="relative">
						{timelineDuration > 0 ? (
							<div
								data-testid="player-commercial-markers"
								aria-hidden="true"
								className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-1.5 -translate-y-1/2 overflow-hidden rounded-full"
							>
								{commercialMarkers.map((marker) => (
									<span
										key={`${marker.startMs}-${marker.endMs}`}
										className="absolute h-full bg-danger/80"
										style={{
											left: `${(marker.startMs / 1_000 / timelineDuration) * 100}%`,
											width: `${((marker.endMs - marker.startMs) / 1_000 / timelineDuration) * 100}%`
										}}
									/>
								))}
							</div>
						) : null}
						<Slider
							data-testid="player-seek"
							aria-label={isRecording ? "Seek" : "Live buffer position"}
							aria-describedby={
								commercialMarkers.length > 0
									? "player-commercial-description"
									: undefined
							}
							min={isRecording ? 0 : seekRange.start}
							max={
								isRecording
									? Math.max(timelineDuration, 1)
									: Math.max(seekRange.end, seekRange.start + 1)
							}
							step={1}
							value={[
								isRecording
									? displayedCurrentTime
									: Math.max(
											seekRange.start,
											Math.min(seekRange.end, currentTime)
										)
							]}
							onValueChange={(values) => {
								const v = videoRef.current;
								if (!v) return;
								const next = values[0] ?? (isRecording ? 0 : seekRange.start);
								if (isRecording) {
									setScrubPosition(next);
									return;
								}
								v.currentTime = next;
								setCurrentTime(next);
								setNativeTimeShifted(next < seekRange.end);
								setRecoveryMessage(null);
							}}
							onValueCommit={(values) => {
								if (!isRecording) return;
								const next = values[0] ?? displayedCurrentTime;
								setScrubPosition(null);
								seekRecordingTo(next);
							}}
							className="pointer-events-auto h-11"
						/>
						{commercialMarkers.length > 0 ? (
							<p id="player-commercial-description" className="sr-only">
								The timeline includes {commercialMarkers.length} marked
								commercial
								{commercialMarkers.length === 1 ? " region." : " regions."}
							</p>
						) : null}
					</div>
					{activeCommercial ? (
						<div
							data-testid="player-skip-commercial-overlay"
							className="pointer-events-auto absolute bottom-full right-2 z-20 mb-2"
						>
							<Button
								data-testid="player-skip-commercial"
								variant="secondary"
								size="md"
								onClick={() => {
									const video = videoRef.current;
									if (!video) return;
									const target = Math.min(
										activeCommercial.endMs / 1_000,
										timelineDuration
									);
									seekRecordingTo(target);
								}}
							>
								Skip Commercial
							</Button>
						</div>
					) : null}

					{controlsHelpOpen ? (
						<div
							role="region"
							aria-label="Player keyboard shortcuts"
							className="pointer-events-auto absolute bottom-0 right-2 z-30 w-72 max-w-[calc(100%-1rem)] rounded-md border border-white/20 bg-black/95 p-3 text-xs text-white shadow-xl md:bottom-[calc(100%+0.5rem)]"
						>
							<div className="flex items-center justify-between gap-3">
								<p className="font-semibold">Keyboard shortcuts</p>
								<button
									type="button"
									className="min-h-11 rounded-md px-2 text-white/80 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
									onClick={() => setControlsHelpOpen(false)}
								>
									Close
								</button>
							</div>
							<p className="mt-1 leading-5 text-white/75">
								Space or K: play and pause · M: mute · F: fullscreen · C:
								captions · Arrow keys: seek and volume · ?: this help
							</p>
						</div>
					) : null}

					<div className="contents md:flex md:items-center md:gap-2">
						<div
							id="player-secondary-controls"
							role="region"
							aria-label="More playback controls"
							className={cn(
								"pointer-events-auto absolute bottom-0 right-2 z-30 w-72 max-w-[calc(100%-1rem)] flex-col gap-3 rounded-md border border-white/20 bg-black/95 p-3 text-white shadow-xl",
								secondaryControlsOpen ? "flex" : "hidden",
								"md:static md:ml-auto md:flex md:w-auto md:max-w-none md:flex-row md:items-center md:gap-2 md:border-0 md:bg-transparent md:p-0 md:shadow-none"
							)}
						>
							<div className="flex items-center gap-2">
								<IconButton
									data-testid="player-mute"
									aria-label={muted ? "Unmute" : "Mute"}
									aria-pressed={muted}
									className="min-h-11 min-w-11 text-white hover:bg-white/10"
									onClick={toggleMute}
								>
									{muted || volume === 0 ? (
										<VolumeX aria-hidden="true" className="h-5 w-5" />
									) : (
										<Volume2 aria-hidden="true" className="h-5 w-5" />
									)}
								</IconButton>
								<Slider
									data-testid="player-volume"
									aria-label="Volume"
									min={0}
									max={1}
									step={0.01}
									value={[muted ? 0 : volume]}
									onValueChange={(values) =>
										setVolumeAndPersist(values[0] ?? 0)
									}
									className="h-11 min-w-0 flex-1 md:w-24 md:flex-none"
								/>
							</div>

							<div className="flex items-center gap-2">
								{tracks.length > 0 ? (
									<IconButton
										data-testid="player-captions"
										aria-label={captionsOn ? "Hide captions" : "Show captions"}
										aria-pressed={captionsOn}
										className="min-h-11 min-w-11 text-white hover:bg-white/10"
										onClick={toggleCaptions}
									>
										{captionsOn ? (
											<Captions aria-hidden="true" className="h-5 w-5" />
										) : (
											<CaptionsOff aria-hidden="true" className="h-5 w-5" />
										)}
									</IconButton>
								) : null}
								{airPlayAvailability !== "unsupported" ? (
									<IconButton
										data-testid="player-airplay"
										aria-label={
											isAirPlaying
												? "AirPlay connected"
												: "Choose AirPlay device"
										}
										aria-pressed={isAirPlaying}
										disabled={
											airPlayAvailability === "not-available" && !isAirPlaying
										}
										className="min-h-11 min-w-11 text-white hover:bg-white/10"
										onClick={showAirPlayPicker}
									>
										<Airplay aria-hidden="true" className="h-5 w-5" />
									</IconButton>
								) : null}
								<IconButton
									data-testid="player-pip"
									aria-label="Picture in picture"
									aria-pressed={isPip}
									disabled={!pipSupported}
									className="min-h-11 min-w-11 text-white hover:bg-white/10"
									onClick={() => void togglePip()}
								>
									<PictureInPicture2 aria-hidden="true" className="h-5 w-5" />
								</IconButton>
								<IconButton
									aria-label="Show keyboard shortcuts"
									aria-expanded={controlsHelpOpen}
									className="min-h-11 min-w-11 text-white hover:bg-white/10"
									onClick={() => {
										setSecondaryControlsOpen(false);
										setControlsHelpOpen((current) => !current);
									}}
								>
									<CircleHelp aria-hidden="true" />
								</IconButton>
							</div>
						</div>

						<div
							role="group"
							aria-label="Primary player controls"
							className="pointer-events-auto grid grid-cols-4 items-stretch gap-2 md:order-first md:flex md:items-center"
						>
							<IconButton
								data-testid="player-play"
								aria-label={playing ? "Pause" : "Play"}
								className="h-11 w-full text-white hover:bg-white/10 md:w-11"
								onClick={togglePlay}
							>
								{playing ? (
									<Pause aria-hidden="true" className="h-5 w-5" />
								) : (
									<Play aria-hidden="true" className="h-5 w-5" />
								)}
							</IconButton>

							{isRecording ? (
								<span
									data-testid="player-time"
									role="status"
									className="flex min-h-11 min-w-0 items-center justify-center text-[10px] tabular-nums text-white/80 sm:text-xs md:px-2"
								>
									{formatPlaybackTime(displayedCurrentTime, showTimelineHours)}{" "}
									/ {formatPlaybackTime(timelineDuration, showTimelineHours)}
								</span>
							) : isDelayed ? (
								<div className="flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md bg-white/10 px-1">
									<span className="text-[10px] leading-none text-white/75">
										Delayed {formatPlaybackTime(liveDelaySeconds, false)}
									</span>
									<button
										type="button"
										className="rounded-md px-2 text-xs font-medium text-white underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
										onClick={goLive}
									>
										Go Live
									</button>
								</div>
							) : (
								<div
									role="status"
									className="flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-live px-2 text-xs font-medium text-live-foreground"
								>
									<Radio aria-hidden="true" className="h-4 w-4" />
									<span>Live</span>
								</div>
							)}

							<Select
								value={quality}
								onValueChange={(value) => changeQuality(value as PlayerQuality)}
							>
								<SelectTrigger
									data-testid="player-quality"
									aria-label="Quality"
									className="h-11 min-w-0 border-white/20 bg-black/30 px-2 text-white md:ml-auto md:w-[10rem]"
								>
									<SelectValue>{QUALITY_LABELS[quality]}</SelectValue>
								</SelectTrigger>
								<SelectContent className="w-[18rem] max-w-[calc(100vw-2rem)]">
									{ALL_QUALITIES.map((option) => (
										<SelectItem
											key={option}
											value={option}
											data-testid={"quality-" + option}
											className="py-2"
										>
											<span className="flex flex-col">
												<span>{QUALITY_LABELS[option]}</span>
												{QUALITY_DESCRIPTIONS[option] ? (
													<span className="text-xs text-muted">
														{QUALITY_DESCRIPTIONS[option]}
													</span>
												) : null}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>

							<IconButton
								data-testid="player-fullscreen"
								aria-label={
									isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
								}
								aria-pressed={isFullscreen}
								disabled={!fullscreenSupported}
								className="h-11 w-full text-white hover:bg-white/10 md:w-11"
								onClick={() => void toggleFullscreen()}
							>
								{isFullscreen ? (
									<Minimize aria-hidden="true" className="h-5 w-5" />
								) : (
									<Maximize aria-hidden="true" className="h-5 w-5" />
								)}
							</IconButton>
						</div>
					</div>
				</div>
			</div>
		);
	}
);

/** Preserve useful HLS classification without exposing URLs or server payloads. */
function formatPlaybackDiagnostic(data: {
	type?: string;
	details?: string;
	reason?: string;
	response?: { code?: number; text?: string };
}): string {
	const parts = [
		sanitizeDiagnosticValue(data.type),
		sanitizeDiagnosticValue(data.details),
		sanitizeDiagnosticValue(data.reason)
	];
	if (data.response?.code) parts.push(`HTTP ${data.response.code}`);
	return parts.filter(Boolean).join(" · ") || "Fatal HLS playback error";
}

/** Keep server diagnostics useful while withholding sensitive request details. */
function formatExternalDiagnostic(message: string): string {
	return (
		sanitizeDiagnosticValue(message) ?? "Server reported a playback failure"
	);
}

/** Allow bounded diagnostic labels but reject URLs, tokens, and arbitrary payloads. */
function sanitizeDiagnosticValue(value: string | undefined): string | null {
	if (!value) return null;
	const normalized = value.trim();
	return /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}$/.test(normalized)
		? normalized
		: "Additional details withheld";
}

/** Decode the browser's numeric MediaError for advanced troubleshooting. */
function formatMediaError(error: MediaError | null): string {
	if (!error) return "Playback error (the browser provided no MediaError)";
	const labels: Record<number, string> = {
		1: "Playback aborted",
		2: "Network error",
		3: "Media decode error",
		4: "Unsupported media source"
	};
	const message = sanitizeDiagnosticValue(error.message);
	return `${labels[error.code] ?? "Playback error"} (MediaError ${error.code}${message ? `: ${message}` : ""})`;
}

/** Find the end of the buffered range that can actually continue playback. */
function getCurrentBufferedEnd(video: HTMLVideoElement): number {
	for (let index = 0; index < video.buffered.length; index += 1) {
		const start = video.buffered.start(index);
		const end = video.buffered.end(index);
		if (start <= video.currentTime && end >= video.currentTime) return end;
	}
	return video.currentTime;
}

/** Pair dropped frames with their denominator so playback health has context. */
function formatDroppedFrames(
	droppedFrames: number | null,
	totalFrames: number | null
): string {
	if (droppedFrames === null || totalFrames === null) return "Unknown";
	if (totalFrames <= 0) return `${droppedFrames} / ${totalFrames}`;
	return `${droppedFrames} / ${totalFrames} (${((droppedFrames / totalFrames) * 100).toFixed(1)}%)`;
}

/** Format buffer interruption telemetry compactly for the operator overlay. */
function formatBufferEvents(summary: BufferEventSummary): string {
	if (
		summary.averageDurationSeconds === null ||
		summary.minimumDurationSeconds === null ||
		summary.maximumDurationSeconds === null
	) {
		return "0 · Avg N/A · Min N/A · Max N/A";
	}
	return `${summary.count} · Avg ${summary.averageDurationSeconds.toFixed(1)} s · Min ${summary.minimumDurationSeconds.toFixed(1)} s · Max ${summary.maximumDurationSeconds.toFixed(1)} s`;
}

/** Translate internal stream lifecycle states into operator-friendly language. */
function formatServerState(state: string | null): string {
	if (state === null) return "N/A";
	const labels: Record<string, string> = {
		starting: "Starting",
		ready: "Streaming",
		lingering: "Idle (kept warm)",
		stopped: "Stopped"
	};
	return labels[state] ?? state;
}

/** Pair pipeline health with the rate fields needed to locate starvation. */
function formatPipelineHealth(pipeline: PlaybackStats["pipeline"]): string {
	if (!pipeline) return "N/A";
	const labels = {
		starting: "Starting",
		healthy: "Healthy",
		slow: "Slow",
		stalled: "Stalled"
	} as const;
	const details = [
		pipeline.speed === null ? null : `${pipeline.speed.toFixed(2)}×`,
		pipeline.fps === null ? null : `${pipeline.fps.toFixed(1)} FPS`,
		pipeline.mode === "remux" ? "Direct/remux" : "Transcoding"
	].filter(Boolean);
	return [labels[pipeline.health], ...details].join(" · ");
}

/** Pair a client stall with bounded server evidence instead of guessing from bandwidth. */
function classifyStallCause(status: StreamStatus): PlaybackStallCause {
	const category = status.lastError?.category ?? "";
	if (category === "encoder_capacity" || status.pipeline.health === "slow") {
		return "encoder";
	}
	if (category === "input_unreachable") return "source";
	if (category === "invalid_data") return "packaging";
	if (category.includes("decoder")) return "decoder";
	if (status.pipeline.health === "stalled") return "source";
	return "network";
}

/** Summarize provider-side RF and transport measurements when available. */
function formatSourceQuality(quality: PlaybackStats["sourceQuality"]): string {
	if (!quality) return "Unavailable";
	const details = [
		quality.signalStrengthPercent === undefined
			? null
			: `Strength ${quality.signalStrengthPercent.toFixed(0)}%`,
		quality.signalQualityPercent === undefined
			? null
			: `Quality ${quality.signalQualityPercent.toFixed(0)}%`,
		quality.symbolQualityPercent === undefined
			? null
			: `Symbol ${quality.symbolQualityPercent.toFixed(0)}%`,
		quality.networkRateMbps === undefined
			? null
			: `${quality.networkRateMbps.toFixed(1)} Mbps from tuner`
	].filter(Boolean);
	return details.length > 0 ? details.join(" · ") : "Active";
}

/** Describe the configured live-rewind limit as time instead of storage alone. */
function formatTimeWindow(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0
		? `${hours} hr ${remainingMinutes} min`
		: `${hours} hr`;
}

/** Keep elapsed and total recording times aligned as the playhead advances. */
function formatPlaybackTime(seconds: number, showHours: boolean): string {
	const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
	const wholeSeconds = Math.floor(safeSeconds);
	const minutes = Math.floor(wholeSeconds / 60);
	const remainingSeconds = wholeSeconds % 60;
	const minuteSeconds = `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
	if (!showHours) return minuteSeconds;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

/** Compact byte units keep the overlay readable at video-player scale. */
function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
