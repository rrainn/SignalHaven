"use client";

import { memo, type KeyboardEvent } from "react";
import type { EpgGridProgram } from "@signalhaven/shared";
import {
	AlertCircle,
	CheckCircle2,
	CircleDot,
	Disc3,
	XCircle
} from "lucide-react";

import { cn } from "../_ui/cn";
import { formatDateLabel, formatTimeLabel, isSameLocalDay } from "./time";

const MIN_VISIBLE_CONTENT_WIDTH = 44;

export interface ProgramCellProps {
	program: EpgGridProgram;
	/** Parsed provider bounds shared with the grid's temporal index. */
	startMs: number;
	stopMs: number;
	/** Pixel offset from the start of the time row. */
	left: number;
	/** Pixel width of the cell. */
	width: number;
	/** Pixel distance the cell's content follows the visible guide position. */
	contentOffset: number;
	/** Pixel offset from the top of the channel column (zero for sticky rows). */
	top: number;
	height: number;
	/** Responsive presentation used for title visibility and diagnostics. */
	layout: "timeline" | "time-anchor";
	/** Roving position keeps the schedule to one program tab stop. */
	tabIndex: 0 | -1;
	rowIndex: number;
	columnIndex: number;
	/**
	 * Wall-clock "now" in ms. When the program is currently airing we
	 * render a progress bar overlay; the parent passes a coarse value
	 * (rounded to 30s) so memoization survives sub-second ticks.
	 */
	nowMs: number;
	channelName: string;
	/** Compact adjacency cue used by the discrete mobile time view. */
	nextProgramTitle?: string | undefined;
	nextProgramStartMs?: number | undefined;
	use24Hour?: boolean;
	onSelect: (program: EpgGridProgram) => void;
	onFocus: (program: EpgGridProgram) => void;
	onNavigate: (
		program: EpgGridProgram,
		event: KeyboardEvent<HTMLButtonElement>
	) => void;
}

/**
 * Single program grid cell with a native button nested inside its semantic
 * coordinate. Keeping both roles prevents assistive technology from losing
 * the activation behavior while still exposing the schedule as a grid.
 */
