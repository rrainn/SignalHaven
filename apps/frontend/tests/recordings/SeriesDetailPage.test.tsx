import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
	Recording,
	RecordingList,
	RecordingListItem,
	RecordingListQuery
} from "@signalhaven/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { SeriesDetailPage } from "../../app/_recordings/SeriesDetailPage";

const SERIES_ID = "22222222-2222-4222-8222-222222222222";

/** Build an episode row with the full shared recordings contract. */
function recording(id: string, title: string): Recording {
	return {
		id,
		channelId: "00000000-0000-4000-8000-000000000aaa",
		programId: null,
		title,
		status: "completed",
		scheduledStart: "2026-01-01T00:00:00Z",
		scheduledEnd: "2026-01-01T01:00:00Z",
		actualStart: "2026-01-01T00:00:00Z",
		actualEnd: "2026-01-01T01:00:00Z",
		startReason: null,
		filePath: `/recordings/${id}.mkv`,
		fileSize: 1_000_000_000,
		durationSeconds: 3_600,
		errorMessage: null,
		seriesRuleId: SERIES_ID,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null
	};
}

/** Build a page whose aggregate metadata describes the complete series. */
function page(
	items: Array<Recording | RecordingListItem>,
	nextCursor: string | null,
	offset: number
): RecordingList {
	return {
		items: items.map((recording) => ({
			...recording,
			metadata: "metadata" in recording ? recording.metadata : null
		})),
		total: 55,
		totalSize: 55_000_000_000,
		limit: 24,
		offset,
		nextCursor,
		seriesGroups: [
			{
				seriesRuleId: SERIES_ID,
				title: "Complete Series",
				recordingCount: 55,
				totalSize: 55_000_000_000
			}
		],
		oneOffGroup: null
	};
}

beforeEach(() => {
	pushMock.mockClear();
	window.history.replaceState({}, "", `/recordings/series/${SERIES_ID}`);
});

describe("SeriesDetailPage", () => {
	it("uses the series filter, complete totals, and cursor pagination", async () => {
		const user = userEvent.setup();
		const first = recording(
			"11111111-1111-4111-8111-111111111111",
			"Episode one"
		);
		const later = recording(
			"33333333-3333-4333-8333-333333333333",
			"Episode beyond page one"
		);
		const loadRecordings = vi.fn(async (query: Partial<RecordingListQuery>) =>
			query.cursor ? page([later], null, 24) : page([first], "next-page", 0)
		);

		render(
			<SeriesDetailPage
				seriesRuleId={SERIES_ID}
				returnTo="/recordings?search=series"
				loadRecordings={loadRecordings}
				loadChannels={async () => []}
			/>
		);

		expect(await screen.findByText("Episode one")).toBeInTheDocument();
		expect(screen.getByTestId("series-title")).toHaveTextContent(
			"Complete Series"
		);
		expect(screen.getByTestId("series-summary")).toHaveTextContent(
			"55 episodes"
		);
		expect(loadRecordings).toHaveBeenCalledWith(
			expect.objectContaining({
				seriesRuleId: SERIES_ID,
				limit: 24,
				offset: 0
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);

		await user.click(screen.getByTestId("series-load-more"));
		expect(
			await screen.findByText("Episode beyond page one")
		).toBeInTheDocument();
		await waitFor(() => expect(window.location.search).toContain("pages=2"));

		await user.click(screen.getByRole("button", { name: "Back to library" }));
		expect(pushMock).toHaveBeenCalledWith("/recordings?search=series");
	});
});
