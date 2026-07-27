"use client";

import { ChevronLeft, ChevronRight, Clock3 } from "lucide-react";

import { Button } from "../_ui/Button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "../_ui/Select";
import { Spinner } from "../_ui/Spinner";
import { cn } from "../_ui/cn";
import {
	addLocalDays,
	formatDateLabel,
	formatShortDateLabel,
	formatTimeLabel,
	isSameLocalDay,
	startOfDay
} from "./time";

export interface GuideToolbarProps {
	/** Date explicitly selected through guide navigation. */
	selectedDay: Date;
	/** Settled lower bound currently visible in the grid. */
	visibleStart: Date;
	/** Settled upper bound currently visible in the grid. */
	visibleEnd: Date;
	/** Wall-clock now used to build the upcoming-day rail. */
	now: Date;
	/** When true, format times in 24-hour format. */
	use24Hour?: boolean;
	/** Whether a replacement or expanded guide range is loading. */
	updating?: boolean;
	onStep: (minutes: number) => void;
	onJumpToNow: () => void;
	onSelectDay: (day: Date) => void;
	onJumpToHour: (hour: number) => void;
}

const GUIDE_DAY_COUNT = 7;
const TIME_PRESETS = [
	{ hour: 6, label: "Morning" },
	{ hour: 12, label: "Afternoon" },
	{ hour: 19, label: "Evening" },
	{ hour: 22, label: "Late night" }
] as const;

/**
 * Stable guide navigation built around the visible viewport instead of the
 * backend request origin.
 */
export function GuideToolbar(props: GuideToolbarProps) {
	const {
		selectedDay,
		visibleStart,
		visibleEnd,
		now,
		use24Hour = false,
		updating = false,
		onStep,
		onJumpToNow,
		onSelectDay,
		onJumpToHour
	} = props;
	const today = startOfDay(now);
	const selectedDate = startOfDay(selectedDay);
	const railStart =
		selectedDate.getTime() < today.getTime() ? selectedDate : today;
	const tomorrow = addLocalDays(today, 1);
	const yesterday = addLocalDays(today, -1);
	const days = Array.from({ length: GUIDE_DAY_COUNT }, (_, index) =>
		addLocalDays(railStart, index)
	);

	return (
		<nav
			className="space-y-3"
			aria-label="Guide navigation"
			data-guide-navigation
		>
			<div className="relative">
				<div
					className="guide-date-rail -mx-1 flex snap-x gap-1 overflow-x-auto px-1 pb-1 pr-8 sm:pr-1"
					role="group"
					aria-label="Choose a guide date"
				>
					{days.map((day) => {
						const active = isSameLocalDay(day, selectedDay);
						const relativeLabel = isSameLocalDay(day, today)
							? "Today"
							: isSameLocalDay(day, tomorrow)
								? "Tomorrow"
								: isSameLocalDay(day, yesterday)
									? "Yesterday"
									: null;
						const dateLabel = formatDateLabel(day);
						const weekday = day.toLocaleDateString(undefined, {
							weekday: "short"
						});

						return (
							<button
								key={day.toISOString()}
								type="button"
								aria-label={
									relativeLabel ? `${relativeLabel}, ${dateLabel}` : dateLabel
								}
								aria-pressed={active}
								onClick={() => onSelectDay(day)}
								className={cn(
									"flex h-14 min-w-[5.25rem] snap-start flex-col items-center justify-center rounded-md border px-3 text-xs transition-colors motion-reduce:transition-none",
									"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
									active
										? "border-accent bg-accent text-accent-foreground"
										: "border-border bg-surface text-secondary hover:bg-surface-muted hover:text-primary"
								)}
							>
								<span className="font-semibold">
									{relativeLabel ?? weekday}
								</span>
								<span
									className={cn(
										"mt-0.5 text-[11px]",
										active ? "text-accent-foreground" : "text-muted"
									)}
								>
									{formatShortDateLabel(day)}
								</span>
							</button>
						);
					})}
				</div>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent sm:hidden"
				/>
			</div>

			<div className="flex flex-col gap-3 lg:flex-row lg:items-center">
				<div
					className="grid grid-cols-[1fr_auto_1fr] gap-2 sm:flex"
					role="group"
					aria-label="Move through guide time"
				>
					<Button
						size="md"
						variant="outline"
						aria-label="Back 30m — show 30 minutes earlier"
						onClick={() => onStep(-30)}
						className="h-11 px-3 sm:min-w-28"
					>
						<ChevronLeft aria-hidden="true" className="h-4 w-4" />
						Earlier
					</Button>
					<Button
						size="md"
						aria-label="Now"
						onClick={onJumpToNow}
						className="h-11 min-w-24 px-4"
					>
						<Clock3 aria-hidden="true" className="h-4 w-4" />
						Now
					</Button>
					<Button
						size="md"
						variant="outline"
						aria-label="Forward 30m — show 30 minutes later"
						onClick={() => onStep(30)}
						className="h-11 px-3 sm:min-w-28"
					>
						Later
						<ChevronRight aria-hidden="true" className="h-4 w-4" />
					</Button>
				</div>

				<div className="flex flex-col gap-3 sm:flex-row sm:items-center lg:ml-auto">
					<Select
						value=""
						onValueChange={(value) => onJumpToHour(Number(value))}
					>
						<SelectTrigger
							aria-label="Jump to time"
							className="h-11 min-w-44 gap-2 sm:w-auto"
						>
							<Clock3 aria-hidden="true" className="h-4 w-4 text-muted" />
							<SelectValue placeholder="Jump to time" />
						</SelectTrigger>
						<SelectContent align="end">
							{TIME_PRESETS.map((preset) => {
								const time = new Date(2026, 0, 1, preset.hour);
								return (
									<SelectItem key={preset.hour} value={String(preset.hour)}>
										{preset.label} · {formatTimeLabel(time, use24Hour)}
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>

					<div className="min-w-0 sm:text-right">
						<div className="flex items-center gap-2 sm:justify-end">
							<span
								data-testid="guide-window-label"
								aria-live="polite"
								className="truncate text-sm font-semibold text-primary"
							>
								{formatVisibleRange(visibleStart, visibleEnd, use24Hour)}
							</span>
							{updating ? (
								<Spinner
									size="sm"
									label="Updating guide"
									className="shrink-0"
								/>
							) : null}
						</div>
						<p className="mt-0.5 text-xs text-muted">
							{/* Mobile uses deterministic steps instead of a hidden horizontal scroller. */}
							<span className="sm:hidden">Use the time controls to browse</span>
							<span className="hidden sm:inline">
								Scroll the grid or use the controls to browse
							</span>
						</p>
					</div>
				</div>
			</div>
		</nav>
	);
}

/** Keep cross-midnight ranges unambiguous without repeating the same date. */
function formatVisibleRange(
	start: Date,
	end: Date,
	use24Hour: boolean
): string {
	const startTime = formatTimeLabel(start, use24Hour);
	const endTime = formatTimeLabel(end, use24Hour);
	if (isSameLocalDay(start, end)) {
		return `${formatDateLabel(start)} · ${startTime} – ${endTime}`;
	}
	return `${formatDateLabel(start)} · ${startTime} – ${formatDateLabel(end)} · ${endTime}`;
}
