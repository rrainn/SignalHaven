import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
	Recording,
	RecordingList,
	RecordingListItem,
	RecordingPatch,
	RecordingListQuery
} from "@signalhaven/shared";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		replace: vi.fn(),
		back: vi.fn(),
		forward: vi.fn(),
		refresh: vi.fn(),
		prefetch: vi.fn()
	})
}));

import { RecordingsPage } from "../../app/_recordings/RecordingsPage";

/**
 * Smoke / wiring tests for the U8 recordings library page. Pure
 * reducer / selector logic is covered in `state.test.ts`; this file
 * verifies the dispatch wiring and the API of the page-level seams
 * (the delete confirmation flow + the bulk delete bar in particular).
 */

const REC_BASE = {
	programId: null,
	scheduledEnd: "2025-01-01T01:00:00Z",
	actualStart: null,
	actualEnd: null,
	startReason: null,
	filePath: "/var/lib/signalhaven/recordings/sample.mkv",
	fileSize: 1_000_000_000,
	durationSeconds: 1800,
	errorMessage: null,
	manuallyProtected: false,
	watchedAt: null,
	resumePositionSeconds: null
} as const;

function rec(overrides: Partial<Recording>): Recording {
	return {
		id: "00000000-0000-4000-8000-000000000000",
		channelId: "00000000-0000-4000-8000-000000000aaa",
		title: "Untitled",
		status: "completed" as const,
		scheduledStart: "2025-01-01T00:00:00Z",
		seriesRuleId: null,
		...REC_BASE,
		...overrides
	};
}

/** Build a complete API page without coupling tests to schema defaults. */
function page(
	items: Array<Recording | RecordingListItem>,
	input: Partial<Omit<RecordingList, "items">> = {}
): RecordingList {
	return {
		items: items.map((recording) => ({
			...recording,
			metadata: "metadata" in recording ? recording.metadata : null
		})),
		total: input.total ?? items.length,
		totalSize:
			input.totalSize ??
			items.reduce((sum, recording) => sum + (recording.fileSize ?? 0), 0),
		limit: input.limit ?? 24,
		offset: input.offset ?? 0,
		nextCursor: input.nextCursor ?? null,
		seriesGroups: input.seriesGroups ?? [],
		oneOffGroup: input.oneOffGroup ?? null
	};
}

