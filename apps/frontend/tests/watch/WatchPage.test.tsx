import { describe, expect, it, vi } from "vitest";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
	ChannelListItem,
	EpgGrid,
	PlayerSettings,
	Recording
} from "@signalhaven/shared";

// Short-circuit the lazy `hls.js` import so the player can mount under
// jsdom — the U7 tests exercise channel switching, not the real player.
vi.mock("../../app/_player/useHls", () => ({
	useHls: () => ({
		Hls: class UnsupportedHls {
			/** Keep watch-page tests on the native compatibility path. */
			static isSupported = () => false;
		},
		nativeHls: true,
		loadError: null,
		attempt: 0,
		reload: () => {}
	}),
	detectNativeHls: () => true
}));

import { WatchPage } from "../../app/_watch/WatchPage";
import {
	ADVANCED_MODE_STORAGE_KEY,
	AdvancedModeProvider
} from "../../app/_advanced/AdvancedModeProvider";

/**
 * Smoke / behavioural tests for the U7-watch live watch page.
 *
 * The expensive bits (HLS playback, settings + EPG fetches) are short-
 * circuited by injecting fixtures + an `initialPlayerSettings` override
 * so the test renders synchronously without the network. The focus is
 * on the U7-specific wiring: layout, channel switching (keyboard +
 * on-screen), and inline record actions.
 */

const CHANNEL_A = "00000000-0000-4000-8000-000000000001";
const CHANNEL_B = "00000000-0000-4000-8000-000000000002";
const CHANNEL_C = "00000000-0000-4000-8000-000000000003";

const NOW = new Date("2026-01-01T12:00:00Z");

function buildChannel(
	id: string,
	number: string,
	name: string
): ChannelListItem {
	return {
		id,
		number,
		name,
		logoUrl: null,
		tvgId: null,
		tunerId: "11111111-1111-4111-8111-111111111111",
		tunerName: "Tuner",
		tunerKind: "hdhomerun",
		enabled: true,
		sortOrder: Number.parseInt(number, 10),
		hasMapping: true
	};
}

const channels: ChannelListItem[] = [
	buildChannel(CHANNEL_A, "5", "Alpha"),
	buildChannel(CHANNEL_B, "6", "Bravo"),
	buildChannel(CHANNEL_C, "7", "Charlie")
];

const grid: EpgGrid = {
	from: "2026-01-01T11:00:00Z",
	to: "2026-01-01T17:00:00Z",
	channels: channels.map((c) => ({
		id: c.id,
		number: c.number,
		name: c.name,
		logoUrl: null,
		hasMapping: true
	})),
	programs: [
		{
			id: "p-a-now",
			channelId: CHANNEL_A,
			start: "2026-01-01T11:30:00Z",
			stop: "2026-01-01T12:30:00Z",
			title: "Alpha Now Show",
			subtitle: "Pilot",
			recordingId: null,
			recordingStatus: null
		},
		{
			id: "p-a-next",
			channelId: CHANNEL_A,
			start: "2026-01-01T12:30:00Z",
			stop: "2026-01-01T13:30:00Z",
			title: "Alpha Next Show",
			subtitle: null,
			recordingId: null,
			recordingStatus: null
		},
		{
			id: "p-b-now",
			channelId: CHANNEL_B,
			start: "2026-01-01T11:30:00Z",
			stop: "2026-01-01T12:30:00Z",
			title: "Bravo Now Show",
			subtitle: null,
			recordingId: null,
			recordingStatus: null
		}
	]
};

const playerSettings: PlayerSettings = {
	volume: 1,
	muted: false,
	captionsEnabled: false,
	qualityByChannel: {}
};

