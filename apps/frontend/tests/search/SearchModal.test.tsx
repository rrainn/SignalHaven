import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchResponse } from "@signalhaven/shared";

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

import { SearchModal } from "../../app/_search/SearchModal";

function buildResponse(): SearchResponse {
	return {
		q: "law",
		channels: [
			{
				kind: "channel",
				id: "10000000-0000-4000-8000-000000000001",
				number: "12.1",
				name: "FOX News",
				logoUrl: null,
				score: 0.9
			}
		],
		programs: [
			{
				kind: "program",
				id: "20000000-0000-4000-8000-000000000001",
				title: "Law and Order",
				subtitle: null,
				start: "2099-01-01T01:00:00.000Z",
				stop: "2099-01-01T02:00:00.000Z",
				channelId: "10000000-0000-4000-8000-000000000001",
				channelName: "FOX News",
				channelNumber: "12.1",
				score: 0.5
			}
		],
		recordings: [
			{
				kind: "recording",
				id: "30000000-0000-4000-8000-000000000001",
				title: "Law in America",
				status: "completed",
				scheduledStart: "2099-02-01T01:00:00.000Z",
				channelId: "10000000-0000-4000-8000-000000000001",
				channelName: "FOX News",
				channelNumber: "12.1",
				programId: null,
				score: 0.3
			}
		]
	};
}

describe("SearchModal", () => {
	beforeEach(() => {
		pushMock.mockReset();
	});

	it("keeps the results tray hidden until a search has content", async () => {
		const searchFn = vi.fn(async () => buildResponse());

		render(
			<SearchModal
				open
				onOpenChange={vi.fn()}
				searchOptions={{ searchFn, debounceMs: 0 }}
			/>
		);

		// An untouched search should be a compact input instead of an empty tray.
		await screen.findByPlaceholderText(/search channels/i);
		expect(
			screen.queryByRole("listbox", { name: "Search results" })
		).toBeNull();
	});

	it("renders grouped results from the searchFn after typing", async () => {
		const user = userEvent.setup();
		const searchFn = vi.fn(async () => buildResponse());
		const onOpenChange = vi.fn();

		render(
			<SearchModal
				open
				onOpenChange={onOpenChange}
				searchOptions={{ searchFn, debounceMs: 0 }}
			/>
		);

		const input = await screen.findByPlaceholderText(/search channels/i);
		await user.type(input, "law");

		await screen.findByText("FOX News");
		expect(screen.getByText("Law and Order")).toBeInTheDocument();
		expect(screen.getByText("Law in America")).toBeInTheDocument();
	});

	it("supports arrow-key navigation and Enter to select", async () => {
		const user = userEvent.setup();
		const searchFn = vi.fn(async () => buildResponse());
		const onOpenChange = vi.fn();

		render(
			<SearchModal
				open
				onOpenChange={onOpenChange}
				searchOptions={{ searchFn, debounceMs: 0 }}
			/>
		);

		const input = await screen.findByPlaceholderText(/search channels/i);
		await user.type(input, "law");
		await screen.findByText("Law and Order");

		// First option (channel) is selected by default.
		const firstOption = screen.getAllByRole("option")[0];
		expect(firstOption).toHaveAttribute("aria-selected", "true");

		// Arrow down moves to the next option (the program).
		await user.keyboard("{ArrowDown}");
		const secondOption = screen.getAllByRole("option")[1];
		expect(secondOption).toHaveAttribute("aria-selected", "true");

		// Enter activates it: future programs open their details instead of
		// jumping directly into an unrelated live stream.
		await user.keyboard("{Enter}");
		expect(pushMock).toHaveBeenCalledWith(
			"/programs/20000000-0000-4000-8000-000000000001?returnTo=%2Fguide%3Fat%3D2099-01-01T01%253A00%253A00.000Z%26channel%3D10000000-0000-4000-8000-000000000001"
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

// Extra import so beforeEach is in scope without polluting the test
// list (Vitest auto-imports via globals: true in vitest.config.ts).
