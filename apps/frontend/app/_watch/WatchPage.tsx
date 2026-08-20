"use client";

import type {
	ChannelListItem,
	ChannelsSettings,
	EpgGrid,
	EpgGridProgram,
	EventMessage,
	PlayerSettings,
	Recording,
	SeriesRule
} from "@signalhaven/shared";
import { RECORDING_EVENT } from "@signalhaven/shared";
import { RadioTower } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getEpgGrid, listChannels } from "../../lib/api-client";
import { parseRecordingEvent } from "../../lib/recording-events";
import { useWebSocketEvents } from "../../lib/ws-client";
import { SmartLink } from "../_layout/SmartLink";
import { useProgramRecordingActions } from "../_recordings/useProgramRecordingActions";
import {
	use24HourClock,
	usePreferencesOptional
} from "../_preferences/PreferencesProvider";
import { buttonStyles } from "../_ui/Button";
import { EmptyState } from "../_ui/EmptyState";
import { PageHeader } from "../_ui/PageHeader";
import { Spinner } from "../_ui/Spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../_ui/Tabs";
import { MS_PER_HOUR, startOfHour } from "../_guide/time";
import { PlayerPage } from "../_player/PlayerPage";
import { ChannelSwitcher } from "./ChannelSwitcher";
import { MiniGuide } from "./MiniGuide";
import { NowNextPanel } from "./NowNextPanel";
import {
	orderForSwitcher,
	selectNowProgram,
	selectUpcoming,
	stepChannel
} from "./state";

export interface WatchPageProps {
	/** Initial channel id (taken from the route segment). */
	initialChannelId: string;
	/**
	 * Optional fixture override. When provided, no `/api/v1/channels` or
	 * `/api/v1/epg/grid` requests are made. Used by tests + dev preview.
	 */
	initialChannels?: ChannelListItem[] | undefined;
	/**
	 * Optional EPG override. When provided alongside `initialChannels`,
	 * the page renders the supplied grid without fetching.
	 */
	initialGrid?: EpgGrid | undefined;
	/** Persisted favorites, hidden channels, and manual order. */
	initialFavorites?: readonly string[] | undefined;
	initialHidden?: readonly string[] | undefined;
	initialOrder?: readonly string[] | undefined;
	/** Initial player settings (forwarded to {@link PlayerPage}). */
	initialPlayerSettings?: PlayerSettings | undefined;
	/** Override "now" — tests provide a fixed clock for determinism. */
	nowOverride?: Date | undefined;
	/** Whether the user prefers a 24-hour clock. */
	use24Hour?: boolean | undefined;
	/**
	 * URL sync callback. Defaults to `window.history.replaceState` so the
	 * `/watch/<id>` segment matches the active channel without unmounting
	 * the player. Tests / Storybook can swap this with a no-op.
	 */
	onChannelChange?: (channelId: string) => void;
	/** Optional settings seam used by isolated previews and tests. */
	persistChannelPreferences?:
		| ((preferences: ChannelsSettings) => Promise<void> | void)
		| undefined;
	/** Optional action seams; production defaults call the DVR APIs. */
	onRecord?:
		| ((
				program: EpgGridProgram
		  ) => Promise<Recording | void> | Recording | void)
		| undefined;
	onCancel?:
		| ((
				recordingId: string,
				program: EpgGridProgram
		  ) => Promise<Recording | void> | Recording | void)
		| undefined;
	onRecordSeries?:
		| ((
				program: EpgGridProgram
		  ) => Promise<SeriesRule | void> | SeriesRule | void)
		| undefined;
	/** Disable live subscriptions, primarily for deterministic tests. */
	liveUpdates?: boolean | undefined;
}

const DEFAULT_FAVORITES: readonly string[] = [];
const DEFAULT_HIDDEN: readonly string[] = [];
const DEFAULT_ORDER: readonly string[] = [];

function defaultUrlSync(channelId: string): void {
	if (typeof window === "undefined") return;
	const next = `/watch/${encodeURIComponent(channelId)}`;
	if (window.location.pathname === next) return;
	window.history.replaceState(window.history.state, "", next);
}

/**
 * Live watch page (rrainn/SignalHaven#U7-watch).
 *
 * Lays out the player, a now/next strip with inline record actions, the
 * favorites channel switcher, and a per-channel mini-guide. Channel
 * switches are driven by the keyboard (PgUp/PgDn) and the on-screen
 * up/down buttons, and they hot-swap the player source without
 * remounting the underlying `<video>` element — quality state, mute,
 * fullscreen, etc. all survive the swap.
 *
 * Mobile (≤ md) collapses everything below the player into a tabbed
 * surface (Now Playing / Up Next / Channels) so the player stays
 * dominant on smaller screens.
 */
