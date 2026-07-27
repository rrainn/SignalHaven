import {
	act,
	fireEvent,
	render,
	screen,
	waitFor
} from "@testing-library/react";
import { createRef } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
	GuideGrid,
	type GuideGridHandle,
	PIXELS_PER_MINUTE,
	ROW_HEIGHT
} from "../../app/_guide/GuideGrid";
import { GuidePage } from "../../app/_guide/GuidePage";
import { buildGuideFixture } from "../../app/_guide/fixtures";
import { MS_PER_HOUR, startOfDay, startOfHour } from "../../app/_guide/time";

/**
 * Gives the guide a realistic viewport because jsdom does not perform layout.
 */
function stubViewport(width: number, height: number): void {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return width;
		}
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get() {
			return height;
		}
	});
}

/** Maps a wall-clock instant onto the GuidePage's calendar-anchored canvas. */
function scrollLeftForTime(time: Date, canvasDay: Date): number {
	return (
		((time.getTime() - startOfDay(canvasDay).getTime()) / 60_000) *
		PIXELS_PER_MINUTE
	);
}

/**
 * Mirrors browser scroll commands into jsdom's observable scroll position.
 *
 * Supporting both absolute and relative commands keeps these behavior tests
 * independent of which browser API the guide uses to reach a destination.
 */
function installScrollHarness(scroller: HTMLDivElement): void {
	const applyScroll = (
		optionsOrLeft: ScrollToOptions | number,
		top: number | undefined,
		relative: boolean
	) => {
		const options =
			typeof optionsOrLeft === "number"
				? { left: optionsOrLeft, top }
				: optionsOrLeft;
		if (options.left !== undefined) {
			scroller.scrollLeft = relative
				? scroller.scrollLeft + options.left
				: options.left;
		}
		if (options.top !== undefined) {
			scroller.scrollTop = relative
				? scroller.scrollTop + options.top
				: options.top;
		}
	};

	Object.defineProperties(scroller, {
		scrollTo: {
			configurable: true,
			value: vi.fn((optionsOrLeft: ScrollToOptions | number, top?: number) =>
				applyScroll(optionsOrLeft, top, false)
			)
		},
		scrollBy: {
			configurable: true,
			value: vi.fn((optionsOrLeft: ScrollToOptions | number, top?: number) =>
				applyScroll(optionsOrLeft, top, true)
			)
		}
	});
}

/**
 * Models native smooth scrolling, where `scrollTo` returns before the element
 * reaches its destination. Repeated controls must accumulate from the pending
 * destination rather than the partially animated DOM position.
 */
function installDeferredScrollHarness(scroller: HTMLDivElement): number[] {
	const destinations: number[] = [];
	Object.defineProperty(scroller, "scrollTo", {
		configurable: true,
		value: vi.fn((options: ScrollToOptions) => {
			if (options.left !== undefined) destinations.push(options.left);
		})
	});
	return destinations;
}

/** jsdom lacks PointerEvent, so enrich a mouse event with pointer identity. */
function pointerEvent(
	type: "pointerdown" | "pointermove",
	clientX: number,
	clientY: number,
	pointerType: "mouse" | "touch"
): MouseEvent {
	const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
	Object.defineProperty(event, "pointerType", { value: pointerType });
	return event;
}

