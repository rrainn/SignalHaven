import type { Recording } from "@signalhaven/shared";
import { describe, expect, it, vi } from "vitest";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
	CHANNEL_COL_WIDTH,
	GuideGrid,
	PIXELS_PER_MINUTE
} from "../../app/_guide/GuideGrid";
import { GuidePage } from "../../app/_guide/GuidePage";
import { buildGuideFixture } from "../../app/_guide/fixtures";
import { startOfHour } from "../../app/_guide/time";
import { formatTimePreference } from "../../app/_preferences/formatting";

/**
 * The grid container in the test environment has zero size by default
 * (jsdom doesn't lay out CSS). We force `clientWidth`/`clientHeight` so
 * the virtualizer materialises a realistic visible slice, then assert
 * the DOM cell budget against the documented target.
 */
function stubViewport(width: number, height: number) {
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

/** Build the API row returned after the selected program is scheduled. */
function scheduledRecording(programId: string, channelId: string): Recording {
	return {
		id: "88888888-8888-4888-8888-888888888888",
		channelId,
		programId,
		title: "Scheduled from Guide",
		status: "scheduled",
		scheduledStart: "2026-06-01T12:00:00.000Z",
		scheduledEnd: "2026-06-01T13:00:00.000Z",
		actualStart: null,
		actualEnd: null,
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: null,
		errorMessage: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null
	};
}

describe("GuideGrid (virtualization)", () => {
	it("fits a short channel lineup without an empty strip below the rows", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 4,
			from: startOfHour(now),
			seed: 24
		});

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		// The 44px timeline plus two 64px rows should define the full frame.
		expect(screen.getByTestId("guide-grid")).toHaveStyle({ height: "172px" });
	});

	it("renders ~< 200 program cells from a 200-channel x 24h fixture", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0); // local
		const fixture = buildGuideFixture({
			channelCount: 200,
			windowHours: 24,
			from: startOfHour(new Date(now.getTime() - 60 * 60_000)),
			seed: 7
		});
		expect(fixture.channels).toHaveLength(200);
		expect(fixture.programs.length).toBeGreaterThan(2000);

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const cells = screen.getAllByTestId("program-cell");
		// The grid is a 1280x800 viewport with a 176px channel column and
		// 64px rows. With 4px/min ticks and the documented overscan we
		// materialise ~50–150 cells; the issue's acceptance criterion is
		// ~150. Allow some headroom but well under the >2000 total.
		expect(cells.length).toBeLessThanOrEqual(200);
		expect(cells.length).toBeGreaterThan(0);

		// Every visible cell must reference a real program id from the fixture.
		const idSet = new Set(fixture.programs.map((p) => p.id));
		for (const cell of cells) {
			const id = cell.getAttribute("data-program-id");
			expect(id).not.toBeNull();
			expect(idSet.has(id ?? "")).toBe(true);
		}

		// Channel-row column is also virtualized: at most ~30 rows visible
		// for an 800px tall viewport with 56px rows + overscan.
		const rows = screen.getAllByTestId("channel-row");
		expect(rows.length).toBeLessThanOrEqual(40);
		expect(rows.length).toBeGreaterThan(0);
	});

	it("reuses parsed program timestamps while scrolling", async () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 20,
			windowHours: 24,
			from: startOfHour(new Date(now.getTime() - 60 * 60_000)),
			seed: 27
		});
		const parseSpy = vi.spyOn(Date, "parse");

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);
		const scroller = screen.getByTestId("guide-grid");
		const initialVisibleStart = scroller.dataset.visibleStart;
		parseSpy.mockClear();

		scroller.scrollLeft = 720;
		fireEvent.scroll(scroller);

		// Scrolling should consume the temporal index built for this data set.
		await waitFor(() =>
			expect(scroller.dataset.visibleStart).not.toBe(initialVisibleStart)
		);
		expect(parseSpy).not.toHaveBeenCalled();
		parseSpy.mockRestore();
	});

	it("keeps rendered cells and the reported range synchronized during fast scrolling", async () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 12,
			from: windowStart,
			seed: 28
		});
		const onVisibleRangeChange = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onVisibleRangeChange={onVisibleRangeChange}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		const targetStart = new Date(windowStart.getTime() + 4 * 60 * 60_000);
		const targetProgram = fixture.programs.find(
			(program) =>
				program.channelId === fixture.channels[0]!.id &&
				Date.parse(program.start) <= targetStart.getTime() &&
				targetStart.getTime() < Date.parse(program.stop)
		)!;
		scroller.scrollLeft = 4 * 60 * 4;
		fireEvent.scroll(scroller);

		// A physical scroll must atomically update virtualization and the toolbar
		// range so the viewport cannot expose stale, empty schedule space.
		await waitFor(() => {
			expect(scroller).toHaveAttribute(
				"data-visible-start",
				targetStart.toISOString()
			);
			expect(onVisibleRangeChange).toHaveBeenLastCalledWith(
				expect.objectContaining({ start: targetStart })
			);
			expect(
				document.querySelector(`[data-program-id="${targetProgram.id}"]`)
			).not.toBeNull();
		});
	});

	it("uses one physical scroll sample for cells and the reported range", async () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 12,
			from: windowStart,
			seed: 35
		});
		const onVisibleRangeChange = vi.fn();

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onVisibleRangeChange={onVisibleRangeChange}
			/>
		);

		const scroller = screen.getByTestId("guide-grid");
		let reads = 0;
		Object.defineProperty(scroller, "scrollLeft", {
			configurable: true,
			get: () => {
				reads += 1;
				// Safari may advance momentum while React handles the same native event;
				// every consumer must share the committed frame sample.
				return reads <= 3 ? 4 * 60 * 4 : 3 * 60 * 4;
			}
		});

		fireEvent.scroll(scroller);

		await waitFor(() => {
			const reportedStart = onVisibleRangeChange.mock.lastCall?.[0].start;
			expect(reportedStart).toBeInstanceOf(Date);
			expect(reportedStart.toISOString()).toBe(
				new Date(windowStart.getTime() + 4 * 60 * 60_000).toISOString()
			);
			expect(scroller.dataset.visibleStart).toBe(reportedStart.toISOString());
		});
	});

	it("reports a range only after its matching cells are committed", async () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 12,
			from: windowStart,
			seed: 36
		});
		const observations: Array<{
			renderedStart: string | undefined;
			reportedStart: string;
		}> = [];

		render(
			<GuideGrid
				data={fixture}
				now={now}
				onSelectProgram={() => undefined}
				onVisibleRangeChange={(range) => {
					observations.push({
						renderedStart:
							screen.queryByTestId("guide-grid")?.dataset.visibleStart,
						reportedStart: range.start.toISOString()
					});
				}}
			/>
		);

		observations.length = 0;
		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 4 * 60 * 4;
		fireEvent.scroll(scroller);

		// Publishing from the committed layout prevents a parent toolbar render
		// from getting ahead of the virtualized timeline in another React batch.
		await waitFor(() =>
			expect(observations[observations.length - 1]).toEqual({
				renderedStart: new Date(
					windowStart.getTime() + 4 * 60 * 60_000
				).toISOString(),
				reportedStart: new Date(
					windowStart.getTime() + 4 * 60 * 60_000
				).toISOString()
			})
		);
	});

	it("links each visible channel label to its live feed", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 3,
			windowHours: 4,
			from: startOfHour(now),
			seed: 4
		});
		const channel = fixture.channels[0]!;
		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const link = screen.getByRole("link", {
			name: `Watch ${channel.number} ${channel.name}`
		});
		expect(link).toHaveAttribute(
			"href",
			`/watch/${encodeURIComponent(channel.id)}`
		);
		expect(within(link).getByTestId("channel-watch-affordance")).toBeVisible();
	});

	it("renders the sticky 'now' indicator when now falls in the window", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 30);
		const fixture = buildGuideFixture({
			channelCount: 5,
			windowHours: 6,
			from: startOfHour(new Date(now.getTime() - 60 * 60_000)),
			seed: 1
		});
		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);
		expect(screen.getByTestId("now-indicator")).toBeInTheDocument();
		const liveProgram = screen
			.getAllByTestId("program-cell")
			.find((cell) => cell.dataset.airing === "true");
		expect(liveProgram).toHaveAccessibleName(/live now/i);
	});

	it("uses the theme surface for the sticky time axis", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 4,
			from: startOfHour(now),
			seed: 9
		});

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		// The semantic surface utility resolves against both light and dark themes.
		expect(screen.getByLabelText("Guide timeline")).toHaveClass("bg-surface");
	});

	it("applies saved guide settings while preserving context before now", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 4,
			windowHours: 8,
			from: startOfHour(now),
			seed: 16
		});
		const [first, hidden, manualFirst, favorite] = fixture.channels;

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				use24Hour
				epgHoursVisible={4}
				channelPreferences={{
					favorites: [favorite!.id],
					hidden: [hidden!.id],
					order: [manualFirst!.id, favorite!.id, first!.id]
				}}
			/>
		);

		expect(
			screen.getAllByTestId("channel-row").map((row) => row.dataset.channelId)
		).toEqual([favorite!.id, manualFirst!.id, first!.id]);

		const expectedStart = new Date(now.getTime() - 30 * 60_000);
		const visibleMinutes = (1280 - CHANNEL_COL_WIDTH) / PIXELS_PER_MINUTE;
		const expectedEnd = new Date(
			expectedStart.getTime() + visibleMinutes * 60_000
		);
		const visibleWindow = screen.getByTestId("guide-window-label");
		expect(visibleWindow).toHaveTextContent(
			formatTimePreference(expectedStart, true)
		);
		expect(visibleWindow).toHaveTextContent(
			formatTimePreference(expectedEnd, true)
		);
	});

	it("explains how to recover when every channel is hidden", () => {
		stubViewport(900, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 4,
			from: startOfHour(now),
			seed: 17
		});

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				channelPreferences={{
					favorites: [],
					hidden: fixture.channels.map((channel) => channel.id),
					order: []
				}}
			/>
		);

		expect(
			screen.getByRole("heading", { name: /all channels are hidden/i })
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /manage channels/i })
		).toHaveAttribute("href", "/channels");
	});

	it("opens the program details modal when a cell is clicked", async () => {
		stubViewport(1280, 800);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 3,
			windowHours: 4,
			from: startOfHour(new Date(now.getTime() - 60 * 60_000)),
			seed: 2
		});
		const loadProgramDetails = vi.fn(async (programId: string) => {
			const selectedProgram = fixture.programs.find(
				(program) => program.id === programId
			)!;
			const selectedChannel = fixture.channels.find(
				(channel) => channel.id === selectedProgram.channelId
			)!;
			return {
				program: {
					...selectedProgram,
					description: "Loaded only after opening details.",
					categories: ["Drama"]
				},
				channel: selectedChannel
			};
		});
		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				loadProgramDetails={loadProgramDetails}
			/>
		);
		expect(loadProgramDetails).not.toHaveBeenCalled();
		const liveProgram = fixture.programs.find(
			(program) =>
				Date.parse(program.start) <= now.getTime() &&
				now.getTime() < Date.parse(program.stop)
		);
		expect(liveProgram).toBeDefined();
		const liveCell = document.querySelector<HTMLElement>(
			`[data-program-id="${liveProgram?.id}"]`
		);
		expect(liveCell).not.toBeNull();
		await user.click(liveCell as HTMLElement);

		const dialog = await screen.findByRole("dialog");
		await waitFor(() =>
			expect(loadProgramDetails).toHaveBeenCalledWith(liveProgram?.id)
		);
		expect(
			await within(dialog).findByText("Loaded only after opening details.")
		).toBeVisible();
		expect(within(dialog).getByText(/watch/i)).toBeInTheDocument();
		expect(within(dialog).getByText(/^record$/i)).toBeInTheDocument();
		expect(within(dialog).getByText(/record series/i)).toBeInTheDocument();
	});

	it("keeps shared EPG programs attached to the selected tuner variant", async () => {
		stubViewport(1280, 800);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 4,
			from: startOfHour(now),
			seed: 25
		});
		const [primary, favorite] = fixture.channels;
		const shared = fixture.programs.find(
			(program) => program.channelId === primary!.id
		)!;
		fixture.programs = [shared, { ...shared, channelId: favorite!.id }];

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const favoriteCell = document.querySelector<HTMLElement>(
			`[data-program-id="${shared.id}"][data-channel-id="${favorite!.id}"]`
		);
		expect(favoriteCell).not.toBeNull();
		await user.click(favoriteCell!);

		expect(await screen.findByRole("dialog")).toHaveTextContent(
			`${favorite!.number} · ${favorite!.name}`
		);
	});

	it("cancels an existing recording from program details", async () => {
		stubViewport(1280, 800);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: startOfHour(new Date(now.getTime() - 60 * 60_000)),
			seed: 8
		});
		const program = fixture.programs[0]!;
		program.recordingStatus = "scheduled";
		(program as typeof program & { recordingId: string }).recordingId =
			"99999999-9999-4999-8999-999999999999";
		const onCancel = vi.fn().mockResolvedValue(undefined);

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				onCancel={onCancel}
			/>
		);
		await user.click(screen.getAllByTestId("program-cell")[0]!);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Scheduled")).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("button", { name: /cancel recording/i })
		);

		expect(onCancel).toHaveBeenCalledWith(
			"99999999-9999-4999-8999-999999999999",
			expect.any(Object)
		);
	});

	it("keeps Record pending and ignores rapid repeat submissions", async () => {
		stubViewport(1280, 800);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: startOfHour(now),
			seed: 12
		});
		const program = fixture.programs[0]!;
		let resolveSchedule!: (recording: Recording) => void;
		const onRecord = vi.fn(
			() =>
				new Promise<Recording>((resolve) => {
					resolveSchedule = resolve;
				})
		);

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				onRecord={onRecord}
			/>
		);

		await user.click(screen.getAllByTestId("program-cell")[0]!);
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: /^record$/i
			})
		);
		const recordModal = within(await screen.findByTestId("record-modal"));
		const recordButton = recordModal.getByTestId("record-modal-record");
		await user.click(recordButton);

		expect(recordButton).toBeDisabled();
		await user.click(recordButton);
		expect(onRecord).toHaveBeenCalledTimes(1);

		resolveSchedule(scheduledRecording(program.id, program.channelId));
		expect(
			await recordModal.findByTestId("record-modal-success")
		).toBeInTheDocument();
	});

	it("restores scheduled state when cancellation fails", async () => {
		stubViewport(1280, 800);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: startOfHour(now),
			seed: 14
		});
		const program = fixture.programs[0]!;
		program.recordingStatus = "scheduled";
		program.recordingId = "77777777-7777-4777-8777-777777777777";
		let rejectCancellation!: (error: Error) => void;
		const onCancel = vi.fn(
			() =>
				new Promise<Recording>((_resolve, reject) => {
					rejectCancellation = reject;
				})
		);

		render(
			<GuidePage
				initialData={fixture}
				nowOverride={now}
				liveUpdates={false}
				onCancel={onCancel}
			/>
		);

		await user.click(screen.getAllByTestId("program-cell")[0]!);
		const dialog = within(await screen.findByRole("dialog"));
		const cancelButton = dialog.getByRole("button", {
			name: /cancel recording/i
		});
		await user.click(cancelButton);

		expect(dialog.getByRole("button", { name: /cancelling/i })).toBeDisabled();
		expect(onCancel).toHaveBeenCalledTimes(1);

		rejectCancellation(new Error("Scheduler is unavailable"));
		expect(await dialog.findByRole("alert")).toHaveTextContent(
			/scheduler is unavailable/i
		);
		expect(dialog.getByText("Scheduled")).toBeInTheDocument();
		expect(
			dialog.getByRole("button", { name: /cancel recording/i })
		).toBeEnabled();
	});

	it("toolbar exposes explicit date and time navigation", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 6,
			from: startOfHour(now),
			seed: 5
		});
		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);
		expect(screen.getByRole("button", { name: /^now$/i })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /back 30m/i })
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /forward 30m/i })
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: /jump to time/i })
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /prime time/i })
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^today,/i })
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^tomorrow,/i })
		).toBeInTheDocument();
	});

	it("renders a progress bar on the currently airing program", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 30);
		// Anchor the window so "now" sits 30 min in. Build a 1-channel
		// fixture with a single program that spans `now` and starts at the
		// window origin, guaranteeing the cell is in the visible slice.
		const windowStart = startOfHour(now); // 12:00
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 6,
			from: windowStart,
			seed: 3
		});
		const first = fixture.programs[0]!;
		first.start = windowStart.toISOString();
		first.stop = new Date(windowStart.getTime() + 60 * 60_000).toISOString();
		// Drop any later programs on this channel — they're not needed and
		// simplify the assertion.
		fixture.programs = [first];

		render(
			<GuidePage initialData={fixture} nowOverride={now} liveUpdates={false} />
		);

		const cells = screen.getAllByTestId("program-cell");
		expect(cells.length).toBeGreaterThan(0);
		const airing = cells.find(
			(el) => el.getAttribute("data-airing") === "true"
		);
		expect(airing).toBeDefined();
		expect(
			airing!.querySelector('[data-testid="program-progress"]')
		).not.toBeNull();
	});

	it("lays out conflicting feed rows without obscuring another program", () => {
		stubViewport(900, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: startOfHour(now),
			seed: 19
		});
		const channelPrograms = fixture.programs.filter(
			(program) => program.channelId === fixture.channels[0]!.id
		);
		const first = channelPrograms[0]!;
		const second = channelPrograms[1]!;
		first.stop = new Date(Date.parse(second.start) + 15 * 60_000).toISOString();

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		const firstCell = document.querySelector<HTMLElement>(
			`[data-program-id="${first.id}"]`
		)!;
		const secondCell = document.querySelector<HTMLElement>(
			`[data-program-id="${second.id}"]`
		)!;
		const firstGridCell = firstCell.parentElement as HTMLElement;
		const secondGridCell = secondCell.parentElement as HTMLElement;
		const firstRight =
			Number.parseFloat(firstGridCell.style.left) +
			Number.parseFloat(firstGridCell.style.width);
		const secondLeft = Number.parseFloat(secondGridCell.style.left);

		expect(firstRight).toBeLessThanOrEqual(secondLeft);
	});

	it("keeps a long program title at the visible scroll position without leaving its cell", async () => {
		stubViewport(900, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 6,
			from: windowStart,
			seed: 23
		});
		const longProgram = fixture.programs[0]!;
		longProgram.stop = new Date(
			windowStart.getTime() + 4 * 60 * 60_000
		).toISOString();
		fixture.programs = [longProgram];

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 360;
		fireEvent.scroll(scroller);

		// A transform follows the exposed portion without forcing Safari to lay
		// out every visible program again during momentum scrolling.
		await waitFor(() => {
			expect(screen.getByTestId("program-content")).toHaveStyle({
				left: "0px",
				width: "597px",
				transform: "translate3d(360px, 0, 0)"
			});
		});
	});

	it("never collapses a standard program label while scroll coordinates settle", async () => {
		stubViewport(900, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: windowStart,
			seed: 34
		});
		const program = fixture.programs[0]!;
		program.start = windowStart.toISOString();
		program.stop = new Date(windowStart.getTime() + 30 * 60_000).toISOString();
		fixture.programs = [program];

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 120;
		fireEvent.scroll(scroller);

		// Safari can momentarily retain a prior frame coordinate. The content
		// follower must still reserve enough width to render the program title.
		await waitFor(() => {
			expect(screen.getByTestId("program-content")).toHaveStyle({
				left: "0px",
				width: "44px",
				transform: "translate3d(73px, 0, 0)"
			});
		});
	});

	it("pins a long schedule gap label with a frame-committed transform", async () => {
		stubViewport(900, 600);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 6,
			from: windowStart,
			seed: 29
		});
		fixture.programs = [];

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		const scroller = screen.getByTestId("guide-grid");
		scroller.scrollLeft = 360;
		fireEvent.scroll(scroller);

		await waitFor(() => {
			expect(screen.getByTestId("schedule-gap-content")).toHaveStyle({
				position: "absolute",
				left: "0px",
				transform: "translate3d(360px, 0, 0)"
			});
		});
	});

	it("presents mobile schedules as discrete time steps with a next-program cue", async () => {
		stubViewport(390, 640);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: windowStart,
			seed: 31
		});
		const shortProgram = fixture.programs[0]!;
		const nextProgram = fixture.programs[1]!;
		shortProgram.start = windowStart.toISOString();
		shortProgram.stop = new Date(
			windowStart.getTime() + 30 * 60_000
		).toISOString();
		nextProgram.start = shortProgram.stop;
		nextProgram.stop = new Date(
			windowStart.getTime() + 60 * 60_000
		).toISOString();
		fixture.programs = [shortProgram, nextProgram];

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		const program = screen.getByTestId("program-cell");
		expect(program).toHaveAttribute("data-layout", "time-anchor");
		expect(
			Number.parseFloat((program.parentElement as HTMLElement).style.width)
		).toBeGreaterThanOrEqual(44);
		expect(screen.getByText(shortProgram.title)).toBeVisible();
		expect(screen.getByText(/programs at 12:00 pm/i)).toBeVisible();
		expect(
			screen.getByText(new RegExp(`next.*${nextProgram.title}`, "i"))
		).toBeVisible();
		const scroller = screen.getByTestId("guide-grid");
		expect(scroller).toHaveAttribute("data-time-navigation", "discrete");

		// Restored browser positions can land between steps. The physical range
		// and the displayed anchor must converge on the same half-hour.
		scroller.scrollLeft = 15;
		fireEvent.scroll(scroller);
		await waitFor(() => {
			expect(scroller).toHaveAttribute(
				"data-visible-start",
				windowStart.toISOString()
			);
		});

		await user.click(screen.getByRole("button", { name: "Next 30 minutes" }));

		await waitFor(() => {
			expect(screen.getByText(/programs at 12:30 pm/i)).toBeVisible();
			expect(screen.getByText(nextProgram.title)).toBeVisible();
		});
		expect(
			screen.getByRole("button", { name: "Previous 30 minutes" })
		).toBeEnabled();
	});

	it("exposes rows and program cells as a roving semantic grid", async () => {
		stubViewport(1280, 800);
		const user = userEvent.setup();
		const now = new Date(2026, 5, 1, 12, 0);
		const fixture = buildGuideFixture({
			channelCount: 2,
			windowHours: 4,
			from: startOfHour(now),
			seed: 32
		});

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		expect(screen.getByRole("grid", { name: "Program guide" })).toHaveAttribute(
			"aria-rowcount",
			String(fixture.channels.length + 1)
		);
		expect(screen.getAllByRole("rowheader")).toHaveLength(
			fixture.channels.length
		);
		expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0);

		const programs = screen.getAllByTestId("program-cell");
		expect(programs[0]).not.toHaveAttribute("role");
		expect(programs[0]?.parentElement).toHaveAttribute("role", "gridcell");
		const firstColumn = Number(
			programs[0]?.parentElement?.getAttribute("aria-colindex")
		);
		const secondColumn = Number(
			programs[1]?.parentElement?.getAttribute("aria-colindex")
		);
		expect(firstColumn).toBeGreaterThanOrEqual(2);
		expect(secondColumn).toBeGreaterThan(firstColumn);
		expect(programs.filter((program) => program.tabIndex === 0)).toHaveLength(
			1
		);
		act(() => programs[0]!.focus());
		await user.keyboard("{ArrowRight}");
		await waitFor(() => expect(programs[1]).toHaveFocus());
		expect(programs[0]).toHaveAttribute("tabindex", "-1");
		expect(programs[1]).toHaveAttribute("tabindex", "0");
	});

	it("labels every missing interval in a partially populated schedule", () => {
		stubViewport(1280, 800);
		const now = new Date(2026, 5, 1, 12, 0);
		const windowStart = startOfHour(now);
		const fixture = buildGuideFixture({
			channelCount: 1,
			windowHours: 4,
			from: windowStart,
			seed: 33
		});
		const first = fixture.programs[0]!;
		const second = fixture.programs[1]!;
		first.start = new Date(windowStart.getTime() + 30 * 60_000).toISOString();
		first.stop = new Date(windowStart.getTime() + 60 * 60_000).toISOString();
		second.start = new Date(windowStart.getTime() + 90 * 60_000).toISOString();
		second.stop = new Date(windowStart.getTime() + 120 * 60_000).toISOString();
		fixture.programs = [first, second];

		render(
			<GuideGrid data={fixture} now={now} onSelectProgram={() => undefined} />
		);

		const gaps = screen.getAllByTestId("schedule-gap");
		expect(gaps).toHaveLength(3);
		for (const gap of gaps) {
			expect(gap).toHaveTextContent("No schedule data");
		}
	});
});