export function WatchPage(props: WatchPageProps) {
	const {
		initialChannelId,
		initialChannels,
		initialGrid,
		initialFavorites = DEFAULT_FAVORITES,
		initialHidden = DEFAULT_HIDDEN,
		initialOrder = DEFAULT_ORDER,
		initialPlayerSettings,
		nowOverride,
		onChannelChange = defaultUrlSync,
		persistChannelPreferences,
		onRecord,
		onCancel,
		onRecordSeries,
		liveUpdates
	} = props;

	const useFixture = Boolean(initialChannels);
	const preferences = usePreferencesOptional();
	const use24Hour = use24HourClock(props.use24Hour);
	const channelPreferences = useMemo<ChannelsSettings>(
		() =>
			useFixture
				? {
						favorites: [...initialFavorites],
						hidden: [...initialHidden],
						order: [...initialOrder]
					}
				: (preferences?.preferences.channels ?? {
						favorites: [],
						hidden: [],
						order: []
					}),
		[
			initialFavorites,
			initialHidden,
			initialOrder,
			preferences?.preferences.channels,
			useFixture
		]
	);

	const [currentChannelId, setCurrentChannelId] = useState(initialChannelId);
	const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
		() => new Set(channelPreferences.favorites)
	);
	const [favoriteSaving, setFavoriteSaving] = useState(false);
	const favoriteSavingRef = useRef(false);
	const [favoriteError, setFavoriteError] = useState<string | null>(null);
	const [channels, setChannels] = useState<ChannelListItem[]>(
		initialChannels ?? []
	);
	const [grid, setGrid] = useState<EpgGrid | null>(initialGrid ?? null);
	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
		useFixture ? "ready" : "idle"
	);

	const [now, setNow] = useState<Date>(() => nowOverride ?? new Date());
	useEffect(() => {
		// Avoid replacing the optimistic state with the old provider snapshot.
		if (favoriteSavingRef.current) return;
		setFavoriteIds(new Set(channelPreferences.favorites));
	}, [channelPreferences.favorites]);

	useEffect(() => {
		if (nowOverride) return;
		const id = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(id);
	}, [nowOverride]);

	/** Fetches the six-hour guide window used by the watch surface. */
	const loadGrid = useCallback(async (): Promise<EpgGrid> => {
		const start = startOfHour(nowOverride ?? new Date());
		const end = new Date(start.getTime() + 6 * MS_PER_HOUR);
		return getEpgGrid({
			from: start.toISOString(),
			to: end.toISOString()
		});
	}, [nowOverride]);

	const reconcileGrid = useCallback(async () => {
		try {
			setGrid(await loadGrid());
		} catch (failure) {
			// Reconnect reconciliation is best-effort; preserve the current snapshot.
			console.warn("Failed to reconcile watch guide data", failure);
		}
	}, [loadGrid]);

	// Settings are owned by the app provider; this route only loads its data.
	useEffect(() => {
		if (useFixture) return;
		let cancelled = false;
		setStatus("loading");
		Promise.all([
			listChannels().then((r) => r.items),
			loadGrid().catch((err: unknown) => {
				// Mini-guide failure should not block live playback/navigation.
				console.warn("Failed to load mini-guide EPG", err);
				return null;
			})
		])
			.then(([items, gridData]) => {
				if (cancelled) return;
				setChannels(items);
				setGrid(gridData);
				setStatus("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				// eslint-disable-next-line no-console
				console.warn("Failed to bootstrap watch page", err);
				setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [loadGrid, useFixture]);

	const updateProgramRecording = useCallback(
		(
			programId: string,
			patch: Pick<EpgGridProgram, "recordingId" | "recordingStatus">
		) => {
			setGrid((current) =>
				current
					? {
							...current,
							programs: current.programs.map((program) =>
								program.id === programId ? { ...program, ...patch } : program
							)
						}
					: current
			);
		},
		[]
	);

	const handleEvent = useCallback(
		(event: EventMessage) => {
			const recordingEvent = parseRecordingEvent(event);
			if (recordingEvent) {
				const programId = recordingEvent.recording.programId;
				if (!programId) return;
				if (recordingEvent.event === RECORDING_EVENT.deleted) {
					void reconcileGrid();
					return;
				}
				updateProgramRecording(programId, {
					recordingId: recordingEvent.recording.id,
					recordingStatus: recordingEvent.recording.status
				});
				return;
			}
			if (event.topic === "epg" && event.event === "epg.refresh") {
				const payload = event.data as { phase?: unknown };
				if (payload.phase === "completed") void reconcileGrid();
			}
		},
		[reconcileGrid, updateProgramRecording]
	);

	useWebSocketEvents({
		topics: ["epg", "recordings"],
		enabled: liveUpdates ?? !useFixture,
		onEvent: handleEvent,
		onReconnect: reconcileGrid
	});

	const {
		pending: recordingPending,
		error: recordingError,
		schedule: scheduleProgram,
		cancel: cancelProgram,
		recordSeries: recordProgramSeries
	} = useProgramRecordingActions({
		onProgramChange: updateProgramRecording,
		schedule: onRecord,
		cancel: onCancel,
		recordSeries: onRecordSeries
	});

	const ordered = useMemo(
		() =>
			orderForSwitcher(
				channels,
				[...favoriteIds],
				channelPreferences.hidden,
				channelPreferences.order
			),
		[channelPreferences.hidden, channelPreferences.order, channels, favoriteIds]
	);

	const currentChannel = useMemo(
		() => channels.find((c) => c.id === currentChannelId) ?? null,
		[channels, currentChannelId]
	);

	const upcoming = useMemo(
		() => selectUpcoming(grid?.programs ?? [], currentChannelId, now, 8),
		[grid, currentChannelId, now]
	);
	const nowProgram = useMemo(
		() => selectNowProgram(grid?.programs ?? [], currentChannelId, now),
		[grid, currentChannelId, now]
	);
	const nextProgram = useMemo(() => {
		if (!nowProgram) return upcoming[0] ?? null;
		return upcoming.find((p) => p.id !== nowProgram.id) ?? null;
	}, [upcoming, nowProgram]);

	const goToChannel = useCallback(
		(id: string) => {
			if (id === currentChannelId) return;
			setCurrentChannelId(id);
			onChannelChange(id);
		},
		[currentChannelId, onChannelChange]
	);

	const stepBy = useCallback(
		(delta: number) => {
			const next = stepChannel(ordered, currentChannelId, delta);
			if (next) goToChannel(next.id);
		},
		[ordered, currentChannelId, goToChannel]
	);

	// PgUp / PgDn keyboard navigation. Skips when the user is typing into
	// an input or a contenteditable region so we don't hijack their text
	// editing — the same heuristic the player uses for its shortcuts.
	useEffect(() => {
		function handler(ev: KeyboardEvent) {
			if (ev.key !== "PageUp" && ev.key !== "PageDown") return;
			const target = ev.target as HTMLElement | null;
			if (
				target &&
				(target.isContentEditable ||
					target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT")
			) {
				return;
			}
			ev.preventDefault();
			// PgUp = previous channel, PgDn = next channel — matches the
			// convention used by every set-top box in the wild.
			stepBy(ev.key === "PageUp" ? -1 : 1);
		}
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [stepBy]);

	const handleRecord = useCallback(
		(p: EpgGridProgram) => {
			void scheduleProgram(p).catch(() => undefined);
		},
		[scheduleProgram]
	);
	const handleCancel = useCallback(
		(p: EpgGridProgram) => {
			void cancelProgram(p).catch(() => undefined);
		},
		[cancelProgram]
	);
	const handleRecordSeries = useCallback(
		(p: EpgGridProgram) => {
			void recordProgramSeries(p).catch(() => undefined);
		},
		[recordProgramSeries]
	);

	const handleToggleFavorite = useCallback(() => {
		if (!currentChannel || favoriteSaving) return;
		const previousFavorites = new Set(favoriteIds);
		const nextFavorites = new Set(favoriteIds);
		if (nextFavorites.has(currentChannel.id)) {
			nextFavorites.delete(currentChannel.id);
		} else {
			nextFavorites.add(currentChannel.id);
		}

		const nextPreferences: ChannelsSettings = {
			...channelPreferences,
			favorites: [...nextFavorites]
		};
		setFavoriteIds(nextFavorites);
		setFavoriteSaving(true);
		favoriteSavingRef.current = true;
		setFavoriteError(null);

		// Start in a promise chain so synchronous preview/test seams roll back too.
		const save = Promise.resolve().then(async () => {
			if (persistChannelPreferences) {
				await persistChannelPreferences(nextPreferences);
				return;
			}
			if (preferences) {
				await preferences.savePreferences({ channels: nextPreferences });
			}
		});

		void save
			.catch((failure: unknown) => {
				// Keep the visible state honest when persistence cannot complete.
				console.error("[watch] failed to persist channel favorite", failure);
				setFavoriteIds(previousFavorites);
				setFavoriteError(
					"Could not save this favorite. Check your connection and try again."
				);
			})
			.finally(() => {
				favoriteSavingRef.current = false;
				setFavoriteSaving(false);
			});
	}, [
		channelPreferences,
		currentChannel,
		favoriteIds,
		favoriteSaving,
		persistChannelPreferences,
		preferences
	]);

	const channelName = currentChannel?.name ?? "Channel";
	const channelNumber = currentChannel?.number ?? "";
	const playerTitle = channelNumber
		? `${channelNumber} · ${channelName}`
		: channelName;

	if (status !== "loading" && !currentChannel) {
		return (
			<section className="space-y-4" aria-labelledby="watch-heading">
				<PageHeader
					headingId="watch-heading"
					title="Live TV"
					description="Watch and manage your available channels."
				/>
				<EmptyState
					icon={<RadioTower />}
					title="Channel not found"
					description="This channel may have been removed or hidden. Return to the Guide to choose an available channel."
					action={
						<SmartLink href="/guide" className={buttonStyles()}>
							Back to Guide
						</SmartLink>
					}
				/>
			</section>
		);
	}

	const switcher = (
		<ChannelSwitcher
			channels={ordered}
			favorites={favoriteIds}
			currentId={currentChannelId}
			onSelect={goToChannel}
			onChannelUp={() => stepBy(-1)}
			onChannelDown={() => stepBy(1)}
		/>
	);

	const nowNext = (
		<NowNextPanel
			channelName={channelName}
			channelNumber={channelNumber}
			isFavorite={favoriteIds.has(currentChannelId)}
			favoritePending={favoriteSaving}
			onToggleFavorite={handleToggleFavorite}
			now={nowProgram}
			next={nextProgram}
			use24Hour={use24Hour}
			onRecord={handleRecord}
			onCancel={handleCancel}
			onRecordSeries={handleRecordSeries}
			pendingAction={
				nowProgram ? recordingPending.get(nowProgram.id) : undefined
			}
		/>
	);

	const miniGuide = (
		<MiniGuide
			programs={upcoming}
			now={now}
			use24Hour={use24Hour}
			onRecord={handleRecord}
			onCancel={handleCancel}
			onRecordSeries={handleRecordSeries}
			pendingActions={recordingPending}
		/>
	);

	return (
		<section
			className="space-y-3"
			data-testid="watch-page"
			aria-labelledby="watch-heading"
		>
			<h1 id="watch-heading" className="sr-only">
				Live TV: {channelNumber} {channelName}
			</h1>
			<div className="overflow-hidden rounded-lg bg-black">
				<PlayerPage
					channelId={currentChannelId}
					mediaTitle={playerTitle}
					mediaSubtitle={nowProgram?.title ?? "Live TV"}
					{...(initialPlayerSettings !== undefined
						? { initialPlayerSettings }
						: {})}
				/>
			</div>

			{status === "loading" && channels.length === 0 ? (
				<div
					className="flex h-20 items-center justify-center text-secondary"
					data-testid="watch-bootstrap"
				>
					<Spinner aria-label="Loading channel data" />
				</div>
			) : null}

			{recordingError ? (
				<p
					role="alert"
					data-testid="watch-recording-error"
					className="rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger"
				>
					{recordingError.message}
				</p>
			) : null}

			{favoriteError ? (
				<p
					role="alert"
					data-testid="watch-favorite-error"
					className="rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger"
				>
					{favoriteError}
				</p>
			) : null}

			{/* Desktop layout — three stacked panels below the player. */}
			<div className="hidden md:block" data-testid="watch-desktop">
				<div className="space-y-3">
					{nowNext}
					{switcher}
					{miniGuide}
				</div>
			</div>

			{/* Mobile layout — tabs so the player stays dominant on small screens. */}
			<div className="md:hidden" data-testid="watch-mobile">
				<Tabs defaultValue="now">
					<TabsList className="w-full">
						<TabsTrigger value="now" className="flex-1">
							Now Playing
						</TabsTrigger>
						<TabsTrigger value="next" className="flex-1">
							Up Next
						</TabsTrigger>
						<TabsTrigger value="channels" className="flex-1">
							Channels
						</TabsTrigger>
					</TabsList>
					<TabsContent value="now">{nowNext}</TabsContent>
					<TabsContent value="next">{miniGuide}</TabsContent>
					<TabsContent value="channels">{switcher}</TabsContent>
				</Tabs>
			</div>
		</section>
	);
}
