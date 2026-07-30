"use client";

import {
	settingsDefaults,
	type ChannelListItem,
	type PlayerSettings,
	type Recording,
	type RecordingPatch,
	type RecordingDetail
} from "@signalhaven/shared";
import { useRouter } from "next/navigation";
import {
	ArrowLeft,
	Eye,
	EyeOff,
	Film,
	Shield,
	ShieldCheck
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState
} from "react";

import {
	ApiError,
	buildRecordingArtworkUrl,
	buildRecordingPlaybackUrl,
	getRecording,
	listChannels,
	patchRecording,
	prepareRecordingPlayback,
	retryCommercialAnalysis,
	updateSettings
} from "../../lib/api-client";
import {
	use24HourClock,
	usePreferencesOptional
} from "../_preferences/PreferencesProvider";
import { formatDateTimePreference } from "../_preferences/formatting";
import { Button } from "../_ui/Button";
import { Badge } from "../_ui/Badge";
import { EmptyState } from "../_ui/EmptyState";
import { Spinner } from "../_ui/Spinner";
import {
	Player,
	type PlayerHandle,
	type PlayerSavePayload
} from "../_player/Player";

import { safeRecordingsReturnPath } from "./query-state";
import { OrderedRecordingPatchQueue } from "./recording-patch-queue";
import { RecordingArtwork } from "./RecordingArtwork";
import { RecordingStatusBadge } from "./RecordingStatusBadge";
import {
	formatEpisodeLabel,
	getRecordingFailurePresentation,
	getRecordingViewState
} from "./presentation";
import { formatBytes, formatDuration } from "./state";

/** Minimum playback ratio that flips a recording to "watched". */
export const WATCHED_RATIO_THRESHOLD = 0.9;
/**
 * Below this ratio, completed playback is treated as "credits/end-of-
 * episode" rather than a real position to resume from. Saving the
 * resume position only really makes sense for partial views.
 */
export const RESUME_CLEAR_RATIO = 0.95;
/** Minimum delta between persisted resume positions, in seconds. */
export const RESUME_PERSIST_INTERVAL_SEC = 10;

export interface RecordingPlayerPageProps {
	/** Recording id from the URL segment. */
	recordingId: string;
	/** Safe recordings path restored by the Back action. */
	returnTo?: string | undefined;
	/** Test seam: pre-populated detail (skips network). */
	initialRecording?: RecordingDetail | undefined;
	/** Test seam: pre-populated channel presentation. */
	initialChannel?: ChannelListItem | null | undefined;
	/** Test seam: pre-populated player settings (skips network). */
	initialPlayerSettings?: PlayerSettings | undefined;
	/** Test seam: override the recording fetch. */
	loadRecording?: (() => Promise<RecordingDetail>) | undefined;
	/** Test seam: override the channel list fetch. */
	loadChannels?: (() => Promise<ChannelListItem[]>) | undefined;
	/** Test seam for the manifest preflight that warms the playback session. */
	preparePlayback?: ((startSeconds: number) => Promise<void>) | undefined;
	/** Test seam: override the resume-position / watched PATCH. */
	patchProgress?: ((patch: RecordingPatch) => Promise<void>) | undefined;
	/** Test seam: override user-driven protected and watched-state patches. */
	updateRecording?: ((patch: RecordingPatch) => Promise<Recording>) | undefined;
	/**
	 * Test seam: override player settings persistence (defaults to PATCH
	 * /api/v1/settings with the merged player payload). Mirrors the
	 * shape used by {@link PlayerPage}.
	 */
	persistPlayerSettings?: ((next: PlayerSettings) => Promise<void>) | undefined;
	/** Test seam for manually retrying detector work. */
	retryAnalysis?:
		| (() => Promise<RecordingDetail["commercialAnalysis"]>)
		| undefined;
}

