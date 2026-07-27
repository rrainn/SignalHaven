import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { EpgSource } from "@signalhaven/shared";

import { EpgSection } from "../../app/_settings/EpgSection";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		createEpgSource: vi.fn(),
		deleteEpgSource: vi.fn(),
		refreshEpgSource: vi.fn(),
		updateEpgSource: vi.fn()
	};
});

vi.mock("../../lib/ws-client", () => ({
	useWebSocketEvents: () => "open"
}));

import { createEpgSource, refreshEpgSource } from "../../lib/api-client";

const createMock = vi.mocked(createEpgSource);
const refreshMock = vi.mocked(refreshEpgSource);

beforeEach(() => {
	createMock.mockReset();
	refreshMock.mockReset();
});

const sampleSource: EpgSource = {
	id: "11111111-1111-1111-1111-111111111111",
	kind: "xmltv",
	name: "Demo XMLTV",
	url: "https://example.com/guide.xml",
	filePath: null,
	tunerId: null,
	refreshIntervalMinutes: 720,
	timezone: null,
	enabled: true,
	lastRefreshAt: new Date(Date.now() - 5 * 60_000).toISOString(),
	lastRefreshStatus: "ok",
	lastRefreshError: null,
	createdAt: "2024-01-01T00:00:00Z",
	updatedAt: "2024-01-01T00:00:00Z"
};

describe("EpgSection", () => {
	it("renders a 'last refresh' badge when the source has a successful refresh", () => {
		render(<EpgSection sources={[sampleSource]} onChanged={() => {}} />);
		expect(screen.getByTestId("epg-refresh-last")).toHaveTextContent(
			/Last refresh: 5m ago/i
		);
	});

	it("shows HDHomeRun refresh errors without exposing DeviceAuth", () => {
		const failedSource: EpgSource = {
			...sampleSource,
			kind: "hdhomerun_guide",
			name: "Living Room guide",
			url: "https://api.hdhomerun.com/api/guide.php?DeviceAuth=SECRET_TOKEN",
			lastRefreshStatus: "error",
			lastRefreshError: "Failed to fetch HDHomeRun guide: 400 Bad Request"
		};

		render(<EpgSection sources={[failedSource]} onChanged={() => {}} />);

		expect(screen.getByRole("alert")).toHaveTextContent(/400 Bad Request/i);
		expect(screen.queryByText(/SECRET_TOKEN/i)).not.toBeInTheDocument();
		expect(
			screen.getByText(/managed automatically from the tuner/i)
		).toBeInTheDocument();
	});

	it("does not duplicate a persisted HDHomeRun error after a failed retry", async () => {
		const user = userEvent.setup();
		const message = "Failed to fetch HDHomeRun guide: 400 Bad Request";
		const failedSource: EpgSource = {
			...sampleSource,
			kind: "hdhomerun_guide",
			name: "Living Room guide",
			tunerId: "22222222-2222-2222-2222-222222222222",
			lastRefreshStatus: "error",
			lastRefreshError: message
		};
		refreshMock.mockRejectedValue(new Error(message));

		render(<EpgSection sources={[failedSource]} onChanged={() => {}} />);
		await user.click(
			screen.getByRole("button", { name: /refresh living room guide/i })
		);

		await waitFor(() => {
			expect(screen.getAllByRole("alert")).toHaveLength(1);
		});
		expect(screen.getByRole("alert")).toHaveTextContent(message);
	});

	it("requires either a URL or a file path when adding a source", async () => {
		const user = userEvent.setup();
		render(<EpgSection sources={[]} onChanged={() => {}} />);
		await user.click(screen.getByRole("button", { name: /add epg source/i }));
		await user.type(
			screen.getByPlaceholderText("My XMLTV guide"),
			"Empty source"
		);
		await user.click(screen.getByRole("button", { name: /save epg source/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/url or a file path/i
		);
		expect(createMock).not.toHaveBeenCalled();
	});

	it("triggers a refresh when the refresh action is clicked", async () => {
		const user = userEvent.setup();
		refreshMock.mockResolvedValue({
			channelsSeen: 1,
			programsSeen: 1,
			channelsUpserted: 1,
			programsUpserted: 1,
			programsInserted: 1,
			programsChanged: 0,
			programsUnchanged: 0,
			programsPruned: 0,
			durationMs: 5
		});
		const onChanged = vi.fn();
		render(<EpgSection sources={[sampleSource]} onChanged={onChanged} />);
		await user.click(
			screen.getByRole("button", { name: /refresh demo xmltv/i })
		);
		await waitFor(() => {
			expect(refreshMock).toHaveBeenCalledWith(sampleSource.id);
			expect(onChanged).toHaveBeenCalled();
		});
	});
});