/** Builds the API response returned after scheduling the current program. */
function scheduledRecording(): Recording {
	return {
		id: "99999999-9999-4999-8999-999999999999",
		channelId: CHANNEL_A,
		programId: "88888888-8888-4888-8888-888888888888",
		title: "Alpha Now Show",
		status: "scheduled",
		scheduledStart: "2026-01-01T11:30:00Z",
		scheduledEnd: "2026-01-01T12:30:00Z",
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

function renderPage(
	overrides: Partial<React.ComponentProps<typeof WatchPage>> = {}
) {
	return render(
		<WatchPage
			initialChannelId={CHANNEL_A}
			initialChannels={channels}
			initialGrid={grid}
			initialFavorites={[CHANNEL_B]}
			initialPlayerSettings={playerSettings}
			nowOverride={NOW}
			onChannelChange={() => {}}
			{...overrides}
		/>
	);
}

describe("WatchPage", () => {
	it("renders the player and the now/next + switcher + mini-guide panels", () => {
		renderPage();
		expect(screen.getByTestId("watch-page")).toBeInTheDocument();
		expect(screen.getByTestId("player")).toBeInTheDocument();
		const startup = within(screen.getByTestId("player-loading"));
		expect(startup.getByText("5 · Alpha")).toBeVisible();
		expect(startup.getByText("Alpha Now Show")).toBeVisible();
		const desktop = within(screen.getByTestId("watch-desktop"));
		expect(desktop.getByTestId("watch-now-next")).toBeInTheDocument();
		expect(desktop.getByTestId("watch-switcher")).toBeInTheDocument();
		expect(desktop.getByTestId("watch-mini-guide")).toBeInTheDocument();

		// Now playing surfaces the current program + channel info.
		const nowNext = within(desktop.getByTestId("watch-now-next"));
		expect(nowNext.getByText("Alpha Now Show")).toBeInTheDocument();
		expect(nowNext.getByText(/Up next:/)).toBeInTheDocument();
	});

	it("PageDown switches to the next channel and notifies onChannelChange", async () => {
		const onChannelChange = vi.fn();
		renderPage({ onChannelChange });

		fireEvent.keyDown(window, { key: "PageDown" });
		await waitFor(() => {
			expect(onChannelChange).toHaveBeenCalled();
		});
		// Favorites first → CHANNEL_B is index 0; CHANNEL_A is index 1; PgDn → CHANNEL_C.
		expect(onChannelChange).toHaveBeenLastCalledWith(CHANNEL_C);
	});

	it("PageUp wraps backward through the favorites-first order", async () => {
		const onChannelChange = vi.fn();
		renderPage({ onChannelChange });

		fireEvent.keyDown(window, { key: "PageUp" });
		await waitFor(() => {
			expect(onChannelChange).toHaveBeenCalled();
		});
		// Order is [B (fav), A, C]; current=A; PgUp → B.
		expect(onChannelChange).toHaveBeenLastCalledWith(CHANNEL_B);
	});

	it("clicking a channel chip switches the channel", async () => {
		const user = userEvent.setup();
		const onChannelChange = vi.fn();
		renderPage({ onChannelChange });

		const desktop = within(screen.getByTestId("watch-desktop"));
		await user.click(desktop.getByTestId(`watch-channel-${CHANNEL_C}`));
		expect(onChannelChange).toHaveBeenCalledWith(CHANNEL_C);
		// Now playing updates to the new channel even without a re-fetch.
		const nowNext = within(desktop.getByTestId("watch-now-next"));
		expect(nowNext.getByText("Charlie")).toBeInTheDocument();
	});

	it("toggles the current channel favorite from the now-playing panel", async () => {
		const user = userEvent.setup();
		const persistChannelPreferences = vi.fn().mockResolvedValue(undefined);
		renderPage({
			initialFavorites: [],
			persistChannelPreferences
		});

		const desktop = within(screen.getByTestId("watch-desktop"));
		const favoriteButton = desktop.getByRole("button", {
			name: "Add Alpha to favorites"
		});
		expect(favoriteButton).toHaveAttribute("aria-pressed", "false");

		await user.click(favoriteButton);

		const removeFavoriteButton = desktop.getByRole("button", {
			name: "Remove Alpha from favorites"
		});
		expect(removeFavoriteButton).toHaveAttribute("aria-pressed", "true");
		expect(persistChannelPreferences).toHaveBeenCalledWith({
			favorites: [CHANNEL_A],
			hidden: [],
			order: []
		});
		await waitFor(() => expect(removeFavoriteButton).toBeEnabled());
		expect(removeFavoriteButton).toHaveAttribute("aria-pressed", "true");

		await user.click(removeFavoriteButton);

		expect(
			desktop.getByRole("button", { name: "Add Alpha to favorites" })
		).toHaveAttribute("aria-pressed", "false");
		expect(persistChannelPreferences).toHaveBeenLastCalledWith({
			favorites: [],
			hidden: [],
			order: []
		});
	});

	it("restores the favorite state when saving fails", async () => {
		const user = userEvent.setup();
		const persistChannelPreferences = vi
			.fn()
			.mockRejectedValue(new Error("Settings service unavailable"));
		renderPage({
			initialFavorites: [],
			persistChannelPreferences
		});

		const desktop = within(screen.getByTestId("watch-desktop"));
		await user.click(
			desktop.getByRole("button", { name: "Add Alpha to favorites" })
		);

		expect(await screen.findByTestId("watch-favorite-error")).toHaveTextContent(
			/check your connection and try again/i
		);
		expect(
			desktop.getByRole("button", { name: "Add Alpha to favorites" })
		).toHaveAttribute("aria-pressed", "false");
	});

	it("the on-screen channel-up button steps backward", async () => {
		const user = userEvent.setup();
		const onChannelChange = vi.fn();
		renderPage({ onChannelChange });

		const desktop = within(screen.getByTestId("watch-desktop"));
		await user.click(desktop.getByTestId("watch-channel-up"));
		expect(onChannelChange).toHaveBeenLastCalledWith(CHANNEL_B);
	});

	it("ignores PageUp/PageDown when the focus is in an input", async () => {
		const onChannelChange = vi.fn();
		renderPage({ onChannelChange });

		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		fireEvent.keyDown(input, { key: "PageDown" });
		expect(onChannelChange).not.toHaveBeenCalled();
		document.body.removeChild(input);
	});

	it("inline Record / Record series buttons fire the supplied callbacks", async () => {
		const user = userEvent.setup();
		const onRecord = vi.fn();
		const onRecordSeries = vi.fn();
		renderPage({ onRecord, onRecordSeries });

		const desktop = within(screen.getByTestId("watch-desktop"));
		await user.click(desktop.getByTestId("watch-record"));
		expect(onRecord).toHaveBeenCalledTimes(1);
		expect(onRecord.mock.calls[0]?.[0]?.id).toBe("p-a-now");

		await user.click(desktop.getByTestId("watch-record-series"));
		expect(onRecordSeries).toHaveBeenCalledTimes(1);
	});

	it("schedules the current program, prevents repeats, and exposes cancellation", async () => {
		const user = userEvent.setup();
		let resolveSchedule!: (recording: Recording) => void;
		const onRecord = vi.fn(
			() =>
				new Promise<Recording>((resolve) => {
					resolveSchedule = resolve;
				})
		);
		renderPage({ onRecord });

		const desktop = within(screen.getByTestId("watch-desktop"));
		const nowPanel = within(desktop.getByTestId("watch-now-next"));
		const recordButton = nowPanel.getByTestId("watch-record");
		await user.click(recordButton);

		expect(onRecord).toHaveBeenCalledTimes(1);
		expect(recordButton).toBeDisabled();
		await user.click(recordButton);
		expect(onRecord).toHaveBeenCalledTimes(1);

		resolveSchedule(scheduledRecording());
		expect(
			await nowPanel.findByRole("button", { name: /cancel recording/i })
		).toBeInTheDocument();
		expect(nowPanel.getByText("Scheduled")).toBeInTheDocument();
	});

	it("cancels a scheduled program through its recording id", async () => {
		const user = userEvent.setup();
		const recording = scheduledRecording();
		const scheduledGrid = {
			...grid,
			programs: grid.programs.map((program) =>
				program.id === "p-a-now"
					? {
							...program,
							recordingStatus: "scheduled" as const,
							recordingId: recording.id
						}
					: program
			)
		} as EpgGrid;
		const onCancel = vi.fn().mockResolvedValue({
			...recording,
			status: "cancelled" as const
		});
		renderPage({ initialGrid: scheduledGrid, onCancel });

		const desktop = within(screen.getByTestId("watch-desktop"));
		const nowPanel = within(desktop.getByTestId("watch-now-next"));
		await user.click(
			nowPanel.getByRole("button", { name: /cancel recording/i })
		);

		expect(onCancel).toHaveBeenCalledWith(recording.id, expect.any(Object));
		expect(await nowPanel.findByText("Cancelled")).toBeInTheDocument();
		expect(nowPanel.getByTestId("watch-record")).toBeEnabled();
	});

	it("restores the prior state and shows an actionable error when scheduling fails", async () => {
		const user = userEvent.setup();
		const onRecord = vi
			.fn()
			.mockRejectedValue(new Error("Recording storage is not configured"));
		renderPage({ onRecord });

		const desktop = within(screen.getByTestId("watch-desktop"));
		await user.click(desktop.getByTestId("watch-record"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/recording storage is not configured/i
		);
		expect(desktop.getByTestId("watch-record")).toBeEnabled();
	});

	it("the player is not remounted across a channel switch", async () => {
		const user = userEvent.setup();
		renderPage();

		const videoBefore = screen.getByTestId("player-video");
		const desktop = within(screen.getByTestId("watch-desktop"));
		await user.click(desktop.getByTestId(`watch-channel-${CHANNEL_C}`));
		const videoAfter = screen.getByTestId("player-video");
		// Same DOM node — React kept the <video> in place, hls.loadSource
		// swapped the playlist URL underneath it.
		expect(videoAfter).toBe(videoBefore);
	});

	it("mobile layout exposes Now Playing / Up Next / Channels tabs", () => {
		renderPage();
		const mobile = within(screen.getByTestId("watch-mobile"));
		expect(mobile.getByRole("tab", { name: /now playing/i })).toBeVisible();
		expect(mobile.getByRole("tab", { name: /up next/i })).toBeVisible();
		expect(mobile.getByRole("tab", { name: /channels/i })).toBeVisible();
	});

	it("shows detailed source information from the advanced channel menu", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		const loadChannelDiagnostics = vi.fn().mockResolvedValue({
			channel: {
				id: CHANNEL_A,
				number: "5",
				name: "Alpha",
				logoUrl: null,
				tvgId: "alpha.example",
				enabled: true,
				sortOrder: 5,
				mappedEpgChannelId: "77777777-7777-4777-8777-777777777777"
			},
			sources: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					tunerId: "11111111-1111-4111-8111-111111111111",
					tunerName: "Living Room IPTV",
					tunerKind: "iptv",
					number: "5",
					name: "Alpha source",
					tvgId: "alpha.example",
					enabled: true,
					status: "active",
					priority: 0,
					preferred: true,
					storedProviderChannelId: "alpha-stream",
					resolvedProviderChannelId: "alpha-stream",
					streamUrl: "https://streams.example.test/live/alpha.m3u8",
					httpHeaders: { referer: "https://guide.example.test" },
					error: null
				}
			],
			checkedAt: "2026-01-01T12:00:00.000Z"
		});

		render(
			<AdvancedModeProvider>
				<WatchPage
					initialChannelId={CHANNEL_A}
					initialChannels={channels}
					initialGrid={grid}
					initialPlayerSettings={playerSettings}
					nowOverride={NOW}
					onChannelChange={() => {}}
					loadChannelDiagnostics={loadChannelDiagnostics}
				/>
			</AdvancedModeProvider>
		);

		const desktop = within(screen.getByTestId("watch-desktop"));
		const menuButton = await desktop.findByRole("button", {
			name: "More channel actions"
		});
		await user.click(menuButton);
		await user.click(desktop.getByRole("menuitem", { name: "More Info" }));

		expect(
			await screen.findByRole("dialog", { name: "Channel information" })
		).toBeVisible();
		expect(
			screen.getByText("https://streams.example.test/live/alpha.m3u8")
		).toBeVisible();
		expect(screen.getByText("Living Room IPTV")).toBeVisible();
		expect(screen.getAllByText("alpha-stream")).toHaveLength(2);
		expect(loadChannelDiagnostics).toHaveBeenCalledWith(CHANNEL_A);

		await user.click(screen.getByRole("button", { name: "Close dialog" }));
		expect(menuButton).toHaveFocus();
	});

	it("keeps channel diagnostics hidden when advanced mode is disabled", () => {
		renderPage();
		expect(
			screen.queryByRole("button", { name: "More channel actions" })
		).not.toBeInTheDocument();
	});
});
