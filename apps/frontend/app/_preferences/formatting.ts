// Schedule cells format many times while scrolling. Reusing the two immutable
// formatters avoids allocating Intl machinery in the guide's animation path.
const TIME_FORMATTERS = {
	twelveHour: new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		hour12: true
	}),
	twentyFourHour: new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	})
} as const;

/** Formats a schedule time according to the saved clock preference. */
export function formatTimePreference(date: Date, use24Hour: boolean): string {
	if (Number.isNaN(date.getTime())) return "";
	return (
		use24Hour ? TIME_FORMATTERS.twentyFourHour : TIME_FORMATTERS.twelveHour
	).format(date);
}

/** Formats recording/scheduler metadata with a consistent date and clock. */
export function formatDateTimePreference(
	value: Date | string,
	use24Hour: boolean
): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime()))
		return typeof value === "string" ? value : "";
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: use24Hour ? "2-digit" : "numeric",
		minute: "2-digit",
		hour12: !use24Hour
	}).format(date);
}

/** Search results include a weekday because they may be several days away. */
export function formatUpcomingDateTimePreference(
	value: Date | string,
	use24Hour: boolean
): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime()))
		return typeof value === "string" ? value : "";
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: use24Hour ? "2-digit" : "numeric",
		minute: "2-digit",
		hour12: !use24Hour
	}).format(date);
}