/** Controllable promise used to prove response-order independence. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const FIXTURE: Recording[] = [
	rec({
		id: "11111111-1111-4111-8111-111111111111",
		title: "Sherlock S01E01",
		seriesRuleId: "22222222-2222-4222-8222-222222222222",
		scheduledStart: "2025-03-01T20:00:00Z"
	}),
	rec({
		id: "33333333-3333-4333-8333-333333333333",
		title: "Sherlock S01E02",
		seriesRuleId: "22222222-2222-4222-8222-222222222222",
		scheduledStart: "2025-03-08T20:00:00Z"
	}),
	rec({
		id: "44444444-4444-4444-8444-444444444444",
		title: "Stand-alone Movie",
		seriesRuleId: null,
		scheduledStart: "2025-03-10T20:00:00Z",
		status: "scheduled"
	})
];

beforeEach(() => {
	pushMock.mockClear();
	window.history.replaceState({}, "", "/recordings");
});

describe("RecordingsPage", () => {
	it("lets narrow layouts disclose the secondary library controls", async () => {
		const user = userEvent.setup();
		render(<RecordingsPage initialRecordings={FIXTURE} />);

		const filtersButton = screen.getByRole("button", { name: "Filters" });
		expect(filtersButton).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByTestId("recordings-filter-status")).toBeInTheDocument();

		await user.click(filtersButton);

		expect(filtersButton).toHaveAttribute("aria-expanded", "true");
		expect(filtersButton).toHaveAttribute(
			"aria-controls",
			"recordings-filter-controls"
		);
	});

	it("renders one card per recording in the default grid view", async () => {
		render(<RecordingsPage initialRecordings={FIXTURE} />);
		expect(screen.getByTestId("recordings-grid")).toBeInTheDocument();
		expect(await screen.findAllByTestId(/^recording-card-/)).toHaveLength(
			FIXTURE.length
		);
	});

	it("identifies a partial recording that started late", async () => {
		const recording = rec({
			id: "55555555-5555-4555-8555-555555555555",
			startReason: "late_start"
		});
		render(<RecordingsPage initialRecordings={[recording]} />);

		expect(
			await screen.findByTestId(`recording-late-start-${recording.id}`)
		).toHaveTextContent("Partial recording");
	});

	it("renders rich episode metadata, artwork, and in-progress state from the list projection", async () => {
		const recording: RecordingListItem = {
			...rec({
				id: "55555555-5555-4555-8555-555555555555",
				resumePositionSeconds: 450,
				durationSeconds: 1800
			}),
			metadata: {
				subtitle: "The Return",
				description: "A new mystery begins.",
				episode: 2,
				season: 1,
				categories: ["Drama"],
				artworkUrl: "https://example.com/episode.jpg",
				originalAirDate: null
			}
		};

		render(<RecordingsPage initialRecordings={[recording]} />);

		expect(
			await screen.findByTestId(`recording-episode-${recording.id}`)
		).toHaveTextContent("S01E02 · The Return");
		expect(
			screen.getByRole("progressbar", { name: "Recording watch progress" })
		).toHaveAttribute("aria-valuenow", "25");
		expect(screen.getByText("25% watched")).toBeInTheDocument();
		expect(
			screen.queryByTestId("recording-artwork-fallback")
		).not.toBeInTheDocument();
	});

	it("shows a safe concise failure reason without exposing raw command output", async () => {
		const secretFailure =
			"ffmpeg /private/video.ts --token top-secret exited with code 1";
		const recording = rec({
			id: "66666666-6666-4666-8666-666666666666",
			status: "failed",
			errorMessage: secretFailure
		});

		render(<RecordingsPage initialRecordings={[recording]} />);

		expect(
			await screen.findByTestId(`recording-failure-${recording.id}`)
		).toHaveTextContent("Recorder process failed");
		expect(screen.queryByText(secretFailure)).not.toBeInTheDocument();
		expect(screen.queryByText(/top-secret/)).not.toBeInTheDocument();
	});

	it("optimistically protects a recording and visibly rolls back API failure", async () => {
		const user = userEvent.setup();
		const update = deferred<Recording>();
		const recording = rec({
			id: "77777777-7777-4777-8777-777777777777"
		});
		const onPatch = vi.fn(() => update.promise);
		render(
			<RecordingsPage initialRecordings={[recording]} onPatch={onPatch} />
		);

		await user.click(await screen.findByLabelText("Protect recording"));
		expect(screen.getByText("Protected")).toBeInTheDocument();
		expect(onPatch).toHaveBeenCalledWith(recording.id, {
			manuallyProtected: true
		});

		update.reject(new Error("offline"));
		expect(
			await screen.findByText(
				"The recording update failed and was rolled back."
			)
		).toBeInTheDocument();
		expect(screen.queryByText("Protected")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Protect recording")).toBeEnabled();
	});

	it("marks watched without overwriting resume position or protection", async () => {
		const user = userEvent.setup();
		const recording = rec({
			id: "88888888-8888-4888-8888-888888888888",
			resumePositionSeconds: 300,
			manuallyProtected: true
		});
		const onPatch = vi.fn(
			async (_recordingId: string, _patch: RecordingPatch) => ({
				...recording,
				watchedAt: "2026-01-02T00:00:00Z"
			})
		);
		render(
			<RecordingsPage initialRecordings={[recording]} onPatch={onPatch} />
		);

		await user.click(await screen.findByLabelText("Mark recording watched"));

		expect(onPatch).toHaveBeenCalledWith(recording.id, { watched: true });
		expect(onPatch.mock.calls[0]?.[1]).not.toHaveProperty(
			"resumePositionSeconds"
		);
		expect(onPatch.mock.calls[0]?.[1]).not.toHaveProperty("manuallyProtected");
		expect(await screen.findByText("Watched")).toBeInTheDocument();
	});

	it("toggles to list view when the list-view button is pressed", async () => {
		const user = userEvent.setup();
		render(<RecordingsPage initialRecordings={FIXTURE} />);
		await user.click(screen.getByTestId("recordings-view-list"));
		expect(screen.queryByTestId("recordings-grid")).not.toBeInTheDocument();
		expect(screen.getByTestId("recordings-list")).toBeInTheDocument();
		expect(await screen.findAllByTestId(/^recording-row-/)).toHaveLength(
			FIXTURE.length
		);
	});

	it("filters by search text against the title", async () => {
		const user = userEvent.setup();
		render(<RecordingsPage initialRecordings={FIXTURE} />);
		await user.type(screen.getByTestId("recordings-search"), "stand");
		await waitFor(() => {
			expect(screen.getAllByTestId(/^recording-card-/)).toHaveLength(1);
		});
		expect(screen.getByText("Stand-alone Movie")).toBeInTheDocument();
	});

	it("groups by series and surfaces a clickable series header", async () => {
		const user = userEvent.setup();
		render(<RecordingsPage initialRecordings={FIXTURE} />);
		await user.click(screen.getByTestId("recordings-group-by"));
		await user.click(screen.getByRole("option", { name: "By series" }));

		const seriesGroup = screen.getByTestId(
			"series-group-22222222-2222-4222-8222-222222222222"
		);
		expect(seriesGroup).toBeInTheDocument();
		expect(within(seriesGroup).getAllByTestId(/^recording-card-/)).toHaveLength(
			2
		);

		await user.click(
			screen.getByTestId("series-link-22222222-2222-4222-8222-222222222222")
		);
		expect(pushMock).toHaveBeenCalledWith(
			"/recordings/series/22222222-2222-4222-8222-222222222222?returnTo=%2Frecordings%3Fgroup%3Dseries"
		);
	});

	it("playing a recording navigates to /recordings/[id]", async () => {
		const user = userEvent.setup();
		render(<RecordingsPage initialRecordings={FIXTURE} />);
		await user.click(
			screen.getByTestId("recording-play-11111111-1111-4111-8111-111111111111")
		);
		expect(pushMock).toHaveBeenCalledWith(
			"/recordings/11111111-1111-4111-8111-111111111111?returnTo=%2Frecordings"
		);
	});

	it("delete shows a confirmation modal and removes the row on confirm", async () => {
		const user = userEvent.setup();
		const onDelete = vi.fn().mockResolvedValue(undefined);
		render(<RecordingsPage initialRecordings={FIXTURE} onDelete={onDelete} />);

		await user.click(
			screen.getByTestId(
				"recording-delete-11111111-1111-4111-8111-111111111111"
			)
		);
		expect(screen.getByTestId("recordings-delete-confirm")).toBeInTheDocument();

		await user.click(screen.getByTestId("recordings-delete-confirm-button"));

		expect(onDelete).toHaveBeenCalledWith(
			"11111111-1111-4111-8111-111111111111"
		);
		// Card is removed from the list.
		await waitFor(() => {
			expect(
				screen.queryByTestId(
					"recording-card-11111111-1111-4111-8111-111111111111"
				)
			).not.toBeInTheDocument();
		});
		expect(
			screen.getByTestId("recordings-pagination-summary")
		).toHaveTextContent("2 total");
	});

	it("requires an explicit protected-recording override before deletion", async () => {
		const user = userEvent.setup();
		const protectedRecording = rec({
			id: "99999999-9999-4999-8999-999999999999",
			manuallyProtected: true
		});
		const onDelete = vi.fn().mockResolvedValue(undefined);
		render(
			<RecordingsPage
				initialRecordings={[protectedRecording]}
				onDelete={onDelete}
			/>
		);

		await user.click(
			screen.getByTestId(`recording-delete-${protectedRecording.id}`)
		);
		expect(screen.getByTestId("recordings-delete-confirm")).toHaveTextContent(
			"is protected"
		);
		await user.click(
			screen.getByRole("button", { name: "Unprotect & delete" })
		);

		expect(onDelete).toHaveBeenCalledWith(protectedRecording.id, {
			overrideProtection: true
		});
	});

	it("bulk-delete invokes onDelete for every selected id", async () => {
		const user = userEvent.setup();
		const onDelete = vi.fn().mockResolvedValue(undefined);
		render(<RecordingsPage initialRecordings={FIXTURE} onDelete={onDelete} />);

		await user.click(
			screen.getByTestId(
				"recording-select-11111111-1111-4111-8111-111111111111"
			)
		);
		await user.click(
			screen.getByTestId(
				"recording-select-33333333-3333-4333-8333-333333333333"
			)
		);

		expect(screen.getByTestId("recordings-bulk-bar")).toBeInTheDocument();
		await user.click(screen.getByTestId("recordings-bulk-delete"));
		await user.click(screen.getByTestId("recordings-delete-confirm-button"));

		expect(onDelete).toHaveBeenCalledTimes(2);
		expect(onDelete).toHaveBeenCalledWith(
			"11111111-1111-4111-8111-111111111111"
		);
		expect(onDelete).toHaveBeenCalledWith(
			"33333333-3333-4333-8333-333333333333"
		);
		// Bulk bar disappears once the selection is cleared.
		expect(screen.queryByTestId("recordings-bulk-bar")).not.toBeInTheDocument();
	});

	it("lets a mixed bulk selection delete only unprotected recordings", async () => {
		const user = userEvent.setup();
		const unprotected = rec({
			id: "11111111-1111-4111-8111-111111111111",
			title: "Delete me"
		});
		const protectedRecording = rec({
			id: "22222222-2222-4222-8222-222222222222",
			title: "Keep me",
			manuallyProtected: true
		});
		const onDelete = vi.fn().mockResolvedValue(undefined);
		render(
			<RecordingsPage
				initialRecordings={[unprotected, protectedRecording]}
				onDelete={onDelete}
			/>
		);

		await user.click(screen.getByTestId(`recording-select-${unprotected.id}`));
		await user.click(
			screen.getByTestId(`recording-select-${protectedRecording.id}`)
		);
		await user.click(screen.getByTestId("recordings-bulk-delete"));
		expect(screen.getByTestId("recordings-delete-confirm")).toHaveTextContent(
			"1 selected recording is protected"
		);

		await user.click(
			screen.getByRole("button", { name: "Delete 1 unprotected" })
		);

		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(onDelete).toHaveBeenCalledWith(unprotected.id);
		await waitFor(() => {
			expect(
				screen.queryByTestId(`recording-card-${unprotected.id}`)
			).not.toBeInTheDocument();
		});
		expect(
			screen.getByTestId(`recording-card-${protectedRecording.id}`)
		).toBeInTheDocument();
	});

	it("offers a direct path from an empty library to the guide", async () => {
		const user = userEvent.setup();
		render(<RecordingsPage initialRecordings={[]} />);

		expect(screen.getByTestId("recordings-empty")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Browse the guide" }));

		expect(pushMock).toHaveBeenCalledWith("/guide");
	});

	it("keeps the empty-library prompt hidden until the initial request finishes", async () => {
		const initialRequest = deferred<RecordingList>();
		const loadRecordings = vi.fn(async () => initialRequest.promise);
		render(
			<RecordingsPage
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
				enableWebSocket={false}
			/>
		);

		expect(screen.getByTestId("recordings-loading")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: /loading/i })
		).toBeVisible();
		expect(screen.queryByTestId("recordings-empty")).not.toBeInTheDocument();

		const emptyStateAdditions: Element[] = [];
		const collectEmptyStateAdditions = (records: MutationRecord[]) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (!(node instanceof Element)) continue;
					const emptyState = node.matches('[data-testid="recordings-empty"]')
						? node
						: node.querySelector('[data-testid="recordings-empty"]');
					if (emptyState) emptyStateAdditions.push(emptyState);
				}
			}
		};
		// Observe every commit so a one-frame empty state cannot hide between awaits.
		const observer = new MutationObserver(collectEmptyStateAdditions);
		observer.observe(document.body, { childList: true, subtree: true });
		try {
			await act(async () => {
				initialRequest.resolve(page([FIXTURE[0]!]));
			});

			expect(await screen.findByText("Sherlock S01E01")).toBeInTheDocument();
		} finally {
			collectEmptyStateAdditions(observer.takeRecords());
			observer.disconnect();
		}
		expect(emptyStateAdditions).toHaveLength(0);
		expect(screen.queryByTestId("recordings-loading")).not.toBeInTheDocument();
	});

	it("sends filters to the server instead of filtering the loaded page", async () => {
		const user = userEvent.setup();
		const rows = page([FIXTURE[0]!], {
			total: 51,
			totalSize: FIXTURE[0]?.fileSize ?? 0,
			limit: 24,
			offset: 0,
			nextCursor: "next-page",
			seriesGroups: []
		});
		const loadRecordings = vi.fn(
			async (_query: Partial<RecordingListQuery>) => rows
		);

		render(
			<RecordingsPage
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
				enableWebSocket={false}
			/>
		);

		expect(
			await screen.findByTestId(
				"recording-card-11111111-1111-4111-8111-111111111111"
			)
		).toBeInTheDocument();
		await user.type(screen.getByTestId("recordings-search"), "sherlock");

		await waitFor(() => {
			expect(loadRecordings).toHaveBeenLastCalledWith(
				expect.objectContaining({ search: "sherlock", limit: 24 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) })
			);
		});
	});

	it("loads a recording beyond the first page and retains API metadata", async () => {
		const user = userEvent.setup();
		const first = rec({
			id: "55555555-5555-4555-8555-555555555555",
			title: "Newest episode"
		});
		const beyond = rec({
			id: "66666666-6666-4666-8666-666666666666",
			title: "Episode beyond page one"
		});
		const loadRecordings = vi.fn(async (query: Partial<RecordingListQuery>) =>
			query.cursor
				? page([beyond], { total: 25, offset: 24 })
				: page([first], {
						total: 25,
						totalSize: 25_000_000_000,
						nextCursor: "page-two"
					})
		);
		render(
			<RecordingsPage
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
				enableWebSocket={false}
			/>
		);

		expect(await screen.findByText("Newest episode")).toBeInTheDocument();
		expect(
			screen.getByTestId("recordings-pagination-summary")
		).toHaveTextContent("25 total");
		await user.click(screen.getByTestId("recordings-load-more"));

		expect(
			await screen.findByText("Episode beyond page one")
		).toBeInTheDocument();
		expect(window.location.search).toContain("pages=2");
	});

	it("uses complete server series counts while grouping loaded rows", async () => {
		const user = userEvent.setup();
		const seriesId = "22222222-2222-4222-8222-222222222222";
		const loadRecordings = vi.fn(async () =>
			page(FIXTURE.slice(0, 2), {
				total: 60,
				totalSize: 60_000_000_000,
				nextCursor: "page-two",
				seriesGroups: [
					{
						seriesRuleId: seriesId,
						title: "Canonical Sherlock",
						recordingCount: 60,
						totalSize: 60_000_000_000
					}
				]
			})
		);
		render(
			<RecordingsPage
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
				enableWebSocket={false}
			/>
		);
		await screen.findByTestId("recordings-page");
		await user.click(screen.getByTestId("recordings-group-by"));
		await user.click(screen.getByRole("option", { name: "By series" }));

		expect(screen.getByTestId(`series-group-${seriesId}`)).toHaveTextContent(
			"60 items"
		);
		expect(screen.getByTestId(`series-group-${seriesId}`)).toHaveTextContent(
			"Canonical Sherlock"
		);
	});

	it("ignores stale responses after rapid search changes", async () => {
		const user = userEvent.setup();
		const slow = deferred<RecordingList>();
		const fast = deferred<RecordingList>();
		const loadRecordings = vi.fn(async (query: Partial<RecordingListQuery>) => {
			if (query.search === "slow") return slow.promise;
			if (query.search === "fast") return fast.promise;
			return page([FIXTURE[0]!]);
		});
		render(
			<RecordingsPage
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
				enableWebSocket={false}
			/>
		);
		await screen.findByText("Sherlock S01E01");
		const search = screen.getByTestId("recordings-search");
		await user.type(search, "slow");
		await waitFor(() =>
			expect(loadRecordings).toHaveBeenCalledWith(
				expect.objectContaining({ search: "slow" }),
				expect.anything()
			)
		);
		await user.clear(search);
		await user.type(search, "fast");
		await waitFor(() =>
			expect(loadRecordings).toHaveBeenCalledWith(
				expect.objectContaining({ search: "fast" }),
				expect.anything()
			)
		);

		await act(async () => {
			fast.resolve(
				page([
					rec({
						id: "77777777-7777-4777-8777-777777777777",
						title: "Fast result"
					})
				])
			);
		});
		expect(await screen.findByText("Fast result")).toBeInTheDocument();
		await act(async () => {
			slow.resolve(
				page([
					rec({
						id: "88888888-8888-4888-8888-888888888888",
						title: "Stale result"
					})
				])
			);
		});
		expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
		expect(screen.getByText("Fast result")).toBeInTheDocument();
	});

	it("preserves prior pages and retries a failed later page", async () => {
		const user = userEvent.setup();
		let laterAttempts = 0;
		const beyond = rec({
			id: "99999999-9999-4999-8999-999999999999",
			title: "Recovered later page"
		});
		const loadRecordings = vi.fn(async (query: Partial<RecordingListQuery>) => {
			if (!query.cursor) {
				return page([FIXTURE[0]!], {
					total: 25,
					nextCursor: "page-two"
				});
			}
			laterAttempts += 1;
			if (laterAttempts === 1) throw new Error("Later page failed");
			return page([beyond], { total: 25, offset: 24 });
		});
		render(
			<RecordingsPage
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
				enableWebSocket={false}
			/>
		);
		expect(await screen.findByText("Sherlock S01E01")).toBeInTheDocument();
		await user.click(screen.getByTestId("recordings-load-more"));

		const error = await screen.findByTestId("recordings-load-more-error");
		expect(error).toHaveTextContent("Later page failed");
		expect(screen.getByText("Sherlock S01E01")).toBeInTheDocument();
		await user.click(within(error).getByRole("button", { name: "Retry" }));

		expect(await screen.findByText("Recovered later page")).toBeInTheDocument();
		expect(
			screen.queryByTestId("recordings-load-more-error")
		).not.toBeInTheDocument();
	});
});
