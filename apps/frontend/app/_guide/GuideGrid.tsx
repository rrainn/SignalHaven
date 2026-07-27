"use client";

import type { EpgGrid, EpgGridProgram } from "@signalhaven/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
	forwardRef,
	memo,
	useCallback,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type UIEvent as ReactUIEvent,
	type WheelEvent as ReactWheelEvent
} from "react";

import { ChannelRow } from "./ChannelRow";
import { ProgramCell } from "./ProgramCell";
import { cn } from "../_ui/cn";
import { formatTimeLabel, MS_PER_MINUTE } from "./time";

/** Desktop geometry remains exported for deterministic layout tests. */
export const ROW_HEIGHT = 64;
export const CHANNEL_COL_WIDTH = 176;
export const HEADER_HEIGHT = 44;
export const PIXELS_PER_MINUTE = 4;

const MOBILE_CHANNEL_COL_WIDTH = 116;
const MOBILE_PIXELS_PER_MINUTE = 3;
const MOBILE_BREAKPOINT = 640;
const ROW_OVERSCAN = 4;
const TIME_OVERSCAN_MIN = 30;
const MIN_VISIBLE_GAP_LABEL_WIDTH = 112;
const EDGE_HYSTERESIS_MULTIPLIER = 2;
const INPUT_INTENT_IDLE_MS = 240;
const POINTER_AXIS_THRESHOLD = 10;
const MOBILE_TIME_STEP_MINUTES = 30;

export interface GuideVisibleRange {
	start: Date;
	end: Date;
}

export interface GuideScrollOptions {
	behavior?: ScrollBehavior;
	/** Minutes of schedule context retained before the target. */
	leadMinutes?: number;
}

export interface GuideScrollResult {
	positioned: boolean;
	visibleStart: Date;
	/** Canvas edge preventing the requested alignment, when one exists. */
	constrainedBy: "left" | "right" | null;
}

/** Typed navigation surface used by the toolbar without global DOM lookups. */
export interface GuideGridHandle {
	getVisibleRange: () => GuideVisibleRange;
	/** Reveals a channel row while preserving the current time position. */
	scrollToChannel: (channelId: string) => boolean;
	scrollToTime: (
		target: Date,
		options?: GuideScrollOptions
	) => GuideScrollResult;
}

export interface GuideGridProps {
	data: EpgGrid;
	/** Contiguous schedule interval currently backed by fetched provider data. */
	loadedRange?: GuideVisibleRange | null;
	/** Wall-clock now rendered as the live vertical marker. */
	now: Date;
	use24Hour?: boolean;
	onSelectProgram: (program: EpgGridProgram) => void;
	/**
	 * Fired once per genuine horizontal edge approach. Vertical and
	 * programmatic scrolling never trigger range expansion.
	 */
	onApproachEdge?: (direction: "left" | "right") => void;
	/** Frame-committed visible bounds used by the toolbar's range label. */
	onVisibleRangeChange?: (range: GuideVisibleRange) => void;
}

interface Viewport {
	width: number;
	height: number;
	scrollLeft: number;
	scrollTop: number;
}

interface GridGeometry {
	channelWidth: number;
	pixelsPerMinute: number;
}

interface LaidOutCell {
	program: EpgGridProgram;
	startMs: number;
	stopMs: number;
	left: number;
	width: number;
	channelName: string;
	nextProgramTitle?: string | undefined;
	nextProgramStartMs?: number | undefined;
}

interface TemporalGap {
	startMs: number;
	stopMs: number;
	kind: "missing" | "loading";
}

interface LaidOutGap extends TemporalGap {
	channelId: string;
	channelName: string;
	left: number;
	width: number;
	nextProgramTitle?: string | undefined;
	nextProgramStartMs?: number | undefined;
}

/** Parsed schedule interval used by rendering and keyboard navigation. */
interface TemporalProgramEntry {
	program: EpgGridProgram;
	startMs: number;
	stopMs: number;
	visualStopMs: number;
}

/**
 * Two-axis virtualized live-TV guide with stable time coordinates.
 *
 * Native scroll events are coalesced to one immutable viewport sample per
 * animation frame, shared by virtualization and the toolbar.
 */
