import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GuidePage } from "../../app/_guide/GuidePage";
import { buildGuideFixture } from "../../app/_guide/fixtures";
import { startOfDay, startOfHour } from "../../app/_guide/time";

const guideHook = vi.hoisted(() => ({
	data: null as ReturnType<typeof buildGuideFixture> | null,
	requestedStart: null as Date | null
}));

vi.mock("../../app/_guide/useGuideData", () => ({
	useGuideData: (options: { windowStart: Date }) => {
		guideHook.requestedStart = options.windowStart;
		return {
			state: {
				status: "loading" as const,
				data: guideHook.data,
				error: null,
				loadedFrom: guideHook.data ? Date.parse(guideHook.data.from) : null,
				loadedTo: guideHook.data ? Date.parse(guideHook.data.to) : null
			},
			refresh: vi.fn(),
			updateProgramRecording: vi.fn()
		};
	}
}));

describe("Guide navigation ordering", () => {
	beforeEach(() => {
		guideHook.data = null;
		guideHook.requestedStart = null;
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get: () => 800
		});
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			configurable: true,
			get: () => 600
		});
	});

	it("lets Now supersede an in-flight request for another day", async () => {
		const now = new Date(2026, 5, 1, 12, 15);
		guideHook.data = buildGuideFixture({
			channelCount: 4,
			windowHours: 4,
			from: startOfHour(now),
			seed: 30
		});

		render(
			<GuidePage nowOverride={now} liveUpdates={false} epgHoursVisible={4} />
		);

		fireEvent.click(screen.getByRole("button", { name: /^tomorrow,/i }));
		await waitFor(() =>
			expect(startOfDay(guideHook.requestedStart!)).not.toEqual(startOfDay(now))
		);

		fireEvent.click(screen.getByRole("button", { name: /^now$/i }));

		// The newest action must also own the requested range, otherwise a delayed
		// Tomorrow response can move the user away again after Now appears to work.
		await waitFor(() =>
			expect(startOfDay(guideHook.requestedStart!)).toEqual(startOfDay(now))
		);
	});
});
