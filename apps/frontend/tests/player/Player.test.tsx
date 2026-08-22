import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within
} from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";

import { Player } from "../../app/_player/Player";
import type { HlsModule } from "../../app/_player/useHls";
import {
	ADVANCED_MODE_STORAGE_KEY,
	AdvancedModeProvider
} from "../../app/_advanced/AdvancedModeProvider";

/**
 * Behavioural tests for the U6 player. We replace the real hls.js
 * runtime with a duck-typed stub so jsdom doesn't have to handle MSE,
 * and we drive the `<video>` element through synthesized events. The
 * tests focus on:
 *   - Custom controls wiring (play/pause, mute, captions, quality, AirPlay,
 *     PiP, fullscreen).
 *   - Keyboard shortcuts.
 *   - Persistence of volume / mute / captions / quality back through
 *     the `onPersist` hook.
 *
 * Real video playback + actual segment fetches are exercised by the
 * Playwright e2e suite, not here.
 */

interface FakeHlsInstance {
	attachMedia: ReturnType<typeof vi.fn>;
	loadSource: ReturnType<typeof vi.fn>;
	stopLoad: ReturnType<typeof vi.fn>;
	recoverMediaError: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	latency?: number;
	liveSyncPosition?: number | null;
	bandwidthEstimate?: number;
	currentLevel?: number;
	levels?: Array<{ bitrate?: number; width?: number; height?: number }>;
}

const fakeInstances: FakeHlsInstance[] = [];
const fakeConfigs: unknown[] = [];

class FakeHls implements FakeHlsInstance {
	static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
	static ErrorTypes = { MEDIA_ERROR: "mediaError" };
	static isSupported = vi.fn(() => true);
	attachMedia = vi.fn();
	loadSource = vi.fn();
	stopLoad = vi.fn();
	recoverMediaError = vi.fn();
	destroy = vi.fn();
	on = vi.fn();
	latency = 4.25;
	liveSyncPosition: number | null = 119.5;
	bandwidthEstimate = 12_000_000;
	currentLevel = 0;
	levels = [{ bitrate: 8_000_000, width: 1920, height: 1080 }];
	constructor(config?: unknown) {
		fakeConfigs.push(config);
		fakeInstances.push(this);
	}
}

const FakeHlsCtor = FakeHls as unknown as HlsModule;

// Let engine-selection tests load the same controllable player double that the
// explicit constructor seam uses in the rest of this suite.
vi.mock("hls.js", () => ({ default: FakeHlsCtor }));

const CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

function renderPlayer(
	overrides: Partial<React.ComponentProps<typeof Player>> = {}
) {
	return render(
		<Player
			channelId={CHANNEL_ID}
			hlsCtorOverride={FakeHlsCtor}
			{...overrides}
		/>
	);
}

/** Assert the observable channel/profile contract without coupling to its random viewer id. */
function expectLiveSource(
	source: string,
	channelId: string,
	profile: string | null
): string {
	const sourceUrl = new URL(source, "http://localhost");
	expect(sourceUrl.pathname).toBe(`/api/v1/stream/${channelId}/master.m3u8`);
	expect(sourceUrl.searchParams.get("profile")).toBe(profile);
	const viewerId = sourceUrl.searchParams.get("viewerId");
	expect(viewerId).toMatch(/^[0-9a-f-]{36}$/i);
	return viewerId!;
}

beforeEach(() => {
	vi.restoreAllMocks();
	fakeInstances.length = 0;
	fakeConfigs.length = 0;
	FakeHls.isSupported.mockReturnValue(true);
});

