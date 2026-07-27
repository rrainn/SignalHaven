import { describe, expect, it } from "vitest";

import {
	addLocalDays,
	addMinutes,
	formatTimeLabel,
	isSameLocalDay,
	startOfDay,
	startOfHour,
	startOfNextDay,
	timeOnLocalDay
} from "../../app/_guide/time";

describe("guide/time helpers", () => {
	it("startOfHour zeroes minutes/seconds/ms without mutating the input", () => {
		const input = new Date("2026-01-15T13:42:33.500Z");
		const before = input.toISOString();
		const out = startOfHour(input);
		expect(input.toISOString()).toBe(before);
		expect(out.getMinutes()).toBe(0);
		expect(out.getSeconds()).toBe(0);
		expect(out.getMilliseconds()).toBe(0);
	});

	it("addMinutes adds and subtracts, returning a new instance", () => {
		const input = new Date("2026-01-15T13:00:00Z");
		expect(addMinutes(input, 30).getTime() - input.getTime()).toBe(30 * 60_000);
		expect(addMinutes(input, -90).getTime() - input.getTime()).toBe(-5_400_000);
	});

	it("startOfDay & startOfNextDay align to local midnight", () => {
		const input = new Date(2026, 0, 15, 13, 42);
		const sod = startOfDay(input);
		expect(sod.getHours()).toBe(0);
		expect(sod.getDate()).toBe(15);
		const next = startOfNextDay(input);
		expect(next.getHours()).toBe(0);
		expect(next.getDate()).toBe(16);
	});

	it("copies an explicit time onto the selected local day", () => {
		const selectedDay = new Date(2026, 0, 18, 2, 15);
		const visibleTime = new Date(2026, 0, 15, 19, 30);

		const copied = timeOnLocalDay(selectedDay, visibleTime);
		expect(copied.getDate()).toBe(18);
		expect(copied.getHours()).toBe(19);
		expect(copied.getMinutes()).toBe(30);
		expect(isSameLocalDay(copied, selectedDay)).toBe(true);
	});

	it("uses calendar-day arithmetic for the upcoming date rail", () => {
		const today = new Date(2026, 2, 7, 12, 0);
		const tomorrow = addLocalDays(today, 1);
		expect(tomorrow.getDate()).toBe(8);
		expect(tomorrow.getHours()).toBe(12);
	});

	it("formatTimeLabel respects the 24-hour preference", () => {
		const d = new Date(2026, 0, 15, 13, 5);
		expect(formatTimeLabel(d, true)).toMatch(/13[:.]05/);
		// 12-hour formatting locale-dependent; just verify minutes show.
		expect(formatTimeLabel(d, false)).toMatch(/05/);
	});
});