/**
 * Recording playback screen (rrainn/SignalHaven#U8-recordings).
 *
 * Wraps the U6 {@link Player} with `isRecording=true` and an HLS source
 * pointed at the recording's file endpoint. Handles the U8-specific
 * lifecycle:
 *
 *   * On mount: loads `GET /api/v1/recordings/:id` to seed the title /
 *     metadata + read the persisted `resumePositionSeconds`.
 *   * On metadata-loaded: seeks the underlying `<video>` to the resume
 *     position when one is present.
 *   * On `timeupdate` (debounced, every {@link
 *     RESUME_PERSIST_INTERVAL_SEC}s): PATCHes the resume position back
 *     to the API.
 *   * Once the user crosses the {@link WATCHED_RATIO_THRESHOLD} mark
 *     (or the video reaches `ended`), the recording is flipped to
 *     watched. When the threshold is comfortably past
 *     ({@link RESUME_CLEAR_RATIO}) the resume position is cleared so
 *     re-entering the page starts at zero.
 */
export function RecordingPlayerPage(props: RecordingPlayerPageProps) {
	const router = useRouter();
	const returnTo = safeRecordingsReturnPath(props.returnTo);
	const preferences = usePreferencesOptional();
	const preferencesRef = useRef(preferences);
	preferencesRef.current = preferences;
	const use24Hour = use24HourClock();
	const [recording, setRecording] = useState<RecordingDetail | null>(
		props.initialRecording ?? null
	);
	const [channel, setChannel] = useState<ChannelListItem | null>(
		props.initialChannel ?? null
	);
	const [settings, setSettings] = useState<PlayerSettings | null>(
		props.initialPlayerSettings ??
			(preferences
				? preferences.status === "loading"
					? null
					: preferences.settings.player
				: settingsDefaults.player)
	);
	const [status, setStatus] = useState<"loading" | "ready" | "error">(
		props.initialRecording && props.initialPlayerSettings ? "ready" : "loading"
	);
	const [error, setError] = useState<Error | null>(null);
	const [detailActionPending, setDetailActionPending] = useState(false);
	const [detailActionError, setDetailActionError] = useState<Error | null>(
		null
	);
	const [progressError, setProgressError] = useState<Error | null>(null);
	const [playbackStartSeconds, setPlaybackStartSeconds] = useState(
		props.initialRecording?.resumePositionSeconds ?? 0
	);
	const [analysisRetryPending, setAnalysisRetryPending] = useState(false);
	const [analysisRetryError, setAnalysisRetryError] = useState<Error | null>(
		null
	);
	const failedProgressPatchRef = useRef<{
		patch: RecordingPatch;
		keepalive: boolean;
	} | null>(null);

	const playerHandleRef = useRef<PlayerHandle | null>(null);
	const lastPersistedSecRef = useRef<number>(
		props.initialRecording?.resumePositionSeconds ?? 0
	);
	const watchedRef = useRef<boolean>(
		props.initialRecording?.watchedAt !== null &&
			props.initialRecording?.watchedAt !== undefined
	);
	const resumeClearedRef = useRef<boolean>(
		props.initialRecording?.resumePositionSeconds == null
	);
	const seededRef = useRef<boolean>(false);

	useEffect(() => {
		if (!props.initialPlayerSettings && preferences) {
			setSettings(preferences.settings.player);
		}
	}, [preferences, props.initialPlayerSettings]);

	// Initial fetch of the recording detail + player settings.
	useEffect(() => {
		let cancelled = false;
		if (preferences?.status === "loading" && !props.initialPlayerSettings) {
			return;
		}
		if (props.initialRecording && props.initialPlayerSettings) {
			watchedRef.current = props.initialRecording.watchedAt !== null;
			lastPersistedSecRef.current =
				props.initialRecording.resumePositionSeconds ?? 0;
			resumeClearedRef.current =
				props.initialRecording.resumePositionSeconds === null;
			if (props.initialChannel !== undefined) {
				setChannel(props.initialChannel);
			} else {
				const channelsLoader =
					props.loadChannels ?? (async () => (await listChannels()).items);
				void channelsLoader()
					.then((channels) => {
						if (cancelled) return;
						setChannel(
							channels.find(
								(candidate) =>
									candidate.id === props.initialRecording?.channelId
							) ?? null
						);
					})
					.catch(() => {
						if (!cancelled) setChannel(null);
					});
			}
			setStatus("ready");
			return () => {
				cancelled = true;
			};
		}
		setStatus("loading");
		const recLoader =
			props.loadRecording ?? (() => getRecording(props.recordingId));
		const settingsLoader = async (): Promise<PlayerSettings> => {
			if (props.initialPlayerSettings) return props.initialPlayerSettings;
			if (preferencesRef.current) {
				return preferencesRef.current.settings.player;
			}
			return settingsDefaults.player;
		};
		const channelsLoader = async (): Promise<ChannelListItem[]> => {
			if (props.initialChannel !== undefined) {
				return props.initialChannel ? [props.initialChannel] : [];
			}
			const load =
				props.loadChannels ?? (async () => (await listChannels()).items);
			return load().catch(() => []);
		};
		Promise.all([recLoader(), settingsLoader(), channelsLoader()])
			.then(async ([rec, s, channels]) => {
				if (cancelled) return;
				const playbackStart = rec.resumePositionSeconds ?? 0;
				if (rec.status === "completed") {
					const prepare =
						props.preparePlayback ??
						((startSeconds: number) =>
							prepareRecordingPlayback(props.recordingId, startSeconds));
					await prepare(playbackStart);
				}
				if (cancelled) return;
				setPlaybackStartSeconds(playbackStart);
				setRecording(rec);
				setSettings(s);
				setChannel(
					channels.find((candidate) => candidate.id === rec.channelId) ?? null
				);
				watchedRef.current = rec.watchedAt !== null;
				lastPersistedSecRef.current = rec.resumePositionSeconds ?? 0;
				resumeClearedRef.current = rec.resumePositionSeconds === null;
				setStatus("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err : new Error("Failed to load"));
				setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [
		props.recordingId,
		props.loadRecording,
		props.initialRecording,
		props.initialChannel,
		props.initialPlayerSettings,
		props.loadChannels,
		props.preparePlayback,
		preferences?.status
	]);

	// Route reuse should never carry a prior recording's seeded seek state.
	useEffect(() => {
		seededRef.current = false;
	}, [props.recordingId]);

	const sendProgressPatch = useCallback(
		async (
			patch: RecordingPatch,
			options?: { keepalive?: boolean }
		): Promise<void> => {
			if (props.patchProgress) {
				await props.patchProgress(patch);
				return;
			}
			await patchRecording(
				props.recordingId,
				patch,
				options?.keepalive ? { keepalive: true } : undefined
			);
		},
		[props.patchProgress, props.recordingId]
	);
	const progressQueue = useMemo(
		() => new OrderedRecordingPatchQueue(sendProgressPatch),
		[sendProgressPatch]
	);
	const persistProgress = useCallback(
		async (patch: RecordingPatch, keepalive = false): Promise<void> => {
			try {
				await progressQueue.enqueue(patch, { keepalive });
				failedProgressPatchRef.current = null;
				setProgressError(null);
				setRecording((current) =>
					current ? applyOptimisticRecordingPatch(current, patch) : current
				);
			} catch (failure) {
				const nextError =
					failure instanceof Error
						? failure
						: new Error("Playback progress could not be saved");
				failedProgressPatchRef.current = { patch, keepalive };
				setProgressError(nextError);
				throw nextError;
			}
		},
		[progressQueue]
	);

	const persistPlayerSettings = useCallback(
		async (next: PlayerSettings) => {
			if (props.persistPlayerSettings) {
				await props.persistPlayerSettings(next);
				return;
			}
			if (preferencesRef.current) {
				await preferencesRef.current.saveSettings({ player: next });
				return;
			}
			await updateSettings({ player: next });
		},
		[props.persistPlayerSettings]
	);

	// Bind media listeners before paint so metadata emitted by an immediately
	// visible player cannot race resume restoration.
	useLayoutEffect(() => {
		if (status !== "ready") return;
		const handle = playerHandleRef.current;
		const video = handle?.video ?? null;
		if (!video || !recording) return;

		// Prefer persisted duration because a progressive HLS playlist initially
		// reports only the segments FFmpeg has generated so far.
		const getPlaybackDuration = () => {
			const persistedDuration = recording.durationSeconds ?? 0;
			if (Number.isFinite(persistedDuration) && persistedDuration > 0) {
				return persistedDuration;
			}
			return Number.isFinite(video.duration) ? video.duration : 0;
		};

		// Seed resume once either persisted or media duration is known so we don't
		// accidentally clamp the seek to 0.
		const seedResume = () => {
			if (seededRef.current) return;
			const target = Math.max(
				0,
				(recording.resumePositionSeconds ?? 0) - playbackStartSeconds
			);
			if (target <= 0) {
				seededRef.current = true;
				return;
			}
			const duration = getPlaybackDuration();
			if (duration <= 0) {
				// Duration not yet known — defer until the next loadedmetadata
				// / durationchange event so we don't seek the source to 0.
				return;
			}
			const safeTarget = Math.min(target, Math.max(0, duration - 1));
			try {
				video.currentTime = safeTarget;
			} catch {
				return;
			}
			seededRef.current = true;
		};

		const onTime = () => {
			const dur = getPlaybackDuration();
			const cur = playbackStartSeconds + video.currentTime;
			if (dur <= 0) return;

			// Mark as watched once past the threshold.
			const ratio = cur / dur;
			const shouldMarkWatched =
				ratio >= WATCHED_RATIO_THRESHOLD && !watchedRef.current;
			const shouldClearResume =
				ratio >= RESUME_CLEAR_RATIO && !resumeClearedRef.current;
			if (shouldMarkWatched || shouldClearResume) {
				watchedRef.current = true;
				const patch: { watched: true; resumePositionSeconds?: null } = {
					watched: true
				};
				if (shouldClearResume) {
					patch.resumePositionSeconds = null;
					resumeClearedRef.current = true;
					lastPersistedSecRef.current = 0;
				}
				void persistProgress(patch).catch(() => undefined);
			}

			// Persist resume position on a coarse interval to keep the
			// network chatter manageable.
			const last = lastPersistedSecRef.current;
			if (
				ratio < RESUME_CLEAR_RATIO &&
				Math.abs(cur - last) >= RESUME_PERSIST_INTERVAL_SEC
			) {
				lastPersistedSecRef.current = cur;
				resumeClearedRef.current = false;
				void persistProgress({
					resumePositionSeconds: Math.floor(cur)
				}).catch(() => undefined);
			}
		};

		const onEnded = () => {
			watchedRef.current = true;
			resumeClearedRef.current = true;
			lastPersistedSecRef.current = 0;
			void persistProgress({
				watched: true,
				resumePositionSeconds: null
			}).catch(() => undefined);
		};

		video.addEventListener("loadedmetadata", seedResume);
		video.addEventListener("durationchange", seedResume);
		video.addEventListener("timeupdate", onTime);
		video.addEventListener("ended", onEnded);
		// Persisted recording duration lets the browser retain this as its pending
		// playback position even before progressive HLS metadata arrives.
		seedResume();

		return () => {
			video.removeEventListener("loadedmetadata", seedResume);
			video.removeEventListener("durationchange", seedResume);
			video.removeEventListener("timeupdate", onTime);
			video.removeEventListener("ended", onEnded);
		};
	}, [status, recording, persistProgress, playbackStartSeconds]);

	// Persist the current position one last time on unmount (so a
	// navigation away still saves progress without waiting for the
	// 10-second debounce window).
	useEffect(() => {
		return () => {
			const video = playerHandleRef.current?.video;
			if (!video) return;
			const persistedDuration = recording?.durationSeconds ?? 0;
			const dur =
				Number.isFinite(persistedDuration) && persistedDuration > 0
					? persistedDuration
					: Number.isFinite(video.duration)
						? video.duration
						: 0;
			const cur = playerHandleRef.current?.playbackPositionSeconds ?? 0;
			if (dur <= 0 || cur <= 0) return;
			const ratio = cur / dur;
			if (ratio >= RESUME_CLEAR_RATIO) {
				void persistProgress({ resumePositionSeconds: null }, true).catch(
					() => undefined
				);
				return;
			}
			if (Math.abs(cur - lastPersistedSecRef.current) >= 1) {
				void persistProgress(
					{ resumePositionSeconds: Math.floor(cur) },
					true
				).catch(() => undefined);
			}
		};
	}, [persistProgress, recording?.durationSeconds]);

	// Wire the player-settings persistence callback. We only forward the
	// volume / muted / captions bits; recording playback doesn't pin a
	// per-channel quality (there's no channel context here).
	const onPlayerPersist = useCallback(
		async (patch: PlayerSavePayload) => {
			if (!settings) return;
			const next: PlayerSettings = {
				volume: patch.volume ?? settings.volume,
				muted: patch.muted ?? settings.muted,
				captionsEnabled: patch.captionsEnabled ?? settings.captionsEnabled,
				qualityByChannel: { ...settings.qualityByChannel }
			};
			setSettings(next);
			try {
				await persistPlayerSettings(next);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("Failed to persist player settings", err);
				setSettings(settings);
			}
		},
		[persistPlayerSettings, settings]
	);

	const updateDetailState = useCallback(
		async (
			patch: RecordingPatch,
			optimisticPatch: RecordingPatch
		): Promise<void> => {
			if (!recording || detailActionPending) return;
			const snapshot = recording;
			setDetailActionPending(true);
			setDetailActionError(null);
			setRecording(applyOptimisticRecordingPatch(recording, optimisticPatch));
			try {
				const updated = await progressQueue.enqueueWith(async () => {
					return props.updateRecording
						? await props.updateRecording(patch)
						: await patchRecording(recording.id, patch);
				}, patch);
				setRecording((current) =>
					current ? { ...current, ...updated } : current
				);
				watchedRef.current = updated.watchedAt !== null;
			} catch (failure) {
				setRecording(snapshot);
				setDetailActionError(
					failure instanceof Error
						? failure
						: new Error("The recording update failed")
				);
			} finally {
				setDetailActionPending(false);
			}
		},
		[detailActionPending, progressQueue, props.updateRecording, recording]
	);

	const retryProgress = useCallback(() => {
		const failed = failedProgressPatchRef.current;
		if (!failed) return;
		void persistProgress(failed.patch, failed.keepalive).catch(() => undefined);
	}, [persistProgress]);

	const retryAnalysis = useCallback(async () => {
		setAnalysisRetryPending(true);
		setAnalysisRetryError(null);
		try {
			const analysis = props.retryAnalysis
				? await props.retryAnalysis()
				: await retryCommercialAnalysis(props.recordingId);
			setRecording((current) =>
				current ? { ...current, commercialAnalysis: analysis } : current
			);
		} catch (failure) {
			setAnalysisRetryError(
				failure instanceof Error
					? failure
					: new Error("Commercial analysis could not be retried")
			);
		} finally {
			setAnalysisRetryPending(false);
		}
	}, [props.recordingId, props.retryAnalysis]);

	if (status === "loading") {
		return (
			<div
				data-testid="recording-player-loading"
				className="flex items-center justify-center p-12"
			>
				<Spinner aria-label="Loading recording" />
			</div>
		);
	}

	if (status === "error" || !recording || !settings) {
		const description = describeRecordingError(error);
		return (
			<EmptyState
				data-testid="recording-player-error"
				icon={<Film />}
				title="Couldn't load recording"
				description={description}
				action={
					<Button onClick={() => router.push(returnTo)}>Back to library</Button>
				}
			/>
		);
	}

	const playbackUrl = buildRecordingPlaybackUrl(
		recording.id,
		playbackStartSeconds
	);
	const episodeLabel = recording.metadata
		? formatEpisodeLabel(recording.metadata)
		: null;
	const failure =
		recording.status === "failed"
			? getRecordingFailurePresentation(recording.errorMessage)
			: null;
	const viewState = getRecordingViewState(recording);
	const recordedAt = recording.actualStart ?? recording.scheduledStart;

	return (
		<section
			data-testid="recording-player-page"
			className="mx-auto flex max-w-5xl flex-col gap-4"
		>
			<div>
				<Button variant="ghost" size="sm" onClick={() => router.push(returnTo)}>
					<ArrowLeft aria-hidden="true" className="h-4 w-4" />
					Back to library
				</Button>
			</div>

			{recording.status === "completed" ? (
				<Player
					ref={(handle) => {
						playerHandleRef.current = handle;
					}}
					channelId={recording.channelId}
					isRecording
					recordingDurationSeconds={recording.durationSeconds}
					recordingStartSeconds={playbackStartSeconds}
					onRecordingSeek={(positionSeconds) => {
						// Changing the URL causes the backend to replace the old lazy
						// FFmpeg window and begin producing segments at this timestamp.
						setPlaybackStartSeconds(Math.floor(positionSeconds));
					}}
					commercialMarkers={recording.commercialAnalysis.markers}
					src={playbackUrl}
					onPersist={onPlayerPersist}
					initial={{
						volume: settings.volume,
						muted: settings.muted,
						captionsEnabled: settings.captionsEnabled,
						quality: "auto"
					}}
				/>
			) : (
				<div
					data-testid="recording-playback-unavailable"
					className="rounded-lg border border-border bg-surface-muted p-4"
				>
					<p className="font-medium text-primary">
						Playback is unavailable while this recording is {recording.status}.
					</p>
					<p className="mt-1 text-sm text-secondary">
						The library details and management controls remain available below.
					</p>
				</div>
			)}

			{progressError ? (
				<div
					role="alert"
					data-testid="recording-progress-error"
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 p-3"
				>
					<p className="text-sm text-primary">
						Playback progress could not be saved. SignalHaven will retry as
						playback continues.
					</p>
					<Button variant="outline" size="sm" onClick={retryProgress}>
						Retry now
					</Button>
				</div>
			) : null}

			<section
				data-testid="commercial-analysis-state"
				className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-muted p-3"
			>
				<div>
					<p className="font-medium text-primary">Commercial analysis</p>
					<p className="text-sm text-secondary">
						{describeCommercialAnalysis(recording.commercialAnalysis)}
					</p>
					{analysisRetryError ? (
						<p role="alert" className="mt-1 text-sm text-danger">
							{analysisRetryError.message}
						</p>
					) : null}
				</div>
				{recording.status === "completed" &&
				recording.commercialAnalysis.status === "failed" ? (
					<Button
						variant="outline"
						size="sm"
						disabled={analysisRetryPending}
						onClick={() => void retryAnalysis()}
					>
						{analysisRetryPending ? "Retrying…" : "Retry analysis"}
					</Button>
				) : null}
			</section>

			<section className="grid gap-5 md:grid-cols-[minmax(0,20rem)_1fr]">
				<RecordingArtwork
					src={
						recording.metadata?.artworkUrl
							? buildRecordingArtworkUrl(recording.id)
							: null
					}
					title={recording.title}
					className="aspect-video w-full rounded-lg md:aspect-[2/3]"
					priority
				/>

				<div className="flex min-w-0 flex-col gap-4">
					<header className="flex flex-col gap-2">
						<div className="flex flex-wrap items-center gap-2">
							<RecordingStatusBadge status={recording.status} />
							{recording.manuallyProtected ? (
								<Badge variant="outline">
									<ShieldCheck aria-hidden="true" className="mr-1 h-3 w-3" />
									Protected
								</Badge>
							) : null}
							<Badge
								variant={
									viewState.kind === "in-progress" ? "accent" : "outline"
								}
							>
								{viewState.label}
							</Badge>
						</div>
						<div>
							<h1
								data-testid="recording-title"
								className="text-2xl font-semibold text-primary"
							>
								{recording.title || "Untitled recording"}
							</h1>
							{episodeLabel ? (
								<p
									data-testid="recording-episode"
									className="text-sm text-secondary"
								>
									{episodeLabel}
								</p>
							) : null}
						</div>
						<div
							className="flex flex-wrap gap-2"
							aria-busy={detailActionPending}
						>
							<Button
								variant="outline"
								size="sm"
								disabled={detailActionPending}
								onClick={() =>
									void updateDetailState(
										{
											manuallyProtected: !recording.manuallyProtected
										},
										{
											manuallyProtected: !recording.manuallyProtected
										}
									)
								}
							>
								{recording.manuallyProtected ? (
									<ShieldCheck aria-hidden="true" className="h-4 w-4" />
								) : (
									<Shield aria-hidden="true" className="h-4 w-4" />
								)}
								{recording.manuallyProtected ? "Unprotect" : "Protect"}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={detailActionPending}
								onClick={() =>
									void updateDetailState(
										{ watched: recording.watchedAt === null },
										{ watched: recording.watchedAt === null }
									)
								}
							>
								{recording.watchedAt ? (
									<EyeOff aria-hidden="true" className="h-4 w-4" />
								) : (
									<Eye aria-hidden="true" className="h-4 w-4" />
								)}
								{recording.watchedAt ? "Mark unwatched" : "Mark watched"}
							</Button>
						</div>
						{detailActionError ? (
							<p role="alert" className="text-sm text-danger">
								{detailActionError.message}
							</p>
						) : null}
					</header>

					{failure ? (
						<div
							data-testid="recording-failure-detail"
							className="rounded-lg border border-danger/40 bg-surface-muted p-3"
						>
							<p className="font-medium text-danger">{failure.summary}</p>
							<p className="mt-1 text-sm text-primary">{failure.detail}</p>
						</div>
					) : null}

					{recording.startReason === "late_start" ? (
						<div
							data-testid="recording-late-start"
							className="rounded-lg border border-border bg-surface-muted p-3"
						>
							<p className="font-medium text-primary">Partial recording</p>
							<p className="text-sm text-secondary">
								Capture started after the scheduled beginning.
							</p>
						</div>
					) : null}

					<dl
						data-testid="recording-metadata"
						className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"
					>
						<RecordingMetadataEntry
							label="Channel"
							value={
								channel
									? `${channel.number ? `${channel.number} ` : ""}${channel.name}`
									: "Unknown channel"
							}
						/>
						<RecordingMetadataEntry
							label="Recorded"
							value={formatDateTimePreference(recordedAt, use24Hour)}
						/>
						<RecordingMetadataEntry
							label="Duration"
							value={formatDisplayValue(
								formatDuration(recording.durationSeconds)
							)}
						/>
						<RecordingMetadataEntry
							label="File size"
							value={formatDisplayValue(formatBytes(recording.fileSize))}
						/>
						<RecordingMetadataEntry
							label="Episode"
							value={episodeLabel ?? "Not available"}
						/>
						<RecordingMetadataEntry
							label="Categories"
							value={
								recording.metadata?.categories.length
									? recording.metadata.categories.join(", ")
									: "Uncategorized"
							}
						/>
					</dl>

					<div>
						<h2 className="text-sm font-semibold text-primary">Description</h2>
						<p
							data-testid="recording-description"
							className="mt-1 text-sm text-secondary"
						>
							{recording.metadata?.description || "No description available."}
						</p>
					</div>
				</div>
			</section>
		</section>
	);
}

/** Render one accessible metadata term and its graceful fallback value. */
function RecordingMetadataEntry(props: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-border bg-surface-muted p-3">
			<dt className="text-xs font-medium uppercase tracking-wide text-muted">
				{props.label}
			</dt>
			<dd className="mt-1 text-primary">{props.value}</dd>
		</div>
	);
}

/** Replace terse formatting sentinels with readable detail-page copy. */
function formatDisplayValue(value: string): string {
	return value === "—" ? "Not available" : value;
}

/** Convert detector lifecycle state into concise, actionable detail copy. */
function describeCommercialAnalysis(
	analysis: RecordingDetail["commercialAnalysis"]
): string {
	switch (analysis.status) {
		case "not_requested":
			return "Not requested. Enable and configure Comskip in DVR settings.";
		case "queued":
			return "Queued behind other background DVR work.";
		case "running":
			return "Analyzing this recording now.";
		case "completed":
			return analysis.markers.length === 0
				? "Complete — no commercial regions were found."
				: `Complete — ${analysis.markers.length} commercial region${analysis.markers.length === 1 ? "" : "s"} found.`;
		case "failed":
			return (
				analysis.diagnosticMessage ?? "Analysis failed. You can retry safely."
			);
	}
}

/** Apply the user-facing effect of one partial recording patch locally. */
function applyOptimisticRecordingPatch(
	recording: RecordingDetail,
	patch: RecordingPatch
): RecordingDetail {
	return {
		...recording,
		...(patch.manuallyProtected !== undefined
			? { manuallyProtected: patch.manuallyProtected }
			: {}),
		...(patch.watched !== undefined
			? {
					watchedAt: patch.watched ? new Date().toISOString() : null
				}
			: {}),
		...(patch.watchedAt !== undefined ? { watchedAt: patch.watchedAt } : {}),
		...(patch.resumePositionSeconds !== undefined
			? { resumePositionSeconds: patch.resumePositionSeconds }
			: {})
	};
}

/** Turn API playback failures into recovery-oriented recording UI copy. */
function describeRecordingError(error: Error | null): string {
	if (error instanceof ApiError) {
		if (error.status === 404) {
			return "This recording was deleted or no longer exists.";
		}
		if (error.message.length > 0) return error.message;
	}
	return error?.message ?? "Please try again or return to the library.";
}
