import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChannelsPage } from "../../app/_channels/ChannelsPage";
import { buildChannelsFixture } from "../../app/_channels/fixtures";

/**
 * Smoke / behavioural tests for the channels list page wiring. Pure
 * reducer logic is covered by `state.test.ts`; this file checks the
 * happy-path render plus the two persistence-touching flows
 * (favoriting and bulk-hide) so a regression in the dispatch wiring
 * doesn't slip past the reducer tests.
 */

describe("ChannelsPage", () => {
	it("renders one row per channel from the fixture", () => {
		render(<ChannelsPage initialChannels={buildChannelsFixture()} />);
		const rows = screen.getAllByTestId("channel-row");
		expect(rows.length).toBe(buildChannelsFixture().length);
	});

	it("links each channel identity to its live feed", () => {
		const fixture = buildChannelsFixture();
		const channel = fixture[0]!;
		render(<ChannelsPage initialChannels={fixture} />);

		const link = screen.getByRole("link", {
			name: `Watch ${channel.number} ${channel.name}`
		});
		expect(link).toHaveAttribute(
			"href",
			`/watch/${encodeURIComponent(channel.id)}`
		);
	});

	it("favoriting a channel persists prefs via the injected hook", async () => {
		const user = userEvent.setup();
		const persistPrefs = vi.fn().mockResolvedValue(undefined);
		const fixture = buildChannelsFixture();
		render(
			<ChannelsPage initialChannels={fixture} persistPrefs={persistPrefs} />
		);

		const favBtn = screen.getByTestId(`favorite-${fixture[0]!.id}`);
		await user.click(favBtn);

		// Wait for the persistence effect to flush.
		expect(persistPrefs).toHaveBeenCalled();
		const calls = persistPrefs.mock.calls;
		const lastCall = calls[calls.length - 1];
		expect(lastCall?.[0]?.favorites).toEqual([fixture[0]!.id]);
	});

	it("bulk-hide hides every selected channel and clears the selection", async () => {
		const user = userEvent.setup();
		const persistPrefs = vi.fn().mockResolvedValue(undefined);
		const fixture = buildChannelsFixture();
		render(
			<ChannelsPage initialChannels={fixture} persistPrefs={persistPrefs} />
		);

		// Select the first two visible rows.
		const rows = screen.getAllByTestId("channel-row");
		for (const row of rows.slice(0, 2)) {
			const checkbox = within(row).getByRole("checkbox");
			await user.click(checkbox);
		}

		const bulkBar = screen.getByTestId("bulk-action-bar");
		await user.click(within(bulkBar).getByRole("button", { name: /^Hide$/ }));

		// Bar disappears (selection cleared) and rows reduce by 2.
		expect(screen.queryByTestId("bulk-action-bar")).not.toBeInTheDocument();
		expect(screen.getAllByTestId("channel-row").length).toBe(
			fixture.length - 2
		);

		const calls = persistPrefs.mock.calls;
		const lastCall = calls[calls.length - 1];
		expect(lastCall?.[0]?.hidden.length).toBe(2);
	});

	it("merges selected channels into one expandable source group", async () => {
		const user = userEvent.setup();
		const fixture = buildChannelsFixture();
		const [primary, backup] = fixture;
		const merged = {
			...primary!,
			sources: [
				...(primary!.sources ?? []),
				...(backup!.sources ?? []).map((source) => ({
					...source,
					preferred: false,
					priority: 1
				}))
			],
			availableSourceCount: 2
		};
		const mergeGroups = vi
			.fn()
			.mockResolvedValue([merged, ...fixture.slice(2)]);
		render(
			<ChannelsPage initialChannels={fixture} mergeGroups={mergeGroups} />
		);

		for (const row of screen.getAllByTestId("channel-row").slice(0, 2)) {
			await user.click(within(row).getByRole("checkbox"));
		}
		await user.click(screen.getByRole("button", { name: "Merge sources" }));
		const dialog = screen.getByRole("dialog", {
			name: "Merge channel sources"
		});
		expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
		await user.click(
			within(dialog).getByRole("button", { name: "Merge 2 channels" })
		);

		expect(mergeGroups).toHaveBeenCalledWith(
			[primary!.id, backup!.id],
			primary!.id
		);
		expect(screen.getAllByTestId("channel-row")).toHaveLength(
			fixture.length - 1
		);
		expect(screen.getByRole("button", { name: "2 sources" })).toBeVisible();
	});

	it("lets users promote a healthy fallback source", async () => {
		const user = userEvent.setup();
		const [primary, backup] = buildChannelsFixture();
		const grouped = {
			...primary!,
			sources: [
				primary!.sources![0]!,
				{
					...backup!.sources![0]!,
					preferred: false,
					priority: 1
				}
			],
			availableSourceCount: 2
		};
		const preferSource = vi.fn().mockResolvedValue([grouped]);
		render(
			<ChannelsPage initialChannels={[grouped]} preferSource={preferSource} />
		);

		await user.click(screen.getByRole("button", { name: "2 sources" }));
		await user.click(screen.getByRole("button", { name: "Make preferred" }));

		expect(preferSource).toHaveBeenCalledWith(
			primary!.id,
			backup!.sources![0]!.id
		);
	});

	it("lets users separate a source without deleting it", async () => {
		const user = userEvent.setup();
		const [primary, backup] = buildChannelsFixture();
		const grouped = {
			...primary!,
			sources: [
				primary!.sources![0]!,
				{
					...backup!.sources![0]!,
					preferred: false,
					priority: 1
				}
			],
			availableSourceCount: 2
		};
		const splitSource = vi.fn().mockResolvedValue([primary!, backup!]);
		render(
			<ChannelsPage initialChannels={[grouped]} splitSource={splitSource} />
		);

		await user.click(screen.getByRole("button", { name: "2 sources" }));
		const separateButtons = screen.getAllByRole("button", { name: "Separate" });
		await user.click(separateButtons[1]!);

		expect(splitSource).toHaveBeenCalledWith(
			primary!.id,
			backup!.sources![0]!.id
		);
		expect(await screen.findAllByTestId("channel-row")).toHaveLength(2);
	});

	it("warns when a channel preference change cannot be persisted", async () => {
		const user = userEvent.setup();
		const fixture = buildChannelsFixture();
		const persistPrefs = vi
			.fn()
			.mockRejectedValue(new Error("Database offline"));
		render(
			<ChannelsPage initialChannels={fixture} persistPrefs={persistPrefs} />
		);

		await user.click(screen.getByTestId(`favorite-${fixture[0]!.id}`));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/could not save channel preferences/i
		);
	});

	// Concurrent coverage work can make this intentionally large fixture exceed Vitest's default timeout.
	it("bounds the initial render for large channel lineups", async () => {
		const user = userEvent.setup();
		const seed = buildChannelsFixture()[0]!;
		const channels = Array.from({ length: 1_000 }, (_, index) => ({
			...seed,
			id: `channel-${index}`,
			number: String(index + 1),
			name: `Channel ${index + 1}`,
			sortOrder: index
		}));

		render(<ChannelsPage initialChannels={channels} />);

		// A large lineup must not create every interactive row during page load.
		expect(screen.getAllByTestId("channel-row")).toHaveLength(100);
		expect(screen.getByTestId("channels-render-summary")).toHaveTextContent(
			/100.*1,000/
		);

		await user.click(
			screen.getByRole("checkbox", { name: "Select all matching channels" })
		);
		expect(
			screen.getByText("Select all 1,000 matching channels")
		).toBeVisible();
		expect(screen.getByTestId("bulk-action-bar")).toHaveTextContent(
			"1000 selected"
		);

		await user.click(screen.getByTestId("channels-load-more"));

		expect(screen.getAllByTestId("channel-row")).toHaveLength(200);

		// Filtering still searches the complete lineup, including unmounted rows.
		// Submit the final value once so this lineup test does not benchmark keystrokes.
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "Channel 999" }
		});
		expect(screen.getAllByTestId("channel-row")).toHaveLength(1);
		expect(
			screen.getByRole("link", { name: "Watch 999 Channel 999" })
		).toBeVisible();
	}, 15_000);
});