describe("Guide time navigation", () => {
	it("uses the server clock seed for a hydration-stable calendar canvas", async () => {
		stubViewport(1280, 600);
		const initialNow = new Date(2026, 6, 25, 11, 15);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 24,
			from: startOfDay(new Date(2026, 6, 26, 0, 0)),
			seed: 38
		});

		render(
			<GuidePage
				initialData={fixture}
				initialNow={initialNow}
				liveUpdates={false}
			/>
		);

		// SSR and hydration must share pixel zero even if the browser clock advances
		// or retained fixture data begins on a different local day.
		await waitFor(() =>
			expect(screen.getByTestId("guide-grid")).toHaveAttribute(
				"data-visible-start",
				startOfDay(initialNow).toISOString()
			)
		);
	});

	it("does not publish measured viewport state before hydration completes", async () => {
		stubViewport(1280, 600);
		const initialNow = new Date(2026, 6, 25, 11, 15);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 24,
			from: startOfDay(initialNow),
			seed: 40
		});
		const view = (
			<GuidePage
				initialData={fixture}
				initialNow={initialNow}
				liveUpdates={false}
				epgHoursVisible={4}
			/>
		);
		const container = document.createElement("div");
		container.innerHTML = renderToString(view);
		document.body.append(container);
		const errors: unknown[][] = [];
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation((...args: unknown[]) => errors.push(args));
		let root: Root | null = null;

		try {
			await act(async () => {
				root = hydrateRoot(container, view);
				await Promise.resolve();
			});

			expect(
				errors.some((args) => String(args[0]).includes("Hydration failed"))
			).toBe(false);
		} finally {
			await act(async () => root?.unmount());
			consoleError.mockRestore();
			container.remove();
		}
	});

	it("keeps pixel zero anchored to the selected day while data buffers change", async () => {
		stubViewport(1280, 600);
		const now = new Date(2026, 5, 1, 12, 15);
		const dayStart = startOfDay(now);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 24,
			from: dayStart,
			seed: 37
		});

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				epgHoursVisible={4}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 0;
		fireEvent.scroll(scroller);

		// Fetching and trimming schedule slices must never redefine the native
		// scroll coordinate; midnight remains the date rail's stable origin.
		await waitFor(() =>
			expect(scroller).toHaveAttribute(
				"data-visible-start",
				dayStart.toISOString()
			)
		);
	});

	it("coalesces a burst of native scroll events into one visual-frame commit", async () => {
		stubViewport(900, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 12,
			from: startOfHour(now),
			seed: 39
		});

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);
		const callbacks: FrameRequestCallback[] = [];
		const animationFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				callbacks.push(callback);
				return callbacks.length;
			});
		const scroller = screen.getByTestId("guide-grid");

		try {
			for (const scrollLeft of [120, 240, 360]) {
				scroller.scrollLeft = scrollLeft;
				fireEvent.scroll(scroller);
			}

			expect(animationFrame).toHaveBeenCalledTimes(1);
			act(() => callbacks[0]!(performance.now()));
			await waitFor(() =>
				expect(scroller).toHaveAttribute(
					"data-visible-start",
					new Date(startOfHour(now).getTime() + 90 * 60_000).toISOString()
				)
			);
		} finally {
			animationFrame.mockRestore();
		}
	});

	it("does not request an earlier time range for vertical-only scrolling at the left boundary", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 30,
			windowHours: 12,
			from: startOfHour(now),
			seed: 21
		});
		const onApproachEdge = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onApproachEdge={onApproachEdge}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 0;
		scroller.scrollTop = 4 * ROW_HEIGHT;
		fireEvent.scroll(scroller);

		expect(onApproachEdge).not.toHaveBeenCalled();
	});

	it("requests more guide data for a horizontal overscroll at a clamped edge", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 10,
			windowHours: 12,
			from: startOfHour(now),
			seed: 28
		});
		const onApproachEdge = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onApproachEdge={onApproachEdge}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 0;
		fireEvent.wheel(scroller, { deltaX: -120, deltaY: 0 });

		expect(onApproachEdge).toHaveBeenCalledTimes(1);
		expect(onApproachEdge).toHaveBeenCalledWith("left");
	});

	it("ignores diagonal wheel input when vertical movement dominates", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 10,
			windowHours: 12,
			from: startOfHour(now),
			seed: 31
		});
		const onApproachEdge = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onApproachEdge={onApproachEdge}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 0;
		fireEvent.wheel(scroller, { deltaX: -30, deltaY: 50 });

		expect(onApproachEdge).not.toHaveBeenCalled();
	});

	it("ignores the small horizontal scroll produced by a vertical trackpad gesture", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 10,
			windowHours: 12,
			from: startOfHour(now),
			seed: 34
		});
		const onApproachEdge = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onApproachEdge={onApproachEdge}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 60;
		fireEvent.scroll(scroller);
		onApproachEdge.mockClear();

		fireEvent.wheel(scroller, { deltaX: -15, deltaY: 100 });
		scroller.scrollLeft = 45;
		fireEvent.scroll(scroller);

		expect(onApproachEdge).not.toHaveBeenCalled();
	});

	it("requests more data for a horizontal touch gesture at a clamped edge", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 10,
			windowHours: 12,
			from: startOfHour(now),
			seed: 32
		});
		const onApproachEdge = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onApproachEdge={onApproachEdge}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 0;
		fireEvent(scroller, pointerEvent("pointerdown", 100, 100, "touch"));
		fireEvent(scroller, pointerEvent("pointermove", 140, 104, "touch"));

		expect(onApproachEdge).toHaveBeenCalledTimes(1);
		expect(onApproachEdge).toHaveBeenCalledWith("left");
	});

	it("does not treat ordinary mouse drift as an edge swipe", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 10,
			windowHours: 12,
			from: startOfHour(now),
			seed: 35
		});
		const onApproachEdge = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onApproachEdge={onApproachEdge}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 0;
		fireEvent(scroller, pointerEvent("pointerdown", 100, 100, "mouse"));
		fireEvent(scroller, pointerEvent("pointermove", 112, 102, "mouse"));

		expect(onApproachEdge).not.toHaveBeenCalled();
	});

	it("accumulates every repeated forward navigation by exactly 30 minutes", async () => {
		stubViewport(800, 600);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 24,
			from: startOfHour(now),
			seed: 22
		});

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		installScrollHarness(scroller);
		fireEvent.wheel(scroller, { deltaX: 100 });
		scroller.scrollLeft = scrollLeftForTime(
			new Date(now.getTime() + 2.5 * MS_PER_HOUR),
			now
		);
		fireEvent.scroll(scroller);

		const forward = screen.getByRole("button", {
			name: /forward.*30/i
		});
		const destinations: number[] = [];
		for (let press = 0; press < 3; press += 1) {
			await user.click(forward);
			destinations.push(scroller.scrollLeft);
		}

		const thirtyMinutesInPixels = 30 * PIXELS_PER_MINUTE;
		expect([
			destinations[1]! - destinations[0]!,
			destinations[2]! - destinations[1]!
		]).toEqual([thirtyMinutesInPixels, thirtyMinutesInPixels]);
	});

	it("accumulates rapid navigation while native smooth scrolling is still in flight", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 24,
			from: startOfHour(now),
			seed: 24
		});

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		fireEvent.wheel(scroller, { deltaX: 100 });
		scroller.scrollLeft = scrollLeftForTime(
			new Date(now.getTime() + 2.5 * MS_PER_HOUR),
			now
		);
		fireEvent.scroll(scroller);
		const destinations = installDeferredScrollHarness(scroller);
		const forward = screen.getByRole("button", { name: /forward.*30/i });

		fireEvent.click(forward);
		fireEvent.click(forward);
		fireEvent.click(forward);

		const thirtyMinutesInPixels = 30 * PIXELS_PER_MINUTE;
		expect(destinations).toHaveLength(3);
		expect([
			destinations[1]! - destinations[0]!,
			destinations[2]! - destinations[1]!
		]).toEqual([thirtyMinutesInPixels, thirtyMinutesInPixels]);
	});

	it("keeps a smooth time destination through vertical-only wheel input", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 24,
			from: startOfHour(now),
			seed: 29
		});

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		scroller.scrollLeft = 600;
		fireEvent.scroll(scroller);
		const destinations = installDeferredScrollHarness(scroller);
		const forward = screen.getByRole("button", { name: /forward.*30/i });

		fireEvent.click(forward);
		fireEvent.wheel(scroller, { deltaX: 0, deltaY: 120 });
		fireEvent.click(forward);

		expect(destinations).toHaveLength(2);
		expect(destinations[1]! - destinations[0]!).toBe(30 * PIXELS_PER_MINUTE);
	});

	it("keeps current cells rendered until a smooth scroll physically moves", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 24,
			from: startOfHour(now),
			seed: 33
		});
		const gridRef = createRef<GuideGridHandle>();

		render(
			<GuideGrid
				ref={gridRef}
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
			/>
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		installDeferredScrollHarness(scroller);
		const currentProgramId =
			screen.getAllByTestId("program-cell")[0]!.dataset["programId"];

		act(() => {
			gridRef.current?.scrollToTime(
				new Date(Date.parse(fixture.from) + 10 * MS_PER_HOUR)
			);
		});

		// Native smooth scrolling returns before pixels move. The currently
		// visible schedule must remain mounted during that transition.
		expect(
			scroller.querySelector(`[data-program-id="${currentProgramId}"]`)
		).not.toBeNull();
	});

	it("moves forward exactly 30 minutes when the viewport is wider than the initial buffer", async () => {
		stubViewport(1280, 700);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 12,
			from: new Date(now.getTime() - 2 * MS_PER_HOUR),
			seed: 26
		});

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				epgHoursVisible={4}
			/>
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		installScrollHarness(scroller);
		await waitFor(() => expect(scroller.dataset.visibleStart).toBeDefined());
		const initialVisibleStart = scroller.dataset.visibleStart!;
		fireEvent.click(screen.getByRole("button", { name: /forward.*30/i }));

		const expected = new Date(
			Date.parse(initialVisibleStart) + 30 * 60_000
		).toISOString();
		await waitFor(() =>
			expect(scroller).toHaveAttribute("data-visible-start", expected)
		);
	});

	it("keeps the active date in sync when scrolling across midnight", async () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 48,
			from: startOfHour(now),
			seed: 25
		});

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				epgHoursVisible={24}
			/>
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		fireEvent.wheel(scroller, { deltaX: 1_000 });
		scroller.scrollLeft = scrollLeftForTime(
			new Date(now.getTime() + 20 * MS_PER_HOUR),
			now
		);
		fireEvent.scroll(scroller);

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /^tomorrow,/i })
			).toHaveAttribute("aria-pressed", "true")
		);
	});

	it("reaches Tomorrow when the 24-hour cache is already full", async () => {
		stubViewport(1000, 700);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 72,
			from: new Date(now.getTime() - 4 * MS_PER_HOUR),
			seed: 27
		});

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				epgHoursVisible={24}
			/>
		);

		const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
		installScrollHarness(scroller);
		await waitFor(() => expect(scroller.dataset.visibleStart).toBeDefined());
		const initialVisibleStart = scroller.dataset.visibleStart!;

		fireEvent.click(screen.getByRole("button", { name: /^tomorrow,/i }));

		const expected = new Date(
			Date.parse(initialVisibleStart) + 24 * MS_PER_HOUR
		).toISOString();
		await waitFor(() =>
			expect(scroller).toHaveAttribute("data-visible-start", expected)
		);
	});

	it("resolves an out-of-range Now jump on the first click and stays stable on repeat", () => {
		stubViewport(800, 600);
		const now = new Date(2026, 5, 2, 12, 45);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);

		// The payload spans now, while the initial six-hour viewport starts
		// a day earlier, reproducing a user who has browsed away from live TV.
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 48,
			from: startOfHour(new Date(now.getTime() - 24 * MS_PER_HOUR)),
			seed: 23
		});
		const view = render(
			<GuidePage
				initialData={fixture}
				liveUpdates={false}
				epgHoursVisible={6}
			/>
		);

		try {
			const scroller = screen.getByTestId("guide-grid") as HTMLDivElement;
			installScrollHarness(scroller);
			const awayDestination = 512;
			scroller.scrollLeft = awayDestination;
			fireEvent.scroll(scroller);

			const nowButton = screen.getByRole("button", { name: /^now$/i });
			fireEvent.click(nowButton);
			const firstDestination = scroller.scrollLeft;
			fireEvent.click(nowButton);
			const secondDestination = scroller.scrollLeft;

			expect.soft(firstDestination).not.toBe(awayDestination);
			expect(secondDestination).toBe(firstDestination);
		} finally {
			// Unmount while Date is still mocked so the guide clears its timer
			// in the same clock environment in which it was created.
			view.unmount();
			vi.useRealTimers();
		}
	});
});