const GuideGridImpl = forwardRef<GuideGridHandle, GuideGridProps>(
	function GuideGrid(props, ref) {
		const {
			data,
			loadedRange,
			now,
			use24Hour = false,
			onSelectProgram,
			onApproachEdge,
			onVisibleRangeChange
		} = props;
		const scrollerRef = useRef<HTMLDivElement | null>(null);
		const animationFrameRef = useRef<number | null>(null);
		const programmaticTimerRef = useRef<number | null>(null);
		const lastScrollLeftRef = useRef(0);
		const navigationTargetLeftRef = useRef<number | null>(null);
		const edgeLatchRef = useRef<"left" | "right" | null>(null);
		const suppressEdgesRef = useRef(false);
		const pointerOriginRef = useRef<{
			x: number;
			y: number;
			pointerType: string;
		} | null>(null);
		const inputAxisRef = useRef<"horizontal" | "vertical" | null>(null);
		const inputIntentTimerRef = useRef<number | null>(null);

		const [viewport, setViewport] = useState<Viewport>({
			width: 1024,
			height: 600,
			scrollLeft: 0,
			scrollTop: 0
		});
		const [focusedProgramKey, setFocusedProgramKey] = useState<string | null>(
			null
		);

		const fromMs = useMemo(() => Date.parse(data.from), [data.from]);
		const toMs = useMemo(() => Date.parse(data.to), [data.to]);
		const loadedFromMs = clamp(
			loadedRange?.start.getTime() ?? fromMs,
			fromMs,
			toMs
		);
		const loadedToMs = clamp(
			loadedRange?.end.getTime() ?? toMs,
			loadedFromMs,
			toMs
		);
		const totalMinutes = Math.max(
			1,
			Math.round((toMs - fromMs) / MS_PER_MINUTE)
		);
		const geometry = getGridGeometry(viewport.width);
		const { channelWidth, pixelsPerMinute } = geometry;
		const contentWidth = totalMinutes * pixelsPerMinute;
		const contentHeight = data.channels.length * ROW_HEIGHT;
		const canvasWidth = channelWidth + contentWidth;
		const canvasHeight = HEADER_HEIGHT + contentHeight;

		const channelIndexById = useMemo(
			() =>
				new Map(
					data.channels.map((channel, index) => [channel.id, index] as const)
				),
			[data.channels]
		);

		// Parse, validate, and sort once so scrolling only searches numeric ranges.
		const temporalIndexByChannel = useMemo(() => {
			const map = new Map<string, TemporalProgramEntry[]>();
			for (const program of data.programs) {
				const startMs = Date.parse(program.start);
				const stopMs = Date.parse(program.stop);
				if (
					!Number.isFinite(startMs) ||
					!Number.isFinite(stopMs) ||
					stopMs <= startMs
				) {
					continue;
				}
				const entry = { program, startMs, stopMs, visualStopMs: stopMs };
				const list = map.get(program.channelId);
				if (list) list.push(entry);
				else map.set(program.channelId, [entry]);
			}
			for (const [channelId, list] of map) {
				list.sort(
					(left, right) =>
						left.startMs - right.startMs || right.stopMs - left.stopMs
				);

				// Conflicting rows with the same start cannot both be actionable in a
				// one-line guide. Keep the longest deterministic entry.
				const deduplicated = list.filter(
					(entry, index) =>
						index === 0 || entry.startMs !== list[index - 1]!.startMs
				);
				for (let index = 0; index < deduplicated.length - 1; index += 1) {
					const entry = deduplicated[index]!;
					const nextStartMs = deduplicated[index + 1]!.startMs;
					// Preserve real provider times while preventing overlapping controls.
					entry.visualStopMs = Math.min(entry.stopMs, nextStartMs);
				}
				map.set(channelId, deduplicated);
			}
			return map;
		}, [data.programs]);

		const visibleAreaWidth = Math.max(0, viewport.width - channelWidth);
		const visibleAreaHeight = Math.max(0, viewport.height - HEADER_HEIGHT);
		const firstRow = Math.max(
			0,
			Math.floor(viewport.scrollTop / ROW_HEIGHT) - ROW_OVERSCAN
		);
		const lastRow = Math.min(
			data.channels.length,
			Math.ceil((viewport.scrollTop + visibleAreaHeight) / ROW_HEIGHT) +
				ROW_OVERSCAN
		);
		const visibleStartMin = Math.max(
			0,
			Math.floor(viewport.scrollLeft / pixelsPerMinute) - TIME_OVERSCAN_MIN
		);
		const visibleEndMin = Math.min(
			totalMinutes,
			Math.ceil((viewport.scrollLeft + visibleAreaWidth) / pixelsPerMinute) +
				TIME_OVERSCAN_MIN
		);
		const visibleStartMs = fromMs + visibleStartMin * MS_PER_MINUTE;
		const visibleEndMs = fromMs + visibleEndMin * MS_PER_MINUTE;
		const timeAnchorLayout = viewport.width < MOBILE_BREAKPOINT;
		const rawTimeAnchorMs = clamp(
			fromMs + (viewport.scrollLeft / pixelsPerMinute) * MS_PER_MINUTE,
			fromMs,
			toMs - 1
		);
		// Mobile is intentionally discrete: every rendered state corresponds to
		// one stable half-hour coordinate instead of an invisible freeform scrub.
		const timeAnchorMs = timeAnchorLayout
			? snapTimeToStep(rawTimeAnchorMs, fromMs)
			: rawTimeAnchorMs;
		const navigationScrollLeft = timeAnchorLayout
			? ((timeAnchorMs - fromMs) / MS_PER_MINUTE) * pixelsPerMinute
			: viewport.scrollLeft;
		const visibleChannels = data.channels.slice(firstRow, lastRow);
		const temporalGapsByChannel = useMemo(() => {
			const gaps = new Map<string, TemporalGap[]>();
			for (const channel of data.channels) {
				gaps.set(
					channel.id,
					buildScheduleGaps(
						temporalIndexByChannel.get(channel.id) ?? [],
						fromMs,
						toMs,
						loadedFromMs,
						loadedToMs
					)
				);
			}
			return gaps;
		}, [
			data.channels,
			fromMs,
			loadedFromMs,
			loadedToMs,
			temporalIndexByChannel,
			toMs
		]);
		const defaultProgramKey = useMemo(() => {
			for (const channel of data.channels) {
				const entry = nearestProgram(
					temporalIndexByChannel.get(channel.id) ?? [],
					now.getTime()
				);
				if (entry) return programKey(entry.program);
			}
			return null;
		}, [data.channels, now, temporalIndexByChannel]);
		const rovingProgramKey = focusedProgramKey ?? defaultProgramKey;

		const visibleCells: LaidOutCell[] = [];
		const visibleGaps: LaidOutGap[] = [];
		for (let index = 0; index < visibleChannels.length; index += 1) {
			const channel = visibleChannels[index]!;
			const entries = temporalIndexByChannel.get(channel.id) ?? [];
			if (timeAnchorLayout) {
				const anchoredIndex = entries.findIndex(
					(entry) =>
						entry.startMs <= timeAnchorMs && timeAnchorMs < entry.visualStopMs
				);
				const anchoredEntry = entries[anchoredIndex];
				const nextEntry = entries[anchoredIndex + 1];
				if (anchoredEntry) {
					visibleCells.push({
						program: anchoredEntry.program,
						startMs: anchoredEntry.startMs,
						stopMs: anchoredEntry.stopMs,
						left: viewport.scrollLeft,
						width: Math.max(44, visibleAreaWidth),
						channelName: channel.name,
						nextProgramTitle: nextEntry?.program.title,
						nextProgramStartMs: nextEntry?.startMs
					});
				} else {
					const nextKnownEntry = entries.find(
						(entry) => entry.startMs > timeAnchorMs
					);
					const anchoredGap = (
						temporalGapsByChannel.get(channel.id) ?? []
					).find(
						(gap) => gap.startMs <= timeAnchorMs && timeAnchorMs < gap.stopMs
					);
					if (anchoredGap) {
						visibleGaps.push({
							...anchoredGap,
							channelId: channel.id,
							channelName: channel.name,
							left: viewport.scrollLeft,
							width: Math.max(44, visibleAreaWidth),
							nextProgramTitle: nextKnownEntry?.program.title,
							nextProgramStartMs: nextKnownEntry?.startMs
						});
					}
				}
				continue;
			}
			for (
				let programIndex = firstIntersectingProgram(entries, visibleStartMs);
				programIndex < entries.length;
				programIndex += 1
			) {
				const { program, startMs, stopMs, visualStopMs } =
					entries[programIndex]!;
				if (startMs >= visibleEndMs) break;
				const clippedStart = Math.max(startMs, fromMs);
				const clippedStop = Math.min(visualStopMs, toMs);
				if (clippedStop <= clippedStart) continue;
				visibleCells.push({
					program,
					startMs,
					stopMs,
					left: ((clippedStart - fromMs) / MS_PER_MINUTE) * pixelsPerMinute,
					width:
						((clippedStop - clippedStart) / MS_PER_MINUTE) * pixelsPerMinute,
					channelName: channel.name
				});
			}
			const gaps = temporalGapsByChannel.get(channel.id) ?? [];
			for (let gapIndex = 0; gapIndex < gaps.length; gapIndex += 1) {
				const gap = gaps[gapIndex]!;
				if (gap.stopMs <= visibleStartMs || gap.startMs >= visibleEndMs)
					continue;
				const clippedStart = Math.max(gap.startMs, fromMs);
				const clippedStop = Math.min(gap.stopMs, toMs);
				visibleGaps.push({
					...gap,
					channelId: channel.id,
					channelName: channel.name,
					left: ((clippedStart - fromMs) / MS_PER_MINUTE) * pixelsPerMinute,
					width:
						((clippedStop - clippedStart) / MS_PER_MINUTE) * pixelsPerMinute
				});
			}
		}

		const firstTickMin = Math.floor(visibleStartMin / 30) * 30;
		const lastTickMin = Math.floor(visibleEndMin / 30) * 30;
		const ticks = useMemo(() => {
			const next: Array<{
				left: number;
				label: string;
				dayLabel: string | null;
			}> = [];
			let previousTick: Date | null = null;
			for (let minute = firstTickMin; minute <= lastTickMin; minute += 30) {
				// The exclusive endpoint has no schedulable width. Rendering its text
				// would overflow the fixed canvas and change WebKit's scrollWidth.
				if (minute < 0 || minute >= totalMinutes) continue;
				const date = new Date(fromMs + minute * MS_PER_MINUTE);
				const dayChanged =
					previousTick !== null && previousTick.getDate() !== date.getDate();
				next.push({
					left: minute * pixelsPerMinute,
					label: formatTimeLabel(date, use24Hour),
					dayLabel: dayChanged
						? date.toLocaleDateString(undefined, { weekday: "short" })
						: null
				});
				previousTick = date;
			}
			return next;
		}, [
			firstTickMin,
			fromMs,
			lastTickMin,
			pixelsPerMinute,
			totalMinutes,
			use24Hour
		]);

		const nowMs = now.getTime();
		const nowVisible = nowMs >= fromMs && nowMs <= toMs;
		const nowLeft = nowVisible
			? ((nowMs - fromMs) / MS_PER_MINUTE) * pixelsPerMinute
			: 0;
		const nowMsQuantized = Math.floor(nowMs / 30_000) * 30_000;

		const getVisibleRangeForPosition = useCallback(
			(scrollLeft: number): GuideVisibleRange => {
				const start = new Date(
					fromMs + (scrollLeft / pixelsPerMinute) * MS_PER_MINUTE
				);
				const visibleMinutes =
					Math.max(0, viewport.width - channelWidth) / pixelsPerMinute;
				const endMs = Math.min(
					toMs,
					start.getTime() + visibleMinutes * MS_PER_MINUTE
				);
				return { start, end: new Date(endMs) };
			},
			[channelWidth, fromMs, pixelsPerMinute, toMs, viewport.width]
		);

		const emitVisibleRange = useCallback(
			(scrollLeft: number) => {
				onVisibleRangeChange?.(getVisibleRangeForPosition(scrollLeft));
			},
			[getVisibleRangeForPosition, onVisibleRangeChange]
		);
		const commitViewport = useCallback((element: HTMLDivElement): Viewport => {
			// Safari can advance momentum while React processes an event. Freeze one
			// frame sample for every dependent render.
			const next = {
				width: element.clientWidth,
				height: element.clientHeight,
				scrollLeft: element.scrollLeft,
				scrollTop: element.scrollTop
			};
			setViewport((previous) =>
				sameViewport(previous, next) ? previous : next
			);
			return next;
		}, []);

		const scheduleViewportCommit = useCallback(() => {
			if (animationFrameRef.current !== null) return;
			animationFrameRef.current = requestFrame(() => {
				animationFrameRef.current = null;
				const element = scrollerRef.current;
				if (!element) return;
				commitViewport(element);
			});
		}, [commitViewport]);

		const suppressProgrammaticEdges = useCallback(() => {
			suppressEdgesRef.current = true;
			if (programmaticTimerRef.current !== null) {
				window.clearTimeout(programmaticTimerRef.current);
			}
			programmaticTimerRef.current = window.setTimeout(() => {
				suppressEdgesRef.current = false;
				navigationTargetLeftRef.current = null;
				const element = scrollerRef.current;
				if (element) {
					// Some engines coalesce programmatic scroll events. One final sample
					// keeps virtualization and the toolbar on the same coordinate.
					const nextViewport = commitViewport(element);
					lastScrollLeftRef.current = nextViewport.scrollLeft;
				}
				programmaticTimerRef.current = null;
			}, 600);
		}, [commitViewport]);

		/**
		 * A direct gesture supersedes any pending animated destination so the next
		 * toolbar action starts from the place the user deliberately chose.
		 */
		const handleUserScrollIntent = useCallback(() => {
			navigationTargetLeftRef.current = null;
			suppressEdgesRef.current = false;
			if (programmaticTimerRef.current !== null) {
				window.clearTimeout(programmaticTimerRef.current);
				programmaticTimerRef.current = null;
			}
			const element = scrollerRef.current;
			if (element) lastScrollLeftRef.current = element.scrollLeft;
		}, []);

		/** Keep the gesture axis long enough to classify its resulting scrolls. */
		const markInputAxis = useCallback(
			(axis: "horizontal" | "vertical" | null) => {
				inputAxisRef.current = axis;
				if (inputIntentTimerRef.current !== null) {
					window.clearTimeout(inputIntentTimerRef.current);
					inputIntentTimerRef.current = null;
				}
				if (axis) {
					inputIntentTimerRef.current = window.setTimeout(() => {
						inputAxisRef.current = null;
						inputIntentTimerRef.current = null;
					}, INPUT_INTENT_IDLE_MS);
				}
			},
			[]
		);

		const scrollToTime = useCallback(
			(target: Date, options: GuideScrollOptions = {}): GuideScrollResult => {
				const element = scrollerRef.current;
				const requestedTargetMs = target.getTime();
				// Parent layout effects can navigate before the responsive state update.
				// The live element width is authoritative at this imperative boundary.
				const mobileTimeNavigation = element
					? element.clientWidth < MOBILE_BREAKPOINT
					: timeAnchorLayout;
				// Discrete mobile navigation always lands on a visible time step. The
				// desktop guide preserves exact instants and optional leading context.
				const targetMs = mobileTimeNavigation
					? snapTimeToStep(requestedTargetMs, fromMs)
					: requestedTargetMs;
				if (!element || targetMs < fromMs || targetMs >= toMs) {
					return {
						positioned: false,
						visibleStart: new Date(
							fromMs +
								((element?.scrollLeft ?? 0) / pixelsPerMinute) * MS_PER_MINUTE
						),
						constrainedBy: null
					};
				}

				const targetX = ((targetMs - fromMs) / MS_PER_MINUTE) * pixelsPerMinute;
				const desiredLeft = mobileTimeNavigation
					? targetX
					: targetX - (options.leadMinutes ?? 0) * pixelsPerMinute;
				const maxScrollLeft = Math.max(
					0,
					canvasWidth - Math.max(0, element.clientWidth)
				);
				const left = clamp(desiredLeft, 0, maxScrollLeft);
				const constrainedBy =
					desiredLeft < -1
						? "left"
						: desiredLeft > maxScrollLeft + 1
							? "right"
							: null;
				// Native smooth scrolling is asynchronous. Remember the destination so
				// rapid repeated controls accumulate from it instead of an in-flight
				// physical scroll position.
				navigationTargetLeftRef.current = left;
				suppressProgrammaticEdges();
				const behavior = resolvedScrollBehavior(options.behavior ?? "smooth");
				scrollElement(element, {
					left,
					behavior
				});
				const nextViewport = commitViewport(element);
				lastScrollLeftRef.current = nextViewport.scrollLeft;
				return {
					positioned: constrainedBy === null,
					visibleStart: new Date(
						fromMs + (left / pixelsPerMinute) * MS_PER_MINUTE
					),
					constrainedBy
				};
			},
			[
				canvasWidth,
				commitViewport,
				fromMs,
				pixelsPerMinute,
				suppressProgrammaticEdges,
				timeAnchorLayout,
				toMs
			]
		);

		/** Move the mobile list by one explicit half-hour state. */
		const stepTimeAnchor = useCallback(
			(direction: -1 | 1) => {
				const targetMs = clamp(
					timeAnchorMs + direction * MOBILE_TIME_STEP_MINUTES * MS_PER_MINUTE,
					fromMs,
					toMs - 1
				);
				scrollToTime(new Date(targetMs), { behavior: "auto" });
			},
			[fromMs, scrollToTime, timeAnchorMs, toMs]
		);

		const scrollToChannel = useCallback(
			(channelId: string): boolean => {
				const element = scrollerRef.current;
				const rowIndex = channelIndexById.get(channelId);
				if (!element || rowIndex === undefined) return false;
				scrollElement(element, {
					top: rowIndex * ROW_HEIGHT,
					behavior: "auto"
				});
				scheduleViewportCommit();
				return true;
			},
			[channelIndexById, scheduleViewportCommit]
		);

		useImperativeHandle(
			ref,
			() => ({
				getVisibleRange: () => {
					const element = scrollerRef.current;
					return getVisibleRangeForPosition(
						timeAnchorLayout
							? navigationScrollLeft
							: (navigationTargetLeftRef.current ?? element?.scrollLeft ?? 0)
					);
				},
				scrollToChannel,
				scrollToTime
			}),
			[
				getVisibleRangeForPosition,
				navigationScrollLeft,
				scrollToChannel,
				scrollToTime,
				timeAnchorLayout
			]
		);

		useLayoutEffect(() => {
			const element = scrollerRef.current;
			if (!element) return;
			// The calendar canvas gives every instant a durable pixel coordinate.
			// Buffer refreshes therefore need no scroll compensation and cannot race
			// Safari's native momentum scrolling.
			const nextViewport = commitViewport(element);
			lastScrollLeftRef.current = nextViewport.scrollLeft;
			edgeLatchRef.current = null;
			markInputAxis(null);

			if (typeof ResizeObserver === "undefined") return undefined;
			const observer = new ResizeObserver(() => scheduleViewportCommit());
			observer.observe(element);
			return () => observer.disconnect();
		}, [
			commitViewport,
			fromMs,
			markInputAxis,
			pixelsPerMinute,
			scheduleViewportCommit
		]);

		useLayoutEffect(() => {
			// The toolbar may publish only coordinates already used by this render.
			// Layout effects flush the parent update before paint, keeping Safari's
			// momentum and buffered data changes visually aligned.
			emitVisibleRange(navigationScrollLeft);
		}, [emitVisibleRange, navigationScrollLeft]);

		useLayoutEffect(
			() => () => {
				if (animationFrameRef.current !== null) {
					cancelFrame(animationFrameRef.current);
				}
				if (programmaticTimerRef.current !== null) {
					window.clearTimeout(programmaticTimerRef.current);
				}
				if (inputIntentTimerRef.current !== null) {
					window.clearTimeout(inputIntentTimerRef.current);
				}
			},
			[]
		);

		const onScroll = useCallback(
			(event: ReactUIEvent<HTMLDivElement>) => {
				const element = event.currentTarget;
				const previousLeft = lastScrollLeftRef.current;
				const nextScrollLeft = element.scrollLeft;
				const deltaX = nextScrollLeft - previousLeft;
				lastScrollLeftRef.current = nextScrollLeft;
				// Trackpads can deliver multiple events inside one display interval.
				// Reconcile the latest physical sample once before the next paint.
				scheduleViewportCommit();
				const inputAxis = inputAxisRef.current;
				if (inputAxis) markInputAxis(inputAxis);

				if (
					!onApproachEdge ||
					suppressEdgesRef.current ||
					inputAxis !== "horizontal" ||
					Math.abs(deltaX) < 0.5
				) {
					return;
				}

				const visibleWidth = Math.max(0, element.clientWidth - channelWidth);
				const edgeThreshold = Math.max(48, visibleWidth * 0.18);
				const maxScrollLeft = Math.max(0, canvasWidth - element.clientWidth);
				const nearLeft = nextScrollLeft <= edgeThreshold;
				const nearRight = nextScrollLeft >= maxScrollLeft - edgeThreshold;

				if (deltaX < 0 && nearLeft && edgeLatchRef.current !== "left") {
					edgeLatchRef.current = "left";
					onApproachEdge("left");
				} else if (
					deltaX > 0 &&
					nearRight &&
					edgeLatchRef.current !== "right"
				) {
					edgeLatchRef.current = "right";
					onApproachEdge("right");
				} else if (
					nextScrollLeft > edgeThreshold * EDGE_HYSTERESIS_MULTIPLIER &&
					nextScrollLeft <
						maxScrollLeft - edgeThreshold * EDGE_HYSTERESIS_MULTIPLIER
				) {
					edgeLatchRef.current = null;
				}
			},
			[
				canvasWidth,
				channelWidth,
				markInputAxis,
				onApproachEdge,
				scheduleViewportCommit
			]
		);

		const onWheel = useCallback(
			(event: ReactWheelEvent<HTMLDivElement>) => {
				// A wheel can express intent even when the browser is already clamped
				// and therefore emits no scroll event. Ignore ordinary vertical page
				// gestures so they can never change the guide date.
				const horizontalDelta = event.shiftKey
					? event.deltaY
					: Math.abs(event.deltaX) > Math.abs(event.deltaY)
						? event.deltaX
						: 0;
				const horizontalIntent = Math.abs(horizontalDelta) >= 0.5;
				markInputAxis(horizontalIntent ? "horizontal" : "vertical");
				if (!horizontalIntent) return;

				handleUserScrollIntent();
				if (!onApproachEdge) return;

				const element = event.currentTarget;
				const maxScrollLeft = Math.max(0, canvasWidth - element.clientWidth);
				if (
					horizontalDelta < 0 &&
					element.scrollLeft <= 1 &&
					edgeLatchRef.current !== "left"
				) {
					edgeLatchRef.current = "left";
					onApproachEdge("left");
				} else if (
					horizontalDelta > 0 &&
					element.scrollLeft >= maxScrollLeft - 1 &&
					edgeLatchRef.current !== "right"
				) {
					edgeLatchRef.current = "right";
					onApproachEdge("right");
				}
			},
			[canvasWidth, handleUserScrollIntent, markInputAxis, onApproachEdge]
		);

		const onPointerDown = useCallback(
			(event: ReactPointerEvent<HTMLDivElement>) => {
				markInputAxis(null);
				pointerOriginRef.current = {
					x: event.clientX,
					y: event.clientY,
					pointerType: event.pointerType
				};
			},
			[markInputAxis]
		);

		const onPointerMove = useCallback(
			(event: ReactPointerEvent<HTMLDivElement>) => {
				const origin = pointerOriginRef.current;
				if (!origin) return;
				const deltaX = event.clientX - origin.x;
				const deltaY = event.clientY - origin.y;
				if (
					Math.max(Math.abs(deltaX), Math.abs(deltaY)) < POINTER_AXIS_THRESHOLD
				) {
					return;
				}

				// Direction is known only after movement begins. Waiting here keeps a
				// vertical touch from cancelling an in-flight time destination.
				pointerOriginRef.current = null;
				const horizontalIntent = Math.abs(deltaX) > Math.abs(deltaY);
				markInputAxis(horizontalIntent ? "horizontal" : "vertical");
				if (!horizontalIntent) return;

				handleUserScrollIntent();
				if (
					!onApproachEdge ||
					(origin.pointerType !== "touch" && origin.pointerType !== "pen")
				) {
					return;
				}

				const element = event.currentTarget;
				const maxScrollLeft = Math.max(0, canvasWidth - element.clientWidth);
				if (
					deltaX > 0 &&
					element.scrollLeft <= 1 &&
					edgeLatchRef.current !== "left"
				) {
					edgeLatchRef.current = "left";
					onApproachEdge("left");
				} else if (
					deltaX < 0 &&
					element.scrollLeft >= maxScrollLeft - 1 &&
					edgeLatchRef.current !== "right"
				) {
					edgeLatchRef.current = "right";
					onApproachEdge("right");
				}
			},
			[canvasWidth, handleUserScrollIntent, markInputAxis, onApproachEdge]
		);

		const clearPointerOrigin = useCallback(() => {
			pointerOriginRef.current = null;
			const inputAxis = inputAxisRef.current;
			if (inputAxis) markInputAxis(inputAxis);
		}, [markInputAxis]);

		const focusProgram = useCallback(
			(program: EpgGridProgram) => {
				const element = scrollerRef.current;
				if (!element) return;
				setFocusedProgramKey(programKey(program));
				const rowIndex = channelIndexById.get(program.channelId);
				if (rowIndex === undefined) return;
				const rowTop = rowIndex * ROW_HEIGHT;
				const rowBottom = rowTop + ROW_HEIGHT;
				let nextTop = element.scrollTop;
				if (rowTop < element.scrollTop) nextTop = rowTop;
				else if (rowBottom > element.scrollTop + visibleAreaHeight) {
					nextTop = rowBottom - visibleAreaHeight;
				}
				if (nextTop !== element.scrollTop) {
					scrollElement(element, { top: nextTop, behavior: "auto" });
				}

				const programStart = new Date(program.start);
				const programStop = new Date(program.stop);
				const visibleRange = getVisibleRangeForPosition(element.scrollLeft);
				if (
					programStart < visibleRange.start ||
					programStop > visibleRange.end
				) {
					// Keyboard focus must materialize predictably; native smooth
					// scrolling can outlive the virtualization focus retry.
					scrollToTime(programStart, {
						behavior: "auto",
						leadMinutes: 15
					});
				}
				scheduleViewportCommit();
				afterPaint(() => {
					element
						.querySelector<HTMLElement>(
							`[data-program-id="${program.id}"][data-channel-id="${program.channelId}"]`
						)
						?.focus();
				});
			},
			[
				channelIndexById,
				getVisibleRangeForPosition,
				scheduleViewportCommit,
				scrollToTime,
				visibleAreaHeight
			]
		);

		const onProgramNavigate = useCallback(
			(program: EpgGridProgram, event: KeyboardEvent<HTMLButtonElement>) => {
				if (
					!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(
						event.key
					)
				) {
					return;
				}
				event.preventDefault();

				const currentChannelIndex = channelIndexById.get(program.channelId);
				const currentEntries =
					temporalIndexByChannel.get(program.channelId) ?? [];
				const currentIndex = currentEntries.findIndex(
					(candidate) => candidate.program.id === program.id
				);
				const currentEntry = currentEntries[currentIndex];
				let target: TemporalProgramEntry | undefined;

				if (event.key === "ArrowLeft") {
					target = currentEntries[currentIndex - 1];
				} else if (event.key === "ArrowRight") {
					target = currentEntries[currentIndex + 1];
				} else if (event.key === "Home") {
					target = nearestProgram(currentEntries, nowMs);
				} else if (currentChannelIndex !== undefined && currentEntry) {
					const adjacentIndex =
						currentChannelIndex + (event.key === "ArrowUp" ? -1 : 1);
					const adjacentChannel = data.channels[adjacentIndex];
					if (adjacentChannel) {
						const midpoint = (currentEntry.startMs + currentEntry.stopMs) / 2;
						target = nearestProgram(
							temporalIndexByChannel.get(adjacentChannel.id) ?? [],
							midpoint
						);
					}
				}

				if (target) focusProgram(target.program);
			},
			[
				channelIndexById,
				data.channels,
				focusProgram,
				nowMs,
				temporalIndexByChannel
			]
		);
		const onProgramFocus = useCallback((program: EpgGridProgram) => {
			setFocusedProgramKey(programKey(program));
		}, []);

		return (
			<div
				ref={scrollerRef}
				onScroll={onScroll}
				onWheel={onWheel}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={clearPointerOrigin}
				onPointerCancel={clearPointerOrigin}
				data-testid="guide-grid"
				data-visible-start={visibleStartIso(
					fromMs,
					navigationScrollLeft,
					pixelsPerMinute
				)}
				data-time-navigation={timeAnchorLayout ? "discrete" : "continuous"}
				role="grid"
				aria-label="Program guide"
				aria-describedby="guide-keyboard-help"
				aria-rowcount={data.channels.length + 1}
				aria-colcount={Math.ceil(totalMinutes / MOBILE_TIME_STEP_MINUTES) + 1}
				className="guide-grid-viewport guide-scrollbar relative w-full overflow-auto rounded-lg border border-border bg-background shadow-sm"
				style={{
					// Short lineups should end with their final row instead of exposing
					// unused background inside the bordered guide frame.
					height: canvasHeight,
					// Phones use explicit time controls, leaving vertical touch movement to
					// channel browsing and the surrounding page.
					touchAction: timeAnchorLayout ? "pan-y" : "pan-x pan-y",
					overflowX: timeAnchorLayout ? "hidden" : "auto",
					overflowY: "auto",
					overflowAnchor: "none",
					overscrollBehaviorX: "contain",
					overscrollBehaviorY: "auto",
					scrollbarGutter: "stable"
				}}
			>
				<span id="guide-keyboard-help" className="sr-only">
					Use the arrow keys to move between programs. Press Home to move toward
					the current time on a channel.
				</span>

				<div
					style={{
						position: "relative",
						width: canvasWidth,
						height: canvasHeight
					}}
				>
					<div
						role="row"
						aria-rowindex={1}
						aria-label="Guide timeline"
						className="sticky top-0 z-30 border-b border-border bg-surface"
						style={{ height: HEADER_HEIGHT, width: canvasWidth }}
					>
						<div
							role="columnheader"
							aria-colindex={1}
							className="sticky left-0 z-40 flex items-center border-r border-border bg-surface px-3 text-xs font-semibold text-secondary"
							style={{ width: channelWidth, height: HEADER_HEIGHT }}
						>
							Channels
						</div>
						<div
							style={{
								position: "absolute",
								left: channelWidth,
								top: 0,
								width: contentWidth,
								height: HEADER_HEIGHT
							}}
						>
							{timeAnchorLayout ? (
								<div
									role="columnheader"
									aria-colindex={timeColumnIndex(timeAnchorMs, fromMs)}
									style={{
										position: "absolute",
										left: viewport.scrollLeft,
										top: 0,
										width: Math.max(44, visibleAreaWidth),
										height: HEADER_HEIGHT
									}}
									className="flex items-center gap-1 border-l border-border bg-surface p-1 text-primary"
								>
									<button
										type="button"
										onClick={() => stepTimeAnchor(-1)}
										disabled={timeAnchorMs <= fromMs}
										aria-label="Previous 30 minutes"
										className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none"
									>
										<ChevronLeft aria-hidden="true" className="h-4 w-4" />
									</button>
									<span
										className="min-w-0 flex-1 truncate text-center text-xs font-semibold"
										aria-live="polite"
									>
										Programs at{" "}
										{formatTimeLabel(new Date(timeAnchorMs), use24Hour)}
									</span>
									<button
										type="button"
										onClick={() => stepTimeAnchor(1)}
										disabled={
											timeAnchorMs + MOBILE_TIME_STEP_MINUTES * MS_PER_MINUTE >=
											toMs
										}
										aria-label="Next 30 minutes"
										className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none"
									>
										<ChevronRight aria-hidden="true" className="h-4 w-4" />
									</button>
								</div>
							) : (
								ticks.map((tick) => (
									<div
										key={tick.left}
										role="columnheader"
										aria-colindex={
											Math.round(tick.left / (30 * pixelsPerMinute)) + 2
										}
										style={{
											position: "absolute",
											left: tick.left,
											top: 0,
											height: HEADER_HEIGHT
										}}
										className="border-l border-border pl-2 pr-3 pt-1.5 text-[11px] font-medium text-secondary"
									>
										<span className="whitespace-nowrap">{tick.label}</span>
										{tick.dayLabel ? (
											<span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
												{tick.dayLabel}
											</span>
										) : null}
									</div>
								))
							)}
							{nowVisible && !timeAnchorLayout ? (
								<span
									aria-hidden="true"
									style={{
										position: "absolute",
										left: nowLeft,
										top: 4,
										transform: "translateX(-50%)"
									}}
									data-testid="now-label"
									className="z-10 rounded bg-live px-1.5 py-0.5 text-[10px] font-semibold text-live-foreground shadow-sm"
								>
									Now
								</span>
							) : null}
						</div>
					</div>

					{visibleChannels.map((channel, index) => {
						const rowIndex = firstRow + index + 2;
						const rowCells = visibleCells.filter(
							(cell) => cell.program.channelId === channel.id
						);
						const rowGaps = visibleGaps.filter(
							(gap) => gap.channelId === channel.id
						);
						// DOM order follows broadcast time so assistive navigation matches
						// the visual schedule even when gaps and programs alternate.
						const rowItems = [
							...rowGaps.map((gap) => ({ kind: "gap" as const, gap })),
							...rowCells.map((cell) => ({ kind: "program" as const, cell }))
						].sort((left, right) => {
							const leftPosition =
								left.kind === "gap" ? left.gap.left : left.cell.left;
							const rightPosition =
								right.kind === "gap" ? right.gap.left : right.cell.left;
							return leftPosition - rightPosition;
						});
						return (
							<div
								key={channel.id}
								role="row"
								aria-rowindex={rowIndex}
								className="absolute left-0 border-b border-border"
								style={{
									top: HEADER_HEIGHT + (firstRow + index) * ROW_HEIGHT,
									width: canvasWidth,
									height: ROW_HEIGHT
								}}
							>
								<div
									role="rowheader"
									aria-colindex={1}
									className="pointer-events-none sticky left-0 z-20"
									style={{ width: channelWidth, height: ROW_HEIGHT }}
								>
									<ChannelRow
										channel={channel}
										height={ROW_HEIGHT}
										width={channelWidth}
									/>
								</div>
								{rowItems.map((item) => {
									if (item.kind === "program") {
										const { cell } = item;
										return (
											<ProgramCell
												key={`${cell.program.channelId}:${cell.program.id}`}
												program={cell.program}
												startMs={cell.startMs}
												stopMs={cell.stopMs}
												left={channelWidth + cell.left}
												width={cell.width}
												contentOffset={
													timeAnchorLayout
														? 0
														: clamp(
																viewport.scrollLeft - cell.left,
																0,
																Math.max(2, cell.width - 3)
															)
												}
												top={0}
												height={ROW_HEIGHT}
												layout={timeAnchorLayout ? "time-anchor" : "timeline"}
												tabIndex={
													programKey(cell.program) === rovingProgramKey ? 0 : -1
												}
												rowIndex={rowIndex}
												columnIndex={timeColumnIndex(cell.startMs, fromMs)}
												nowMs={nowMsQuantized}
												channelName={cell.channelName}
												nextProgramTitle={cell.nextProgramTitle}
												nextProgramStartMs={cell.nextProgramStartMs}
												use24Hour={use24Hour}
												onSelect={onSelectProgram}
												onFocus={onProgramFocus}
												onNavigate={onProgramNavigate}
											/>
										);
									}
									const { gap } = item;
									const startLabel = formatTimeLabel(
										new Date(gap.startMs),
										use24Hour
									);
									const stopLabel = formatTimeLabel(
										new Date(gap.stopMs),
										use24Hour
									);
									const gapLabel =
										gap.kind === "loading"
											? "Loading schedule data"
											: "No schedule data";
									const renderedGapWidth = Math.max(2, gap.width - 3);
									const gapContentWidth = Math.min(
										renderedGapWidth,
										MIN_VISIBLE_GAP_LABEL_WIDTH
									);
									const gapContentOffset = clamp(
										viewport.scrollLeft - gap.left,
										0,
										Math.max(0, renderedGapWidth - gapContentWidth)
									);
									return (
										<div
											key={`${gap.channelId}:${gap.kind}:${gap.startMs}:${gap.stopMs}`}
											role="gridcell"
											aria-rowindex={rowIndex}
											aria-colindex={timeColumnIndex(gap.startMs, fromMs)}
											aria-label={`${gapLabel}, ${gap.channelName}, ${startLabel} to ${stopLabel}`}
											aria-busy={gap.kind === "loading" ? "true" : undefined}
											data-testid={
												gap.kind === "loading"
													? "schedule-loading"
													: "schedule-gap"
											}
											style={{
												position: "absolute",
												left: channelWidth + gap.left,
												top: 0,
												width: renderedGapWidth,
												height: ROW_HEIGHT - 3
											}}
											className={cn(
												"rounded-md border border-border bg-surface-muted/50 text-xs text-muted",
												gap.kind === "missing" && "border-dashed"
											)}
										>
											<div
												data-testid="schedule-gap-content"
												style={{
													// Safari does not reliably keep sticky descendants of absolute
													// timeline cells visible. Move one compact label with the same
													// frame sample used by virtualization instead.
													position: "absolute",
													left: 0,
													width: gapContentWidth,
													height: "100%",
													transform: `translate3d(${gapContentOffset}px, 0, 0)`
												}}
												className="flex items-center overflow-hidden px-3"
											>
												<div className="min-w-0">
													<span className="block truncate">{gapLabel}</span>
													{timeAnchorLayout &&
													gap.nextProgramTitle &&
													gap.nextProgramStartMs ? (
														<span className="block truncate text-[10px] text-secondary">
															{`Next · ${gap.nextProgramTitle} · ${formatTimeLabel(new Date(gap.nextProgramStartMs), use24Hour)}`}
														</span>
													) : null}
												</div>
											</div>
										</div>
									);
								})}
							</div>
						);
					})}

					<div
						className="pointer-events-none"
						style={{
							position: "absolute",
							left: channelWidth,
							top: HEADER_HEIGHT,
							width: contentWidth,
							height: contentHeight
						}}
					>
						{nowVisible && !timeAnchorLayout ? (
							<div
								data-testid="now-indicator"
								aria-hidden="true"
								style={{
									position: "absolute",
									left: nowLeft,
									top: 0,
									width: 2,
									height: contentHeight
								}}
								className="pointer-events-none z-10 bg-live shadow-[0_0_0_1px_rgb(var(--color-surface)/0.55)]"
							>
								<span className="absolute -left-[3px] -top-1 h-2 w-2 rounded-full bg-live" />
							</div>
						) : null}
					</div>
				</div>
			</div>
		);
	}
);