describe("Player", () => {
	it("hydrates live playback before creating its client viewer identity", async () => {
		const serverViewerId = "11111111-1111-4111-8111-111111111111";
		const clientViewerId = "22222222-2222-4222-8222-222222222222";
		let renderPhase: "server" | "client" = "server";
		const viewerIdPhases: Array<"server" | "client"> = [];
		vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
			viewerIdPhases.push(renderPhase);
			return renderPhase === "server" ? serverViewerId : clientViewerId;
		});
		const view = (
			<Player channelId={CHANNEL_ID} hlsCtorOverride={FakeHlsCtor} />
		);
		const container = document.createElement("div");
		container.innerHTML = renderToString(view);
		document.body.append(container);
		renderPhase = "client";
		const hydrationErrors: unknown[] = [];
		let root: Root | null = null;

		try {
			await act(async () => {
				root = hydrateRoot(container, view, {
					onRecoverableError: (error) => hydrationErrors.push(error)
				});
				await Promise.resolve();
			});
			await waitFor(() => expect(fakeInstances).toHaveLength(1));

			// SSR must not allocate an identity that differs from the hydrated tree.
			expect(viewerIdPhases).toEqual(["client"]);
			expect(hydrationErrors).toEqual([]);
			const sources = fakeInstances[0]!.loadSource.mock.calls.map(
				([source]) => source as string
			);
			expect(sources).toHaveLength(1);
			expectLiveSource(sources[0]!, CHANNEL_ID, "original-quality");
			expect(
				new URL(sources[0]!, "http://localhost").searchParams.get("viewerId")
			).toBe(clientViewerId);
		} finally {
			await act(async () => root?.unmount());
			container.remove();
		}
	});

	it("uses a browser-safe profile in Auto mode and releases it on unmount", () => {
		const sendBeacon = vi.fn(() => true);
		Object.defineProperty(navigator, "sendBeacon", {
			configurable: true,
			value: sendBeacon
		});
		const { unmount } = renderPlayer();
		expect(fakeInstances.length).toBe(1);
		const instance = fakeInstances[0]!;
		expect(instance.attachMedia).toHaveBeenCalled();
		const source = instance.loadSource.mock.calls[0]?.[0] as string;
		const viewerId = expectLiveSource(source, CHANNEL_ID, "original-quality");

		unmount();
		expect(sendBeacon).toHaveBeenCalledWith(
			`/api/v1/stream/${CHANNEL_ID}/viewers/${viewerId}/release?profile=original-quality`
		);
	});

	it("keeps a larger live-edge cushion for transient delivery jitter", () => {
		renderPlayer();

		expect(fakeConfigs[0]).toEqual({
			liveSyncDuration: 6,
			liveMaxLatencyDuration: 18,
			liveSyncOnStallIncrease: 2,
			maxLiveSyncPlaybackRate: 1.05,
			abrBandWidthFactor: 0.8,
			abrBandWidthUpFactor: 0.65
		});
	});

	it("prefers hls.js when Safari supports both playback engines", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
			"probably"
		);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		render(<Player channelId={CHANNEL_ID} />);
		const video = screen.getByTestId("player-video") as HTMLVideoElement;

		await waitFor(() => expect(fakeInstances).toHaveLength(1));
		expect(FakeHls.isSupported).toHaveBeenCalled();
		expect(fakeInstances[0]?.attachMedia).toHaveBeenCalledWith(video);
		expectLiveSource(
			fakeInstances[0]?.loadSource.mock.calls[0]?.[0] as string,
			CHANNEL_ID,
			"original-quality"
		);
		expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();
	});

	it("falls back to native HLS when hls.js is unsupported", async () => {
		FakeHls.isSupported.mockReturnValue(false);
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
			"probably"
		);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		render(<Player channelId={CHANNEL_ID} />);
		const video = screen.getByTestId("player-video") as HTMLVideoElement;

		await waitFor(() => expect(FakeHls.isSupported).toHaveBeenCalled());
		expect(fakeInstances).toHaveLength(0);
		expectLiveSource(video.src, CHANNEL_ID, "original-quality");
	});

	it("explains when neither HLS playback engine is supported", async () => {
		FakeHls.isSupported.mockReturnValue(false);
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
		render(<Player channelId={CHANNEL_ID} />);

		expect(
			await screen.findByText(/This browser can't play this stream/i)
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		expect(fakeInstances).toHaveLength(0);
	});

	it("exhausts bounded automatic media recovery before asking the user", () => {
		vi.useFakeTimers();
		try {
			renderPlayer();
			const instance = fakeInstances[0]!;
			const errorHandler = instance.on.mock.calls.find(
				([event]) => event === FakeHls.Events.ERROR
			)?.[1] as ((event: unknown, data: unknown) => void) | undefined;
			expect(errorHandler).toBeDefined();

			// Safari can surface its underlying decode failure as bufferAppendError.
			act(() => {
				errorHandler?.(undefined, {
					fatal: true,
					type: FakeHls.ErrorTypes.MEDIA_ERROR,
					details: "bufferAppendError"
				});
			});

			expect(instance.recoverMediaError).toHaveBeenCalledOnce();
			expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();

			// A second failure retries after a short cooldown without interrupting.
			act(() => {
				errorHandler?.(undefined, {
					fatal: true,
					type: FakeHls.ErrorTypes.MEDIA_ERROR,
					details: "bufferAppendError"
				});
				vi.advanceTimersByTime(1_000);
			});

			expect(instance.recoverMediaError).toHaveBeenCalledTimes(2);
			expect(instance.loadSource).toHaveBeenCalledTimes(1);
			expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();

			// Only a failure after both attempts requires explicit user action.
			act(() => {
				errorHandler?.(undefined, {
					fatal: true,
					type: FakeHls.ErrorTypes.MEDIA_ERROR,
					details: "bufferAppendError"
				});
			});

			expect(instance.recoverMediaError).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("player-error")).toBeInTheDocument();

			instance.loadSource.mockClear();
			fireEvent.click(screen.getByRole("button", { name: "Try again" }));

			expect(instance.recoverMediaError).toHaveBeenCalledTimes(3);
			expect(instance.loadSource).not.toHaveBeenCalled();
			expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps fatal HLS diagnostics out of the player error copy", () => {
		renderPlayer();
		const instance = fakeInstances[0]!;
		const errorHandler = instance.on.mock.calls.find(
			([event]) => event === FakeHls.Events.ERROR
		)?.[1] as ((event: unknown, data: unknown) => void) | undefined;
		expect(errorHandler).toBeDefined();

		// HLS.js details can include internal request and media diagnostics.
		act(() => {
			errorHandler?.(undefined, {
				fatal: true,
				details: "manifestLoadError http://viewer:secret@192.168.1.20/live"
			});
		});

		expect(
			screen.getByText(/Playback stopped.*Quality to Auto/i)
		).toBeInTheDocument();
		expect(screen.queryByText(/192\.168\.1\.20|viewer|secret/)).toBeNull();
	});

	it("offers Extra Stats from the video context menu in advanced mode", async () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		render(
			<AdvancedModeProvider>
				<Player channelId={CHANNEL_ID} hlsCtorOverride={FakeHlsCtor} />
			</AdvancedModeProvider>
		);
		const player = screen.getByTestId("player");

		await act(async () => undefined);
		fireEvent.contextMenu(player, { clientX: 20, clientY: 20 });
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Show Extra Stats" })
		);
		fireEvent.contextMenu(player, { clientX: 20, clientY: 20 });

		expect(
			await screen.findByRole("menuitem", { name: "Hide Extra Stats" })
		).toBeInTheDocument();
	});

	it("explains playback health with distinct and contextual extra stats", async () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("/quality")) {
				return new Response(
					JSON.stringify({
						channelId: CHANNEL_ID,
						active: true,
						checkedAt: "2026-07-24T12:01:26.400Z",
						signalStrengthPercent: 88,
						signalQualityPercent: 76,
						symbolQualityPercent: 100,
						networkRateMbps: 9.4
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			}
			return new Response(
				JSON.stringify({
					channelId: CHANNEL_ID,
					profile: "original-quality",
					playbackMode: "manual",
					availableProfiles: ["auto", "original-quality", "720p", "480p"],
					activeRendition: "original-quality",
					capacity: {
						status: "not-applicable",
						requiredSpeed: null,
						measuredSpeed: null
					},
					hwaccel: null,
					state: "lingering",
					startedAt: "2026-07-24T12:00:00.000Z",
					refCount: 0,
					timeShift: {
						enabled: true,
						windowSeconds: 3_600,
						bufferBytes: 64 * 1_048_576,
						maxBufferBytes: 10 * 1_024 ** 3
					},
					lastError: null,
					pipeline: {
						mode: "transcode",
						health: "slow",
						speed: 0.72,
						fps: 21.6,
						outputTimeSeconds: 86.4,
						lastProgressAt: "2026-07-24T12:01:26.400Z",
						progressAgeSeconds: 0.4
					}
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		});
		try {
			render(
				<AdvancedModeProvider>
					<Player channelId={CHANNEL_ID} hlsCtorOverride={FakeHlsCtor} />
				</AdvancedModeProvider>
			);
			const video = screen.getByTestId("player-video") as HTMLVideoElement;
			let totalVideoFrames = 1_000;
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => 100
			});
			Object.defineProperty(video, "buffered", {
				configurable: true,
				get: () => ({ length: 1, start: () => 95, end: () => 112 })
			});
			Object.defineProperty(video, "seekable", {
				configurable: true,
				get: () => ({ length: 1, start: () => 40, end: () => 112 })
			});
			video.getVideoPlaybackQuality = () => ({
				creationTime: 0,
				corruptedVideoFrames: 0,
				droppedVideoFrames: 25,
				totalVideoFrames
			});

			fireEvent.contextMenu(screen.getByTestId("player"), {
				clientX: 20,
				clientY: 20
			});
			vi.useFakeTimers();
			fireEvent.click(
				screen.getByRole("menuitem", { name: "Show Extra Stats" })
			);
			await act(async () => {
				totalVideoFrames = 1_060;
				vi.advanceTimersByTime(2_000);
				// Let the status response update the backend-derived rows.
				await Promise.resolve();
			});

			const stats = screen.getByTestId("player-extra-stats");
			expect(stats).toHaveTextContent("Buffer ahead");
			expect(stats).toHaveTextContent("Stream bitrate");
			expect(stats).toHaveTextContent("8.00 Mbps");
			expect(stats).toHaveTextContent("Connection estimate");
			expect(stats).toHaveTextContent("12.00 Mbps");
			expect(stats).toHaveTextContent("12.0 s");
			expect(stats).toHaveTextContent("Behind live");
			expect(stats).toHaveTextContent("4.3 s");
			expect(stats).toHaveTextContent("Dropped frames");
			expect(stats).toHaveTextContent("25 / 1060 (2.4%)");
			expect(stats).toHaveTextContent("Server status");
			expect(stats).toHaveTextContent("Idle (kept warm)");
			expect(stats).toHaveTextContent("Pipeline health");
			expect(stats).toHaveTextContent("Slow · 0.72× · 21.6 FPS");
			expect(stats).toHaveTextContent("Tuner/source");
			expect(stats).toHaveTextContent("Strength 88% · Quality 76%");
			expect(stats).toHaveTextContent("Live rewind");
			expect(stats).toHaveTextContent("Up to 1 hr · 64.0 MiB on disk");
			expect(stats).toHaveTextContent("30.0");

			await act(async () => {
				// A one-sample spike to 45 FPS is damped instead of flashing raw.
				totalVideoFrames = 1_150;
				vi.advanceTimersByTime(2_000);
				await Promise.resolve();
			});
			expect(stats).toHaveTextContent("33.8");

			await act(async () => {
				// Buffering does not redefine the source as a zero-FPS video.
				vi.advanceTimersByTime(2_000);
				await Promise.resolve();
			});
			expect(stats).toHaveTextContent("33.8");
		} finally {
			vi.useRealTimers();
		}
	});

	it("summarizes completed buffering events in extra stats", () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		vi.useFakeTimers();
		try {
			render(
				<AdvancedModeProvider>
					<Player
						channelId={CHANNEL_ID}
						isRecording
						hlsCtorOverride={FakeHlsCtor}
					/>
				</AdvancedModeProvider>
			);
			const video = screen.getByTestId("player-video");

			// Startup waiting is load time, while duplicate waiting events belong
			// to the same continuous playback interruption.
			fireEvent.waiting(video);
			fireEvent.playing(video);
			fireEvent.waiting(video);
			fireEvent.waiting(video);
			act(() => vi.advanceTimersByTime(1_000));
			fireEvent.playing(video);
			fireEvent.waiting(video);
			act(() => vi.advanceTimersByTime(3_000));
			fireEvent.playing(video);

			fireEvent.contextMenu(screen.getByTestId("player"), {
				clientX: 20,
				clientY: 20
			});
			fireEvent.click(
				screen.getByRole("menuitem", { name: "Show Extra Stats" })
			);

			const stats = screen.getByTestId("player-extra-stats");
			expect(stats).toHaveTextContent("Buffer events");
			expect(stats).toHaveTextContent("2 · Avg 2.0 s · Min 1.0 s · Max 3.0 s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("swaps the playlist URL on quality change without re-creating the Hls instance", async () => {
		const user = userEvent.setup();
		renderPlayer();
		expect(fakeInstances.length).toBe(1);
		const instance = fakeInstances[0]!;
		instance.loadSource.mockClear();

		await user.click(screen.getByTestId("player-quality"));
		await user.click(await screen.findByTestId("quality-720p"));

		expect(fakeInstances.length).toBe(1);
		expectLiveSource(
			instance.loadSource.mock.calls[0]?.[0] as string,
			CHANNEL_ID,
			"720p"
		);
	});

	it("stops the previous playlist before switching channels", () => {
		const { rerender } = renderPlayer();
		const instance = fakeInstances[0]!;
		instance.stopLoad.mockClear();

		rerender(
			<Player
				channelId="00000000-0000-4000-8000-000000000002"
				hlsCtorOverride={FakeHlsCtor}
			/>
		);

		expect(instance.stopLoad).toHaveBeenCalledOnce();
		expectLiveSource(
			instance.loadSource.mock.calls[
				instance.loadSource.mock.calls.length - 1
			]?.[0] as string,
			"00000000-0000-4000-8000-000000000002",
			"original-quality"
		);
	});

	it("replaces the recording media pipeline while keeping a paused seek paused", () => {
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const { rerender } = renderPlayer({
			isRecording: true,
			recordingDurationSeconds: 3_000,
			recordingStartSeconds: 0,
			src: "/recording-first.m3u8"
		});
		const instance = fakeInstances[0]!;
		const manifestHandler = instance.on.mock.calls.find(
			([event]) => event === FakeHls.Events.MANIFEST_PARSED
		)?.[1] as (() => void) | undefined;
		expect(manifestHandler).toBeDefined();
		act(() => manifestHandler?.());
		expect(play).toHaveBeenCalledOnce();
		play.mockClear();

		rerender(
			<Player
				channelId={CHANNEL_ID}
				hlsCtorOverride={FakeHlsCtor}
				isRecording
				recordingDurationSeconds={3_000}
				recordingStartSeconds={1_800}
				src="/recording-second.m3u8"
			/>
		);
		const replacement = fakeInstances[1]!;
		const replacementManifestHandler = replacement.on.mock.calls.find(
			([event]) => event === FakeHls.Events.MANIFEST_PARSED
		)?.[1] as (() => void) | undefined;
		// A late callback from the destroyed window must not resume or mutate the
		// replacement pipeline before its own manifest becomes ready.
		act(() => manifestHandler?.());
		expect(play).not.toHaveBeenCalled();
		act(() => replacementManifestHandler?.());

		// A new MediaSource prevents zero-based fragments from the old lazy
		// window from overlapping the replacement window's timeline.
		expect(instance.destroy).toHaveBeenCalledOnce();
		expect(fakeInstances).toHaveLength(2);
		expect(replacement.loadSource).toHaveBeenLastCalledWith(
			"/recording-second.m3u8"
		);
		expect(play).not.toHaveBeenCalled();
	});

	it("resumes a playing recording after replacing its seek pipeline", () => {
		let paused = true;
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockImplementation(() => {
				paused = false;
				return Promise.resolve();
			});
		const { rerender } = renderPlayer({
			isRecording: true,
			recordingDurationSeconds: 3_000,
			recordingStartSeconds: 0,
			src: "/recording-first.m3u8"
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "paused", {
			configurable: true,
			get: () => paused
		});
		const instance = fakeInstances[0]!;
		const manifestHandler = instance.on.mock.calls.find(
			([event]) => event === FakeHls.Events.MANIFEST_PARSED
		)?.[1] as (() => void) | undefined;
		act(() => manifestHandler?.());
		expect(play).toHaveBeenCalledOnce();

		rerender(
			<Player
				channelId={CHANNEL_ID}
				hlsCtorOverride={FakeHlsCtor}
				isRecording
				recordingDurationSeconds={3_000}
				recordingStartSeconds={1_800}
				src="/recording-second.m3u8"
			/>
		);
		const replacement = fakeInstances[1]!;
		const replacementManifestHandler = replacement.on.mock.calls.find(
			([event]) => event === FakeHls.Events.MANIFEST_PARSED
		)?.[1] as (() => void) | undefined;
		act(() => manifestHandler?.());
		expect(play).toHaveBeenCalledOnce();
		act(() => replacementManifestHandler?.());

		expect(instance.destroy).toHaveBeenCalledOnce();
		expect(fakeInstances).toHaveLength(2);
		expect(play).toHaveBeenCalledTimes(2);
	});

	it("keeps Source as an explicit direct-stream opt-in", async () => {
		const user = userEvent.setup();
		renderPlayer();
		const instance = fakeInstances[0]!;
		instance.loadSource.mockClear();

		await user.click(screen.getByTestId("player-quality"));
		await user.click(await screen.findByTestId("quality-direct"));

		expectLiveSource(
			instance.loadSource.mock.calls[0]?.[0] as string,
			CHANNEL_ID,
			"direct"
		);
	});

	it("explains why Direct and Original remain separate quality choices", async () => {
		const user = userEvent.setup();
		renderPlayer();

		await user.click(screen.getByTestId("player-quality"));

		expect(await screen.findByText("Direct")).toBeInTheDocument();
		expect(screen.getByText("No conversion")).toBeInTheDocument();
		expect(screen.getByText("Original resolution")).toBeInTheDocument();
		expect(
			screen.getByText("Convert for browser playback")
		).toBeInTheDocument();
	});

	it("keeps the mobile rail focused on four primary controls", () => {
		renderPlayer();
		const rail = screen.getByRole("group", { name: "Primary player controls" });
		const primaryControls = within(rail);

		expect(primaryControls.getByRole("button", { name: "Play" })).toBeVisible();
		expect(primaryControls.getByRole("status")).toHaveTextContent("Live");
		expect(
			primaryControls.getByRole("combobox", { name: "Quality" })
		).toBeVisible();
		expect(
			primaryControls.getByRole("button", { name: "Enter fullscreen" })
		).toBeVisible();
		expect(primaryControls.queryByRole("button", { name: "Mute" })).toBeNull();
	});

	it("keeps the commercial skip action out of the controls layout flow", () => {
		renderPlayer({
			isRecording: true,
			recordingDurationSeconds: 1_200,
			commercialMarkers: [{ startMs: 10_000, endMs: 20_000 }]
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => 12
		});

		fireEvent.timeUpdate(video);

		// A transient skip action overlays the video instead of adding a row that
		// shifts the stable transport rail.
		expect(screen.getByTestId("player-skip-commercial-overlay")).toHaveClass(
			"absolute"
		);
	});

	it("progressively discloses secondary player controls and shortcut help", async () => {
		const user = userEvent.setup();
		renderPlayer();

		await user.click(
			screen.getByRole("button", { name: "More playback controls" })
		);

		const secondary = screen.getByRole("region", {
			name: "More playback controls"
		});
		expect(
			within(secondary).getByRole("button", { name: "Mute" })
		).toBeVisible();
		expect(
			within(secondary).getByRole("slider", { name: "Volume" })
		).toBeVisible();

		await user.click(
			within(secondary).getByRole("button", {
				name: "Show keyboard shortcuts"
			})
		);
		const shortcutHelp = screen.getByRole("region", {
			name: "Player keyboard shortcuts"
		});
		expect(within(shortcutHelp).getByText("Keyboard shortcuts")).toBeVisible();
		expect(within(shortcutHelp).getByText(/Space or K/)).toBeVisible();
	});

	it("keeps auto-hidden controls visible while keyboard focus is inside", () => {
		vi.useFakeTimers();
		try {
			renderPlayer();
			const player = screen.getByTestId("player");
			const video = screen.getByTestId("player-video");
			const controls = screen.getByTestId("player-controls");
			const playButton = screen.getByRole("button", { name: "Play" });
			Object.defineProperty(video, "paused", {
				configurable: true,
				get: () => false
			});

			fireEvent.play(video);
			fireEvent.playing(video);
			fireEvent.mouseMove(player);
			act(() => vi.advanceTimersByTime(2_500));
			expect(controls).toHaveAttribute("data-visible", "false");

			fireEvent.focus(playButton);
			expect(controls).toHaveAttribute("data-visible", "true");
			act(() => vi.advanceTimersByTime(5_000));
			expect(controls).toHaveAttribute("data-visible", "true");
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows contextual startup progress until playback begins", () => {
		renderPlayer({
			mediaTitle: "7 · KQED",
			mediaSubtitle: "Nature at Night"
		});
		const instance = fakeInstances[0]!;
		const manifestHandler = instance.on.mock.calls.find(
			([event]) => event === FakeHls.Events.MANIFEST_PARSED
		)?.[1] as (() => void) | undefined;

		expect(screen.getByTestId("player-loading-stage")).toHaveTextContent(
			"Preparing stream"
		);
		expect(screen.getByText("7 · KQED")).toBeVisible();
		expect(screen.getByText("Nature at Night")).toBeVisible();

		act(() => manifestHandler?.());
		expect(screen.getByTestId("player-loading-stage")).toHaveTextContent(
			"Buffering video"
		);

		fireEvent.playing(screen.getByTestId("player-video"));
		expect(screen.queryByTestId("player-loading")).toBeNull();
	});

	it("renders custom controls and toggles play/pause", async () => {
		const user = userEvent.setup();
		renderPlayer();
		const playBtn = screen.getByTestId("player-play");
		expect(playBtn).toHaveAttribute("aria-label", "Play");

		// jsdom doesn't implement HTMLMediaElement.play; stub it and have
		// it dispatch the corresponding state events.
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "paused", {
			configurable: true,
			get: () => false
		});
		video.play = vi.fn().mockResolvedValue(undefined);
		video.pause = vi.fn().mockImplementation(() => {
			Object.defineProperty(video, "paused", {
				configurable: true,
				get: () => true
			});
			fireEvent.pause(video);
		});

		fireEvent.play(video);
		expect(playBtn).toHaveAttribute("aria-label", "Pause");

		await user.click(playBtn);
		expect(video.pause).toHaveBeenCalled();
		expect(playBtn).toHaveAttribute("aria-label", "Play");
	});

	it("persists mute toggle via onPersist", async () => {
		const user = userEvent.setup();
		const persist = vi.fn();
		renderPlayer({ onPersist: persist });

		await user.click(screen.getByTestId("player-mute"));
		expect(persist).toHaveBeenCalledWith({ muted: true });

		// Toggling again sends the inverse.
		await user.click(screen.getByTestId("player-mute"));
		expect(persist).toHaveBeenLastCalledWith({ muted: false });
	});

	it("hides the captions button when no subtitle tracks are advertised", () => {
		renderPlayer();
		expect(screen.queryByTestId("player-captions")).not.toBeInTheDocument();
	});

	it("opens Safari's AirPlay picker and reflects target state", async () => {
		const user = userEvent.setup();
		const showPlaybackTargetPicker = vi.fn();
		Object.defineProperty(
			HTMLMediaElement.prototype,
			"webkitShowPlaybackTargetPicker",
			{
				configurable: true,
				value: showPlaybackTargetPicker
			}
		);

		try {
			renderPlayer();
			const video = screen.getByTestId("player-video") as HTMLVideoElement;
			const airPlay = screen.getByTestId("player-airplay");

			expect(video).toHaveAttribute("x-webkit-airplay", "allow");
			await user.click(airPlay);
			expect(showPlaybackTargetPicker).toHaveBeenCalledOnce();

			fireEvent(
				video,
				Object.assign(new Event("webkitplaybacktargetavailabilitychanged"), {
					availability: "not-available"
				})
			);
			expect(airPlay).toBeDisabled();
			fireEvent(
				video,
				Object.assign(new Event("webkitplaybacktargetavailabilitychanged"), {
					availability: "available"
				})
			);
			expect(airPlay).toBeEnabled();

			Object.defineProperty(video, "webkitCurrentPlaybackTargetIsWireless", {
				configurable: true,
				value: true
			});
			fireEvent(
				video,
				new Event("webkitcurrentplaybacktargetiswirelesschanged")
			);
			expect(airPlay).toHaveAttribute("aria-pressed", "true");
			expect(airPlay).toHaveAttribute("aria-label", "AirPlay connected");
		} finally {
			delete (
				HTMLMediaElement.prototype as HTMLMediaElement & {
					webkitShowPlaybackTargetPicker?: () => void;
				}
			).webkitShowPlaybackTargetPicker;
		}
	});

	it("space bar toggles play/pause via keyboard shortcut", () => {
		renderPlayer();
		const player = screen.getByTestId("player");
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		video.play = vi.fn().mockResolvedValue(undefined);
		video.pause = vi.fn();
		Object.defineProperty(video, "paused", {
			configurable: true,
			get: () => true
		});

		fireEvent.keyDown(player, { key: " " });
		expect(video.play).toHaveBeenCalled();
	});

	it("dismisses an embedded player with Escape", () => {
		const onDismiss = vi.fn();
		renderPlayer({ onDismiss });

		fireEvent.keyDown(screen.getByTestId("player"), { key: "Escape" });

		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("surfaces a plain recovery message when playback cannot start", async () => {
		const user = userEvent.setup();
		renderPlayer();
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		video.play = vi.fn().mockRejectedValue(new Error("NotAllowedError"));

		await user.click(screen.getByTestId("player-play"));

		expect(
			await screen.findByText(
				"Playback couldn't start. Select Play again or check this browser's media permissions."
			)
		).toBeInTheDocument();
	});

	it("reports when a player preference could not be saved", async () => {
		const user = userEvent.setup();
		renderPlayer({
			onPersist: vi.fn().mockRejectedValue(new Error("offline"))
		});

		await user.click(screen.getByTestId("player-mute"));

		expect(
			await screen.findByText(
				"That player preference couldn't be saved. Playback will continue with the current setting."
			)
		).toBeInTheDocument();
	});

	it("m / f / c keyboard shortcuts fire mute / fullscreen / captions", () => {
		const persist = vi.fn();
		renderPlayer({ onPersist: persist });
		const player = screen.getByTestId("player");

		// m → mute
		fireEvent.keyDown(player, { key: "m" });
		expect(persist).toHaveBeenCalledWith({ muted: true });

		// c → captions (no tracks → still toggles internal state + persists)
		fireEvent.keyDown(player, { key: "c" });
		expect(persist).toHaveBeenCalledWith({ captionsEnabled: true });

		// f → fullscreen (jsdom has no requestFullscreen; just assert no throw)
		expect(() => fireEvent.keyDown(player, { key: "f" })).not.toThrow();
	});

	it("arrow up/down adjusts volume and persists", () => {
		const persist = vi.fn();
		renderPlayer({ onPersist: persist, initial: { volume: 0.5 } });
		const player = screen.getByTestId("player");

		fireEvent.keyDown(player, { key: "ArrowUp" });
		expect(persist).toHaveBeenCalledWith({ volume: expect.closeTo(0.55, 5) });

		fireEvent.keyDown(player, { key: "ArrowDown" });
		fireEvent.keyDown(player, { key: "ArrowDown" });
		const last = persist.mock.calls[persist.mock.calls.length - 1]?.[0] as {
			volume?: number;
		};
		expect(last?.volume).toBeLessThan(0.55);
	});

	it("changes quality via the picker and persists the choice", async () => {
		const user = userEvent.setup();
		const persist = vi.fn();
		renderPlayer({ onPersist: persist });

		const trigger = screen.getByTestId("player-quality");
		await user.click(trigger);
		const item = await screen.findByTestId("quality-720p");
		await user.click(item);
		expect(persist).toHaveBeenCalledWith({ quality: "720p" });
	});

	it("renders a seek bar for both time-shifted live streams and recordings", () => {
		const { unmount } = renderPlayer();
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.getByTestId("player-seek")).toBeInTheDocument();
		unmount();

		renderPlayer({ isRecording: true });
		expect(screen.getByTestId("player-seek")).toBeInTheDocument();
		expect(screen.getByTestId("player-time")).toBeInTheDocument();
	});

	it("uses recording metadata for the full seek timeline while HLS is still growing", () => {
		renderPlayer({ isRecording: true, recordingDurationSeconds: 3_000 });
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let currentTime = 55;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 60
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			}
		});

		fireEvent.durationChange(video);
		fireEvent.keyDown(screen.getByTestId("player"), { key: "ArrowRight" });

		expect(currentTime).toBe(65);
		expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
			"aria-valuemax",
			"3000"
		);
		expect(screen.getByTestId("player-time")).toHaveTextContent("1:05 / 50:00");
	});

	it("shows hours for the full timeline of recordings longer than one hour", () => {
		renderPlayer({ isRecording: true, recordingDurationSeconds: 3_661 });

		expect(screen.getByTestId("player-time")).toHaveTextContent(
			"0:00:00 / 1:01:01"
		);
	});

	it("requests a new recording window when the target is outside generated media", () => {
		const onRecordingSeek = vi.fn();
		renderPlayer({
			isRecording: true,
			recordingDurationSeconds: 3_000,
			recordingStartSeconds: 600,
			onRecordingSeek
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let currentTime = 5;
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			}
		});
		Object.defineProperty(video, "seekable", {
			configurable: true,
			get: () => ({ length: 1, start: () => 0, end: () => 12 })
		});
		fireEvent.timeUpdate(video);

		fireEvent.keyDown(screen.getByTestId("player"), { key: "ArrowRight" });

		expect(onRecordingSeek).toHaveBeenCalledWith(615);
		expect(currentTime).toBe(5);
		expect(screen.getByTestId("player-time")).toHaveTextContent(
			"10:05 / 50:00"
		);
	});

	it("commits one recording-window seek for a slider adjustment", () => {
		const onRecordingSeek = vi.fn();
		renderPlayer({
			isRecording: true,
			recordingDurationSeconds: 3_000,
			recordingStartSeconds: 600,
			onRecordingSeek
		});
		const slider = screen.getByRole("slider", { name: "Seek" });
		fireEvent.keyDown(slider, { key: "End" });
		fireEvent.keyUp(slider, { key: "End" });

		expect(onRecordingSeek).toHaveBeenCalledTimes(1);
	});

	it("seeks within the retained live window and returns to the live edge", async () => {
		const user = userEvent.setup();
		renderPlayer();
		fakeInstances[0]!.liveSyncPosition = 114;
		const player = screen.getByTestId("player");
		const liveVideo = screen.getByTestId("player-video") as HTMLVideoElement;
		let liveTime = 100;
		Object.defineProperty(liveVideo, "seekable", {
			configurable: true,
			get: () => ({
				length: 1,
				start: () => 40,
				end: () => 120
			})
		});
		Object.defineProperty(liveVideo, "currentTime", {
			configurable: true,
			get: () => liveTime,
			set: (v: number) => {
				liveTime = v;
			}
		});
		liveVideo.play = vi.fn().mockResolvedValue(undefined);
		fireEvent.progress(liveVideo);

		fireEvent.keyDown(player, { key: "ArrowLeft" });
		expect(liveTime).toBe(90);
		expect(screen.getByText(/^Delayed /)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Go Live" }));
		expect(liveTime).toBe(114);
		expect(liveVideo.play).toHaveBeenCalled();
	});

	it("treats the adaptive HLS sync position as live instead of the raw playlist edge", () => {
		renderPlayer();
		fakeInstances[0]!.liveSyncPosition = 114;
		const liveVideo = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(liveVideo, "seekable", {
			configurable: true,
			get: () => ({
				length: 1,
				start: () => 40,
				end: () => 120
			})
		});
		Object.defineProperty(liveVideo, "currentTime", {
			configurable: true,
			get: () => 115
		});

		fireEvent.progress(liveVideo);

		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Go Live" })
		).not.toBeInTheDocument();
	});

	it("backs off and surfaces an error instead of loading forever at the live edge", () => {
		vi.useFakeTimers();
		try {
			renderPlayer();
			const instance = fakeInstances[0]!;
			const liveVideo = screen.getByTestId("player-video") as HTMLVideoElement;
			let liveTime = 100;
			Object.defineProperty(liveVideo, "seekable", {
				configurable: true,
				get: () => ({
					length: 1,
					start: () => 40,
					end: () => 120
				})
			});
			Object.defineProperty(liveVideo, "currentTime", {
				configurable: true,
				get: () => liveTime,
				set: (value: number) => {
					liveTime = value;
				}
			});
			liveVideo.play = vi.fn().mockResolvedValue(undefined);
			fireEvent.progress(liveVideo);

			fireEvent.click(screen.getByRole("button", { name: "Go Live" }));
			expect(liveTime).toBe(119.5);

			// A stalled first attempt seeks further back and resets MediaSource.
			act(() => vi.advanceTimersByTime(4_000));
			expect(liveTime).toBe(118);
			expect(instance.recoverMediaError).toHaveBeenCalledOnce();
			expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();

			// A second timeout becomes actionable instead of spinning forever.
			act(() => vi.advanceTimersByTime(4_000));
			expect(screen.getByTestId("player-error")).toHaveTextContent(
				"Playback stalled"
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels Go Live recovery once playback advances", () => {
		vi.useFakeTimers();
		try {
			renderPlayer();
			const instance = fakeInstances[0]!;
			const liveVideo = screen.getByTestId("player-video") as HTMLVideoElement;
			let liveTime = 100;
			Object.defineProperty(liveVideo, "seekable", {
				configurable: true,
				get: () => ({
					length: 1,
					start: () => 40,
					end: () => 120
				})
			});
			Object.defineProperty(liveVideo, "currentTime", {
				configurable: true,
				get: () => liveTime,
				set: (value: number) => {
					liveTime = value;
				}
			});
			liveVideo.play = vi.fn().mockResolvedValue(undefined);
			fireEvent.progress(liveVideo);

			fireEvent.click(screen.getByRole("button", { name: "Go Live" }));
			liveTime = 119.6;
			fireEvent.timeUpdate(liveVideo);
			act(() => vi.advanceTimersByTime(8_000));

			expect(instance.recoverMediaError).not.toHaveBeenCalled();
			expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("recovers to the earliest retained point when paused media expires", () => {
		renderPlayer();
		const liveVideo = screen.getByTestId("player-video") as HTMLVideoElement;
		let liveTime = 20;
		Object.defineProperty(liveVideo, "seekable", {
			configurable: true,
			get: () => ({
				length: 1,
				start: () => 40,
				end: () => 120
			})
		});
		Object.defineProperty(liveVideo, "currentTime", {
			configurable: true,
			get: () => liveTime,
			set: (value: number) => {
				liveTime = value;
			}
		});
		liveVideo.play = vi.fn().mockResolvedValue(undefined);

		fireEvent.progress(liveVideo);

		expect(liveTime).toBe(40);
		expect(screen.getByText(/earliest available point/i)).toBeInTheDocument();
	});
});
