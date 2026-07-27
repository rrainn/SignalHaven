import { formatTimePreference } from "../_preferences/formatting";

/**
 * Pure time helpers powering the guide's time-navigation toolbar.
 *
 * Lives in its own module — no React, no DOM — so it can be unit-tested
 * in isolation and re-used by both the grid renderer and the toolbar.
 *
 * Calendar boundaries are computed in local time so "today" and "tomorrow"
 * follow the device timezone rather than UTC.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Round a date down to the start of its hour. Used to align the guide
 * window with the time-axis tick marks for a clean visual grid.
 */
export function startOfHour(date: Date): Date {
	const next = new Date(date);
	next.setMinutes(0, 0, 0);
	return next;
}

/** Local-midnight of `date`. */
export function startOfDay(date: Date): Date {
	const next = new Date(date);
	next.setHours(0, 0, 0, 0);
	return next;
}

/** Local-midnight of the day after `date`. */
export function startOfNextDay(date: Date): Date {
	const next = startOfDay(date);
	next.setDate(next.getDate() + 1);
	return next;
}

/** Add (or subtract) `minutes` from `date` without mutating it. */
export function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

/**
 * Add calendar days in local time. Calendar arithmetic keeps date navigation
 * aligned to local midnight across daylight-saving transitions.
 */
export function addLocalDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

/** Whether two instants fall on the same local calendar day. */
export function isSameLocalDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

/**
 * Copy a local time of day onto another date without mutating either input.
 *
 * Local setters intentionally let the runtime resolve DST gaps and repeated
 * hours using the user's configured timezone.
 */
export function timeOnLocalDay(
	day: Date,
	time: Date | { hours: number; minutes?: number }
): Date {
	const next = startOfDay(day);
	const hours = time instanceof Date ? time.getHours() : time.hours;
	const minutes =
		time instanceof Date ? time.getMinutes() : (time.minutes ?? 0);
	next.setHours(hours, minutes, 0, 0);
	return next;
}

/**
 * Format a Date for the time axis. We accept a 24-hour preference flag so
 * the same renderer can serve users with `use24HourClock` toggled.
 */
export function formatTimeLabel(date: Date, use24Hour: boolean): string {
	return formatTimePreference(date, use24Hour);
}

/** Short, sortable date label like `Mon, Apr 25`. */
export function formatDateLabel(date: Date): string {
	return date.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric"
	});
}

/** Compact month/day label used below each date-rail weekday. */
export function formatShortDateLabel(date: Date): string {
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric"
	});
}