GuideGridImpl.displayName = "GuideGrid";
export const GuideGrid = memo(GuideGridImpl);

/** Use denser geometry on phones so the schedule remains the primary surface. */
function getGridGeometry(width: number): GridGeometry {
	if (width < MOBILE_BREAKPOINT) {
		return {
			channelWidth: MOBILE_CHANNEL_COL_WIDTH,
			pixelsPerMinute: MOBILE_PIXELS_PER_MINUTE
		};
	}
	return {
		channelWidth: CHANNEL_COL_WIDTH,
		pixelsPerMinute: PIXELS_PER_MINUTE
	};
}

function sameViewport(left: Viewport, right: Viewport): boolean {
	return (
		left.width === right.width &&
		left.height === right.height &&
		left.scrollLeft === right.scrollLeft &&
		left.scrollTop === right.scrollTop
	);
}

/** Stable compound identity keeps shared EPG programs distinct by tuner row. */
function programKey(program: EpgGridProgram): string {
	return `${program.channelId}:${program.id}`;
}

/** Separate unfetched canvas space from confirmed provider schedule gaps. */
function buildScheduleGaps(
	entries: TemporalProgramEntry[],
	fromMs: number,
	toMs: number,
	loadedFromMs: number,
	loadedToMs: number
): TemporalGap[] {
	if (loadedFromMs >= loadedToMs) {
		return [{ startMs: fromMs, stopMs: toMs, kind: "loading" }];
	}
	const gaps: TemporalGap[] = [];
	if (fromMs < loadedFromMs) {
		gaps.push({ startMs: fromMs, stopMs: loadedFromMs, kind: "loading" });
	}
	gaps.push(
		...findScheduleGaps(entries, loadedFromMs, loadedToMs).map((gap) => ({
			...gap,
			kind: "missing" as const
		}))
	);
	if (loadedToMs < toMs) {
		gaps.push({ startMs: loadedToMs, stopMs: toMs, kind: "loading" });
	}
	return gaps;
}