function ProgramCellInner(props: ProgramCellProps) {
	const {
		program,
		startMs,
		stopMs,
		left,
		width,
		contentOffset,
		top,
		height,
		layout,
		tabIndex,
		rowIndex,
		columnIndex,
		nowMs,
		channelName,
		nextProgramTitle,
		nextProgramStartMs,
		use24Hour = false,
		onSelect,
		onFocus,
		onNavigate
	} = props;
	const durationMs = Math.max(1, stopMs - startMs);
	const isAiring = nowMs >= startMs && nowMs < stopMs;
	const progress = isAiring
		? Math.min(100, Math.max(0, ((nowMs - startMs) / durationMs) * 100))
		: 0;

	const statusLabel = program.recordingStatus
		? {
				scheduled: "Scheduled to record",
				recording: "Recording now",
				completed: "Recording completed",
				failed: "Recording failed",
				cancelled: "Recording cancelled"
			}[program.recordingStatus]
		: null;
	const startLabel = formatTimeLabel(new Date(startMs), use24Hour);
	const stopLabel = formatTimeLabel(new Date(stopMs), use24Hour);
	const start = new Date(startMs);
	const stop = new Date(stopMs);
	const accessibleStop = isSameLocalDay(start, stop)
		? stopLabel
		: `${formatDateLabel(stop)}, ${stopLabel}`;
	const accessibleLabel = [
		program.title,
		channelName,
		`${formatDateLabel(start)}, ${startLabel} to ${accessibleStop}`,
		isAiring ? "Live now" : null,
		statusLabel
	]
		.filter(Boolean)
		.join(", ");
	const renderedWidth = Math.max(2, width - 3);
	const minimumContentWidth = Math.min(
		MIN_VISIBLE_CONTENT_WIDTH,
		renderedWidth
	);
	const constrainedContentOffset = Math.min(
		renderedWidth - minimumContentWidth,
		Math.max(0, contentOffset)
	);
	const visibleContentWidth = renderedWidth - constrainedContentOffset;

	return (
		<div
			role="gridcell"
			aria-rowindex={rowIndex}
			aria-colindex={columnIndex}
			style={{
				position: "absolute",
				left,
				top,
				width: renderedWidth,
				height: height - 3
			}}
			className="hover:z-10 focus-within:z-20"
		>
			<button
				type="button"
				onClick={() => onSelect(program)}
				onFocus={() => onFocus(program)}
				onKeyDown={(event) => onNavigate(program, event)}
				aria-label={accessibleLabel}
				aria-current={isAiring ? "time" : undefined}
				tabIndex={tabIndex}
				data-testid="program-cell"
				data-layout={layout}
				data-program-id={program.id}
				data-channel-id={program.channelId}
				data-airing={isAiring ? "true" : "false"}
				className={cn(
					"group relative h-full w-full overflow-hidden rounded-md border border-border bg-surface text-left text-xs text-primary",
					"transition-colors motion-reduce:transition-none hover:border-accent hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
					isAiring && "border-live/80 bg-live/10"
				)}
			>
				<div
					data-testid="program-content"
					style={{
						// A compositor transform avoids relayout while the title follows the
						// exposed part of a long program during Safari momentum scrolling.
						position: "absolute",
						left: 0,
						width: visibleContentWidth,
						transform: `translate3d(${constrainedContentOffset}px, 0, 0)`
					}}
					className="inset-y-0 flex min-w-0 flex-col items-start justify-center gap-0.5 px-2.5 py-1.5"
				>
					<div className="flex w-full min-w-0 items-center gap-1">
						<span
							className={cn(
								"truncate font-semibold leading-tight",
								layout === "timeline" && renderedWidth < 44 && "sr-only"
							)}
						>
							{program.title}
						</span>
						{statusLabel ? (
							<span aria-label={statusLabel} className="ml-auto shrink-0">
								{program.recordingStatus === "recording" ? (
									<Disc3
										aria-hidden="true"
										className="h-3 w-3 animate-pulse text-danger motion-reduce:animate-none"
									/>
								) : program.recordingStatus === "scheduled" ? (
									<CircleDot
										aria-hidden="true"
										className="h-3 w-3 text-secondary"
									/>
								) : program.recordingStatus === "completed" ? (
									<CheckCircle2
										aria-hidden="true"
										className="h-3 w-3 text-success"
									/>
								) : program.recordingStatus === "failed" ? (
									<AlertCircle
										aria-hidden="true"
										className="h-3 w-3 text-danger"
									/>
								) : (
									<XCircle aria-hidden="true" className="h-3 w-3 text-muted" />
								)}
							</span>
						) : null}
					</div>
					{program.subtitle &&
					visibleContentWidth >= 112 &&
					layout === "timeline" ? (
						<span className="truncate text-[11px] text-secondary">
							{program.subtitle}
						</span>
					) : null}
					{visibleContentWidth >= 104 ? (
						<span className="truncate text-[10px] leading-tight text-muted">
							{startLabel}–{stopLabel}
						</span>
					) : null}
					{layout === "time-anchor" &&
					nextProgramTitle &&
					nextProgramStartMs ? (
						<span className="w-full truncate text-[10px] leading-tight text-secondary">
							{`Next · ${nextProgramTitle} · ${formatTimeLabel(new Date(nextProgramStartMs), use24Hour)}`}
						</span>
					) : null}
				</div>
				{isAiring ? (
					<span
						aria-hidden="true"
						data-testid="program-progress"
						className="absolute bottom-0 left-0 h-[3px] rounded-r-full bg-live"
						style={{ width: `${progress}%` }}
					/>
				) : null}
			</button>
		</div>
	);
}

/**
 * Memo equality keeps unrelated viewport and recording updates from
 * rerendering every visible program.
 */
export const ProgramCell = memo(ProgramCellInner, (a, b) => {
	if (a.program !== b.program) return false;
	if (a.startMs !== b.startMs || a.stopMs !== b.stopMs) return false;
	if (a.left !== b.left || a.width !== b.width) return false;
	if (a.contentOffset !== b.contentOffset) return false;
	if (a.top !== b.top || a.height !== b.height) return false;
	if (a.layout !== b.layout || a.tabIndex !== b.tabIndex) return false;
	if (a.rowIndex !== b.rowIndex || a.columnIndex !== b.columnIndex)
		return false;
	if (a.channelName !== b.channelName || a.use24Hour !== b.use24Hour)
		return false;
	if (
		a.nextProgramTitle !== b.nextProgramTitle ||
		a.nextProgramStartMs !== b.nextProgramStartMs
	)
		return false;
	if (a.onSelect !== b.onSelect) return false;
	if (a.onFocus !== b.onFocus) return false;
	if (a.onNavigate !== b.onNavigate) return false;
	// Only invalidate on `nowMs` change when progress is actually visible.
	const aAir = a.nowMs >= a.startMs && a.nowMs < a.stopMs;
	const bAir = b.nowMs >= a.startMs && b.nowMs < a.stopMs;
	if (aAir !== bAir) return false;
	if (aAir) return a.nowMs === b.nowMs;
	return true;
});
