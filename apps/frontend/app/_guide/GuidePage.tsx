"use client";

import type {
	ChannelsSettings,
	EpgGrid,
	EpgGridProgram,
	EpgProgramDetails,
	Recording,
	SeriesRule
} from "@signalhaven/shared";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState
} from "react";

import { SmartLink } from "../_layout/SmartLink";
import { getEpgProgram } from "../../lib/api-client";
import { Button, buttonStyles } from "../_ui/Button";
import { EmptyState } from "../_ui/EmptyState";
import { PageHeader } from "../_ui/PageHeader";
import { CalendarRange, RefreshCw } from "lucide-react";

import { useProgramRecordingActions } from "../_recordings/useProgramRecordingActions";
import {
	use24HourClock,
	usePreferencesOptional
} from "../_preferences/PreferencesProvider";
import { selectPreferredChannels } from "../_preferences/channel-preferences";
import { RecordModal, type RecordableProgram } from "../_scheduler/RecordModal";
import { buildGuideFixture } from "./fixtures";
import {
	GuideGrid,
	type GuideGridHandle,
	type GuideScrollOptions,
	type GuideVisibleRange
} from "./GuideGrid";
import { GuideLoadingSkeleton } from "./GuideLoadingSkeleton";
import { GuideToolbar } from "./GuideToolbar";
import { ProgramDetailsModal } from "./ProgramDetailsModal";
import {
	addMinutes,
	addLocalDays,
	isSameLocalDay,
	MS_PER_HOUR,
	startOfDay,
	startOfHour,
	timeOnLocalDay
} from "./time";
import { useGuideData } from "./useGuideData";

export interface GuidePageProps {
	/**
	 * Optional fixture override. When provided, no network/WS activity is
	 * performed and the grid renders the supplied payload directly. Used
	 * by tests, Playwright e2e, and Storybook.
	 */
	initialData?: EpgGrid | undefined;
	/** Time restored from a details/search return URL. */
	initialTime?: Date | undefined;
	/** Channel row restored from a details/search return URL. */
	initialChannelId?: string | undefined;
	/** Initial clock seed used by deterministic fixtures and direct rendering. */
	initialNow?: Date | undefined;
	/** Override "now" — tests provide a fixed clock for determinism. */
	nowOverride?: Date | undefined;
	/** Disable WS subscriptions (default: enabled when no `initialData`). */
	liveUpdates?: boolean | undefined;
	use24Hour?: boolean | undefined;
	/** Requested Guide horizon in hours; production reads the app preference. */
	epgHoursVisible?: number | undefined;
	/** Channel preferences override used by isolated fixtures. */
	channelPreferences?: ChannelsSettings | undefined;
	/** Test seam for the "Record" action (defaults to backend POST). */
	onRecord?:
		| ((
				program: EpgGridProgram
		  ) => Promise<Recording | void> | Recording | void)
		| undefined;
	/** Test seam for cancellation (defaults to the recording cancel API). */
	onCancel?:
		| ((
				recordingId: string,
				program: EpgGridProgram
		  ) => Promise<Recording | void> | Recording | void)
		| undefined;
	/** Test seam for the "Record series" action (defaults to backend POST). */
	onRecordSeries?:
		| ((
				program: EpgGridProgram
		  ) => Promise<SeriesRule | void> | SeriesRule | void)
		| undefined;
	/** Test seam for lazy program-detail loading. */
	loadProgramDetails?:
		| ((programId: string) => Promise<EpgProgramDetails>)
		| undefined;
}

const EMPTY_CHANNEL_PREFERENCES: ChannelsSettings = {
	favorites: [],
	hidden: [],
	order: []
};

const RANGE_EXPANSION_HOURS = 2;
const MAX_BUFFERED_HOURS = 24;
const NOW_LEAD_MINUTES = 30;
const GUIDE_CANVAS_DAYS = 7;
const DATA_PREFETCH_HOURS = 4;

interface GuideRange {
	start: Date;
	end: Date;
}