/** Return every confirmed uncovered interval inside loaded provider data. */
function findScheduleGaps(
	entries: TemporalProgramEntry[],
	fromMs: number,
	toMs: number
): Array<Omit<TemporalGap, "kind">> {
	const gaps: Array<Omit<TemporalGap, "kind">> = [];
	let cursor = fromMs;
	for (const entry of entries) {
		const startMs = clamp(entry.startMs, fromMs, toMs);
		const stopMs = clamp(entry.visualStopMs, fromMs, toMs);
		if (startMs > cursor) gaps.push({ startMs: cursor, stopMs: startMs });
		cursor = Math.max(cursor, stopMs);
		if (cursor >= toMs) break;
	}
	if (cursor < toMs) gaps.push({ startMs: cursor, stopMs: toMs });
	return gaps;
}

/** Find the first half-open program interval that can intersect the viewport. */
function firstIntersectingProgram(
	entries: TemporalProgramEntry[],
	visibleStartMs: number
): number {
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const midpoint = low + Math.floor((high - low) / 2);
		if (entries[midpoint]!.visualStopMs <= visibleStartMs) {
			low = midpoint + 1;
		} else {
			high = midpoint;
		}
	}
	return low;
}

/** Find the indexed program nearest a keyboard-navigation timestamp. */
function nearestProgram(
	entries: TemporalProgramEntry[],
	targetMs: number
): TemporalProgramEntry | undefined {
	let nearest: TemporalProgramEntry | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const entry of entries) {
		if (entry.startMs <= targetMs && entry.stopMs > targetMs) return entry;
		const distance = Math.min(
			Math.abs(entry.startMs - targetMs),
			Math.abs(entry.stopMs - targetMs)
		);
		if (distance < nearestDistance) {
			nearest = entry;
			nearestDistance = distance;
		}
	}
	return nearest;
}

function resolvedScrollBehavior(requested: ScrollBehavior): ScrollBehavior {
	if (requested === "auto" || typeof window === "undefined") return "auto";
	const animationsDisabled =
		document.documentElement.dataset["animations"] === "off";
	const reducedMotion =
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	return animationsDisabled || reducedMotion ? "auto" : requested;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/** Quantize the mobile list to the schedule's shared half-hour columns. */
function snapTimeToStep(targetMs: number, fromMs: number): number {
	const stepMs = MOBILE_TIME_STEP_MINUTES * MS_PER_MINUTE;
	return fromMs + Math.floor((targetMs - fromMs) / stepMs) * stepMs;
}

/** Map a real timestamp to the grid's shared temporal column coordinate. */
function timeColumnIndex(timestampMs: number, fromMs: number): number {
	const stepMs = MOBILE_TIME_STEP_MINUTES * MS_PER_MINUTE;
	return Math.max(2, Math.floor((timestampMs - fromMs) / stepMs) + 2);
}

/** Serialize a horizontal grid coordinate for diagnostics and browser tests. */
function visibleStartIso(
	fromMs: number,
	scrollLeft: number,
	pixelsPerMinute: number
): string {
	return new Date(
		fromMs + (scrollLeft / pixelsPerMinute) * MS_PER_MINUTE
	).toISOString();
}

function requestFrame(callback: FrameRequestCallback): number {
	if (typeof window.requestAnimationFrame === "function") {
		return window.requestAnimationFrame(callback);
	}
	return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelFrame(handle: number): void {
	if (typeof window.cancelAnimationFrame === "function") {
		window.cancelAnimationFrame(handle);
	} else {
		window.clearTimeout(handle);
	}
}

function afterPaint(callback: () => void): void {
	requestFrame(() => requestFrame(callback));
}

/** jsdom lacks scrollTo; the assignment fallback also keeps unit seams simple. */
function scrollElement(
	element: HTMLDivElement,
	options: ScrollToOptions
): void {
	if (typeof element.scrollTo === "function") {
		element.scrollTo(options);
		return;
	}
	if (options.left !== undefined) element.scrollLeft = options.left;
	if (options.top !== undefined) element.scrollTop = options.top;
}