interface PendingNavigation {
	target: Date;
	options: GuideScrollOptions;
}

/**
 * Live grid guide screen (U4-guide).
 *
 * Loads bounded provider windows inside a stable calendar canvas, renders a
 * 2-axis virtualized grid, and applies live EPG and recording-state updates.
 */
export function GuidePage(props: GuidePageProps) {
	const useFixture = Boolean(props.initialData);
	const preferences = usePreferencesOptional();
	const use24Hour = use24HourClock(props.use24Hour);
	const epgHoursVisible = normalizeHorizonHours(
		props.epgHoursVisible ??
			preferences?.settings.ui.epgHoursVisible ??
			fixtureHours(props.initialData) ??
			24
	);
	const channelPreferences =
		props.channelPreferences ??
		preferences?.settings.channels ??
		EMPTY_CHANNEL_PREFERENCES;

	const [now, setNow] = useState<Date>(
		() => props.nowOverride ?? props.initialNow ?? new Date()
	);
	useEffect(() => {
		if (props.nowOverride) return;
		// 30-second tick is enough granularity for the airing progress bar.
		const id = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(id);
	}, [props.nowOverride]);

	// The calendar canvas owns pixel coordinates for the whole date rail. Data
	// can load and evict inside it without ever redefining horizontal pixel zero.
	const initialRanges = useMemo(() => {
		const seed =
			props.initialTime ??
			props.nowOverride ??
			props.initialNow ??
			(props.initialData ? new Date(props.initialData.from) : new Date());
		const canvas = guideCanvasRange(seed);
		return {
			canvas,
			request: requestRangeAround(seed, canvas, epgHoursVisible)
		};
	}, [
		epgHoursVisible,
		props.initialData,
		props.initialTime,
		props.initialNow,
		props.nowOverride
	]);
	const [canvasRange, setCanvasRange] = useState<GuideRange>(
		initialRanges.canvas
	);
	const [windowRange, setWindowRange] = useState<GuideRange>(
		initialRanges.request
	);

	const { state, refresh, updateProgramRecording } = useGuideData({
		windowStart: windowRange.start,
		windowEnd: windowRange.end,
		initialData: props.initialData,
		liveUpdates: props.liveUpdates ?? !useFixture
	});

	const preparedRangeRef = useRef<GuideRange | null>(null);
	const preparedData = useMemo(
		() =>
			state.data
				? applyGuidePreferences(
						state.data,
						channelPreferences,
						windowRange,
						preparedRangeRef.current
					)
				: null,
		[channelPreferences, state.data, windowRange]
	);
	useLayoutEffect(() => {
		if (!preparedData) return;
		const start = new Date(preparedData.from);
		const end = new Date(preparedData.to);
		if (
			Number.isFinite(start.getTime()) &&
			Number.isFinite(end.getTime()) &&
			start < end
		) {
			preparedRangeRef.current = { start, end };
		}
	}, [preparedData]);
	const data = useMemo(
		() =>
			preparedData
				? {
						...preparedData,
						from: canvasRange.start.toISOString(),
						to: canvasRange.end.toISOString()
					}
				: null,
		[canvasRange, preparedData]
	);
	const loadedRange = useMemo<GuideRange | null>(() => {
		if (!preparedData) return null;
		return {
			start: new Date(preparedData.from),
			end: new Date(preparedData.to)
		};
	}, [preparedData]);
	const gridRef = useRef<GuideGridHandle | null>(null);
	const initialChannelRestoredRef = useRef(false);
	const previousHorizonRef = useRef(epgHoursVisible);
	const pendingNavigationRef = useRef<PendingNavigation | null>({
		target: props.initialTime ?? now,
		options: { behavior: "auto", leadMinutes: NOW_LEAD_MINUTES }
	});
	const [selectedDay, setSelectedDay] = useState(() =>
		startOfDay(props.initialTime ?? now)
	);
	const [visibleRange, setVisibleRange] = useState<GuideVisibleRange>(() => ({
		start: initialRanges.request.start,
		end: initialRanges.request.end
	}));

	useEffect(() => {
		if (!data || !props.initialChannelId || initialChannelRestoredRef.current) {
			return;
		}
		const channelId = props.initialChannelId;
		const frame = window.requestAnimationFrame(() => {
			// Restore search context once so live guide refreshes do not move the user.
			initialChannelRestoredRef.current =
				gridRef.current?.scrollToChannel(channelId) ?? false;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [data, props.initialChannelId]);

	useEffect(() => {
		if (previousHorizonRef.current === epgHoursVisible) return;
		previousHorizonRef.current = epgHoursVisible;

		// Preference hydration changes only the retained data buffer. The calendar
		// canvas and its scroll coordinates remain immutable.
		setWindowRange((previous) =>
			bufferedRequestRange(visibleRange, previous, canvasRange, epgHoursVisible)
		);
	}, [canvasRange, epgHoursVisible, visibleRange]);

	const expandRange = useCallback(
		(direction: "left" | "right") => {
			setWindowRange((previous) =>
				expandRequestRange(previous, direction, canvasRange)
			);
		},
		[canvasRange]
	);

	/**
	 * Reach an exact user-selected instant, carrying it through any range load.
	 * The first activation is therefore complete and repeat activations are
	 * idempotent.
	 */
	const navigateTo = useCallback(
		(target: Date, options: GuideScrollOptions = {}) => {
			const targetMs = target.getTime();
			if (
				targetMs < canvasRange.start.getTime() ||
				targetMs >= canvasRange.end.getTime()
			) {
				// Explicit navigation can replace the date rail's canvas. Ordinary
				// scrolling never can, so its pixel coordinates remain stable.
				const nextCanvas = guideCanvasRange(target);
				pendingNavigationRef.current = { target, options };
				setCanvasRange(nextCanvas);
				setWindowRange(requestRangeAround(target, nextCanvas, epgHoursVisible));
				return;
			}

			const fromMs = loadedRange?.start.getTime() ?? Number.NaN;
			const toMs = loadedRange?.end.getTime() ?? Number.NaN;
			const targetLoaded =
				loadedRange &&
				Number.isFinite(fromMs) &&
				Number.isFinite(toMs) &&
				targetMs >= fromMs &&
				targetMs < toMs;
			const dataCoversRequestedRange =
				loadedRange &&
				fromMs <= windowRange.start.getTime() &&
				toMs >= windowRange.end.getTime();
			const targetWithinRequestedRange =
				targetMs >= windowRange.start.getTime() &&
				targetMs < windowRange.end.getTime();

			if (loadedRange && !dataCoversRequestedRange && targetLoaded) {
				// Retained data can satisfy the newest action immediately even while a
				// different range is in flight. Keep that action pending so it also
				// owns whichever response replaces the current grid.
				pendingNavigationRef.current = { target, options };
				gridRef.current?.scrollToTime(target, options);
				if (!targetWithinRequestedRange) {
					setWindowRange(
						requestRangeAround(target, canvasRange, epgHoursVisible)
					);
				}
				return;
			}

			if (
				loadedRange &&
				!dataCoversRequestedRange &&
				targetWithinRequestedRange
			) {
				// A replacement is already on the way. Preserve only the latest exact
				// destination instead of stacking redundant range expansions.
				pendingNavigationRef.current = { target, options };
				return;
			}

			if (targetLoaded) {
				// A successful latest action supersedes any older pending destination.
				pendingNavigationRef.current = null;
				const result = gridRef.current?.scrollToTime(target, options);
				if (result?.positioned || (result && (options.leadMinutes ?? 0) > 0)) {
					// Context before Now is helpful but optional at a provider boundary;
					// the target itself is already visible and repeated clicks stay put.
					return;
				}

				// The target is loaded but too close to a canvas edge to align. Add a
				// small buffer in that direction and restore the exact target after it
				// arrives.
				pendingNavigationRef.current = { target, options };
				if (result?.constrainedBy) expandRange(result.constrainedBy);
				return;
			}

			pendingNavigationRef.current = { target, options };
			setWindowRange(requestRangeAround(target, canvasRange, epgHoursVisible));
		},
		[canvasRange, epgHoursVisible, expandRange, loadedRange, windowRange]
	);

	useLayoutEffect(() => {
		const pending = pendingNavigationRef.current;
		if (!pending || !loadedRange || !gridRef.current) return;
		const dataFrom = loadedRange.start.getTime();
		const dataTo = loadedRange.end.getTime();
		const targetMs = pending.target.getTime();
		if (targetMs < dataFrom || targetMs >= dataTo) {
			return;
		}
		// Position as soon as the target itself is available. Guard-band prefetch
		// is deliberately invisible to navigation and must never hold the viewport
		// at the canvas origin while useful schedule data is already present.
		const result = gridRef.current.scrollToTime(
			pending.target,
			pending.options
		);
		if (result.positioned || (pending.options.leadMinutes ?? 0) > 0) {
			pendingNavigationRef.current = null;
		} else if (result.constrainedBy) {
			expandRange(result.constrainedBy);
		}
	}, [expandRange, loadedRange, windowRange]);

	const handleVisibleRangeChange = useCallback(
		(next: GuideVisibleRange) => {
			setVisibleRange((previous) =>
				Math.abs(previous.start.getTime() - next.start.getTime()) < 1_000 &&
				Math.abs(previous.end.getTime() - next.end.getTime()) < 1_000
					? previous
					: next
			);
			const midpoint = new Date(
				next.start.getTime() + (next.end.getTime() - next.start.getTime()) / 2
			);
			if (!pendingNavigationRef.current) {
				// An explicit destination owns the date rail until the grid reaches it;
				// otherwise the old viewport can briefly select the wrong day.
				setSelectedDay((previous) =>
					isSameLocalDay(previous, midpoint) ? previous : startOfDay(midpoint)
				);
				// Hour-aligned guard bands keep network and reconciliation work several
				// screens ahead without changing the scroll canvas or its native offset.
				setWindowRange((previous) =>
					bufferedRequestRange(next, previous, canvasRange, epgHoursVisible)
				);
			}
		},
		[canvasRange, epgHoursVisible]
	);

	const handleStep = useCallback(
		(minutes: number) => {
			const pending = pendingNavigationRef.current;
			const current = pending
				? addMinutes(pending.target, -(pending.options.leadMinutes ?? 0))
				: (gridRef.current?.getVisibleRange().start ?? visibleRange.start);
			const target = addMinutes(current, minutes);
			setSelectedDay(startOfDay(target));
			navigateTo(target);
		},
		[navigateTo, visibleRange.start]
	);

	const handleJumpToNow = useCallback(() => {
		setSelectedDay(startOfDay(now));
		navigateTo(now, { leadMinutes: NOW_LEAD_MINUTES });
	}, [navigateTo, now]);

	const handleSelectDay = useCallback(
		(day: Date) => {
			const target = timeOnLocalDay(day, visibleRange.start);
			setSelectedDay(startOfDay(day));
			navigateTo(target);
		},
		[navigateTo, visibleRange.start]
	);

	const handleJumpToHour = useCallback(
		(hour: number) => {
			navigateTo(timeOnLocalDay(selectedDay, { hours: hour }));
		},
		[navigateTo, selectedDay]
	);

	const [selected, setSelected] = useState<{
		programId: string;
		channelId: string;
	} | null>(null);
	const [modalOpen, setModalOpen] = useState(false);
	const [recordOpen, setRecordOpen] = useState(false);
	const [programDetails, setProgramDetails] =
		useState<EpgProgramDetails | null>(null);
	const [detailsStatus, setDetailsStatus] = useState<
		"idle" | "loading" | "ready" | "error"
	>("idle");
	const detailsCacheRef = useRef(new Map<string, EpgProgramDetails>());
	const [detailsRequestVersion, setDetailsRequestVersion] = useState(0);
	useEffect(() => {
		// Any authoritative grid update can reflect a source refresh, so detail
		// metadata is cached only until the next grid reconciliation.
		detailsCacheRef.current.clear();
	}, [state.data]);
	const onSelectProgram = useCallback((program: EpgGridProgram) => {
		setSelected({ programId: program.id, channelId: program.channelId });
		setModalOpen(true);
	}, []);
	const handleDetailsOpenChange = useCallback(
		(open: boolean) => {
			setModalOpen(open);
			if (!open && selected) {
				window.requestAnimationFrame(() => {
					document
						.querySelector<HTMLElement>(
							`[data-program-id="${selected.programId}"][data-channel-id="${selected.channelId}"]`
						)
						?.focus();
				});
			}
		},
		[selected]
	);
	useEffect(() => {
		if (!modalOpen || !selected || (useFixture && !props.loadProgramDetails)) {
			return;
		}
		const cached = detailsCacheRef.current.get(selected.programId);
		if (cached) {
			setProgramDetails(cached);
			setDetailsStatus("ready");
			return;
		}
		const controller = new AbortController();
		setProgramDetails(null);
		setDetailsStatus("loading");
		const load =
			props.loadProgramDetails ?? ((id: string) => getEpgProgram(id));
		void load(selected.programId)
			.then((details) => {
				if (controller.signal.aborted) return;
				detailsCacheRef.current.set(selected.programId, details);
				setProgramDetails(details);
				setDetailsStatus("ready");
			})
			.catch(() => {
				if (!controller.signal.aborted) setDetailsStatus("error");
			});
		return () => controller.abort();
	}, [
		detailsRequestVersion,
		modalOpen,
		props.loadProgramDetails,
		selected,
		useFixture
	]);
	// Watch routes to the U6-player full-page route (a hard navigation
	// keeps the tests free of `next/navigation` router-context wiring).
	// Record / Record series open the shared U9 RecordModal.
	const handleOpenRecord = useCallback(() => {
		setModalOpen(false);
		setRecordOpen(true);
	}, []);
	const handleWatch = useCallback((program: EpgGridProgram) => {
		setModalOpen(false);
		if (typeof window !== "undefined") {
			window.location.assign(`/watch/${encodeURIComponent(program.channelId)}`);
		}
	}, []);
	const {
		pending: recordingPending,
		error: recordingError,
		schedule: scheduleProgram,
		cancel: cancelProgram,
		recordSeries: recordProgramSeries
	} = useProgramRecordingActions({
		onProgramChange: updateProgramRecording,
		schedule: props.onRecord,
		cancel: props.onCancel,
		recordSeries: props.onRecordSeries
	});

	const programByChannelAndId = useMemo(
		() =>
			new Map(
				(data?.programs ?? []).map(
					(program) =>
						[programKey(program.id, program.channelId), program] as const
				)
			),
		[data?.programs]
	);
	const findProgram = useCallback(
		(programId: string, channelId: string) =>
			programByChannelAndId.get(programKey(programId, channelId)) ?? null,
		[programByChannelAndId]
	);
	const handleRecordOne = useCallback(
		async (program: RecordableProgram) => {
			const current = findProgram(program.id, program.channelId);
			if (current) await scheduleProgram(current);
		},
		[findProgram, scheduleProgram]
	);
	const handleRecordSeries = useCallback(
		async (program: RecordableProgram) => {
			const current = findProgram(program.id, program.channelId);
			if (current) await recordProgramSeries(current);
		},
		[findProgram, recordProgramSeries]
	);

	const channelById = useMemo(() => {
		const map = new Map<string, EpgGrid["channels"][number]>();
		if (data) for (const c of data.channels) map.set(c.id, c);
		return map;
	}, [data]);

	const selectedProgram = selected
		? findProgram(selected.programId, selected.channelId)
		: null;
	const selectedAction = selectedProgram
		? recordingPending.get(selectedProgram.id)
		: undefined;
	const selectedError =
		selectedProgram && recordingError?.programId === selectedProgram.id
			? recordingError.message
			: null;
	const allChannelsHidden =
		data?.channels.length === 0 && Boolean(state.data?.channels.length);

	return (
		<section
			className="space-y-4"
			aria-labelledby="guide-heading"
			data-testid="guide-page"
			data-visible-start={visibleRange.start.toISOString()}
		>
			<PageHeader
				headingId="guide-heading"
				title="Guide"
				description="See what is on now and what is coming up across your channels."
			/>

			<GuideToolbar
				selectedDay={selectedDay}
				visibleStart={visibleRange.start}
				visibleEnd={visibleRange.end}
				now={now}
				use24Hour={use24Hour}
				updating={state.status === "loading" && Boolean(data)}
				onStep={handleStep}
				onJumpToNow={handleJumpToNow}
				onSelectDay={handleSelectDay}
				onJumpToHour={handleJumpToHour}
			/>

			{state.status === "error" && data ? (
				<div
					role="alert"
					className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger sm:flex-row sm:items-center"
				>
					<span className="min-w-0 flex-1">
						Couldn&apos;t update this time range. The last loaded schedule is
						still available.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => void refresh()}
						className="shrink-0 border-danger/40"
					>
						<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
						Retry
					</Button>
				</div>
			) : null}

			{state.status === "loading" && !data ? (
				<GuideLoadingSkeleton />
			) : state.status === "error" && !data ? (
				<EmptyState
					role="alert"
					icon={<CalendarRange aria-hidden="true" />}
					title="Couldn't load the guide"
					description={state.error?.message ?? "Please try again later."}
					action={
						<Button onClick={() => void refresh()}>
							<RefreshCw aria-hidden="true" className="h-4 w-4" />
							Try again
						</Button>
					}
				/>
			) : data && data.channels.length === 0 ? (
				<EmptyState
					icon={<CalendarRange aria-hidden="true" />}
					title={
						allChannelsHidden ? "All channels are hidden" : "No channels yet"
					}
					description={
						allChannelsHidden
							? "Choose which channels appear, then return here to browse their schedules."
							: "Configure a tuner and guide source in Settings to start browsing live TV."
					}
					action={
						allChannelsHidden ? (
							<SmartLink
								href="/channels"
								className={buttonStyles({ size: "md" })}
							>
								Manage channels
							</SmartLink>
						) : undefined
					}
				/>
			) : data ? (
				<GuideGrid
					ref={gridRef}
					data={data}
					loadedRange={loadedRange}
					now={now}
					use24Hour={use24Hour}
					onSelectProgram={onSelectProgram}
					onVisibleRangeChange={handleVisibleRangeChange}
				/>
			) : null}

			<ProgramDetailsModal
				open={modalOpen}
				onOpenChange={handleDetailsOpenChange}
				program={selectedProgram}
				details={
					programDetails && programDetails.program.id === selectedProgram?.id
						? programDetails.program
						: null
				}
				detailsStatus={
					useFixture && !props.loadProgramDetails ? "ready" : detailsStatus
				}
				onRetryDetails={() =>
					setDetailsRequestVersion((version) => version + 1)
				}
				channel={
					selected ? (channelById.get(selected.channelId) ?? null) : null
				}
				use24Hour={use24Hour}
				now={now}
				onWatch={handleWatch}
				onRecord={handleOpenRecord}
				onRecordSeries={handleOpenRecord}
				onCancel={cancelProgram}
				recordingPending={selectedAction === "cancel"}
				recordingError={selectedError}
			/>

			<RecordModal
				open={recordOpen}
				onOpenChange={setRecordOpen}
				program={selectedProgram}
				channelLabel={
					selected
						? (() => {
								const ch = channelById.get(selected.channelId);
								return ch ? `${ch.number} · ${ch.name}` : null;
							})()
						: null
				}
				use24Hour={use24Hour}
				onRecord={handleRecordOne}
				onRecordSeries={handleRecordSeries}
			/>
		</section>
	);
}

/** Uses the fixture's own range when a standalone test omits app preferences. */
function fixtureHours(data: EpgGrid | undefined): number | null {
	if (!data) return null;
	const duration = Date.parse(data.to) - Date.parse(data.from);
	if (!Number.isFinite(duration) || duration <= 0) return null;
	return Math.max(1, Math.min(24, Math.round(duration / MS_PER_HOUR)));
}

/** Distinguishes one shared EPG program rendered on multiple tuner channels. */
function programKey(programId: string, channelId: string): string {
	return `${channelId}:${programId}`;
}

/** Keep external preference and fixture input within the API's supported cap. */
function normalizeHorizonHours(hours: number): number {
	if (!Number.isFinite(hours)) return MAX_BUFFERED_HOURS;
	return Math.max(1, Math.min(MAX_BUFFERED_HOURS, Math.round(hours)));
}

/** Calendar-aligned canvas shared by the seven date-rail destinations. */
function guideCanvasRange(seed: Date): GuideRange {
	const start = startOfDay(seed);
	return { start, end: addLocalDays(start, GUIDE_CANVAS_DAYS) };
}

/** Build the first bounded data buffer around an explicit destination. */
function requestRangeAround(
	target: Date,
	canvas: GuideRange,
	horizonHours: number
): GuideRange {
	const requestedHours = Math.min(
		MAX_BUFFERED_HOURS,
		horizonHours + DATA_PREFETCH_HOURS * 2
	);
	const desiredStart = startOfHour(
		addMinutes(target, -DATA_PREFETCH_HOURS * 60)
	);
	return fixedDurationRange(desiredStart, requestedHours * MS_PER_HOUR, canvas);
}

/** Extend or slide the cache without changing the calendar scroll canvas. */
function bufferedRequestRange(
	visible: GuideVisibleRange,
	previous: GuideRange,
	canvas: GuideRange,
	horizonHours: number
): GuideRange {
	const desiredStart = startOfHour(
		addMinutes(visible.start, -DATA_PREFETCH_HOURS * 60)
	);
	const desiredEnd = new Date(
		startOfHour(addMinutes(visible.end, DATA_PREFETCH_HOURS * 60)).getTime() +
			MS_PER_HOUR
	);
	if (
		previous.start <= desiredStart &&
		previous.end >= desiredEnd &&
		previous.start >= canvas.start &&
		previous.end <= canvas.end
	) {
		return previous;
	}

	const overlaps =
		desiredStart.getTime() <= previous.end.getTime() &&
		desiredEnd.getTime() >= previous.start.getTime();
	const start = overlaps
		? new Date(Math.min(previous.start.getTime(), desiredStart.getTime()))
		: desiredStart;
	const end = overlaps
		? new Date(Math.max(previous.end.getTime(), desiredEnd.getTime()))
		: desiredEnd;
	const minimumDuration = Math.min(
		MAX_BUFFERED_HOURS,
		horizonHours + DATA_PREFETCH_HOURS * 2
	);
	const desiredDuration = Math.max(
		minimumDuration * MS_PER_HOUR,
		end.getTime() - start.getTime()
	);
	const focus = new Date(
		visible.start.getTime() +
			(visible.end.getTime() - visible.start.getTime()) / 2
	);
	return boundedRangeAround(start, desiredDuration, focus, canvas);
}

/** Add one request partition while respecting the bounded client cache. */
function expandRequestRange(
	previous: GuideRange,
	direction: "left" | "right",
	canvas: GuideRange
): GuideRange {
	const expansion = RANGE_EXPANSION_HOURS * MS_PER_HOUR;
	const start =
		direction === "left"
			? new Date(previous.start.getTime() - expansion)
			: previous.start;
	const end =
		direction === "right"
			? new Date(previous.end.getTime() + expansion)
			: previous.end;
	const focus = direction === "left" ? start : end;
	return boundedRangeAround(
		start,
		end.getTime() - start.getTime(),
		focus,
		canvas
	);
}

/** Clamp a requested duration around a focus while preserving calendar bounds. */
function boundedRangeAround(
	desiredStart: Date,
	desiredDuration: number,
	focus: Date,
	canvas: GuideRange
): GuideRange {
	const duration = Math.min(
		MAX_BUFFERED_HOURS * MS_PER_HOUR,
		desiredDuration,
		canvas.end.getTime() - canvas.start.getTime()
	);
	let start = Math.max(canvas.start.getTime(), desiredStart.getTime());
	let end = Math.min(canvas.end.getTime(), start + duration);
	if (end - start < duration)
		start = Math.max(canvas.start.getTime(), end - duration);

	if (focus.getTime() < start || focus.getTime() >= end) {
		start = Math.max(
			canvas.start.getTime(),
			Math.min(focus.getTime() - duration / 2, canvas.end.getTime() - duration)
		);
		end = start + duration;
	}
	return { start: new Date(start), end: new Date(end) };
}

/** Clamp a fixed request duration to the stable calendar canvas. */
function fixedDurationRange(
	desiredStart: Date,
	duration: number,
	canvas: GuideRange
): GuideRange {
	return boundedRangeAround(desiredStart, duration, desiredStart, canvas);
}

/**
 * Applies the requested horizon and shared channel contract. While a new
 * request is in flight, the last prepared bounds keep the coordinate space
 * stable even when a fixture or cache contains a wider payload.
 */
function applyGuidePreferences(
	data: EpgGrid,
	channelPreferences: ChannelsSettings,
	requestedRange: GuideRange,
	fallbackRange: GuideRange | null
): EpgGrid {
	const rawFrom = Date.parse(data.from);
	const rawTo = Date.parse(data.to);
	const requestedFrom = requestedRange.start.getTime();
	const requestedTo = requestedRange.end.getTime();
	const validRawRange =
		Number.isFinite(rawFrom) && Number.isFinite(rawTo) && rawFrom < rawTo;
	const rawContainsRequest =
		validRawRange && rawFrom <= requestedFrom && rawTo >= requestedTo;
	const fallbackFrom = fallbackRange?.start.getTime() ?? Number.NaN;
	const fallbackTo = fallbackRange?.end.getTime() ?? Number.NaN;
	const rawContainsFallback =
		validRawRange &&
		Number.isFinite(fallbackFrom) &&
		Number.isFinite(fallbackTo) &&
		rawFrom <= fallbackFrom &&
		rawTo >= fallbackTo;

	// Wide fixtures can be sliced to the requested horizon. During a real range
	// load, keep the previous valid response intact until its replacement lands
	// instead of intersecting disjoint bounds into an invalid from > to canvas.
	const from = rawContainsRequest
		? requestedFrom
		: rawContainsFallback
			? fallbackFrom
			: rawFrom;
	const to = rawContainsRequest
		? requestedTo
		: rawContainsFallback
			? fallbackTo
			: rawTo;
	const channels = selectPreferredChannels(data.channels, channelPreferences);
	const visibleIds = new Set(channels.map((channel) => channel.id));

	if (!validRawRange || !Number.isFinite(from) || !Number.isFinite(to)) {
		// A malformed provider range must not leak NaN dimensions into the grid.
		return {
			...data,
			from: new Date(requestedFrom).toISOString(),
			to: new Date(requestedTo).toISOString(),
			channels,
			programs: []
		};
	}

	return {
		...data,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		channels,
		programs: data.programs.filter((program) => {
			if (!visibleIds.has(program.channelId)) return false;
			const start = Date.parse(program.start);
			const stop = Date.parse(program.stop);
			return (
				Number.isFinite(start) &&
				Number.isFinite(stop) &&
				stop > start &&
				start < to &&
				stop > from
			);
		})
	};
}

/**
 * Build a small deterministic fixture for isolated previews and stories.
 */
export function buildPreviewFixture(now: Date = new Date()): EpgGrid {
	return buildGuideFixture({
		channelCount: 12,
		windowHours: 24,
		from: startOfHour(new Date(now.getTime() - MS_PER_HOUR)),
		seed: 42
	});
}
