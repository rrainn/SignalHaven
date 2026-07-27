import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor
} from "@testing-library/react";
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
 *   - Custom controls wiring (play/pause, mute, captions, quality, PiP,
 *     fullscreen).
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
}

const fakeInstances: FakeHlsInstance[] = [];

class FakeHls implements FakeHlsInstance {
	static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
	static ErrorTypes = { MEDIA_ERROR: "mediaError" };
	attachMedia = vi.fn();
	loadSource = vi.fn();
	stopLoad = vi.fn();
	recoverMediaError = vi.fn();
	destroy = vi.fn();
	on = vi.fn();
	latency = 4.25;
	liveSyncPosition: number | null = 119.5;
	constructor() {
		fakeInstances.push(this);
	}
}

const FakeHlsCtor = FakeHls as unknown as HlsModule;

// Let native-HLS recovery tests load the same controllable player double that
// the explicit constructor seam uses in the rest of this suite.
vi.mock("hls.js", () => ({ default: FakeHlsCtor }));

const CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

function renderPlayer(
	overrides: Partial<React.ComponentProps<typeof Player>> = {}
) {
	return render(
		<Player
			channelId={CHANNEL_ID}
			hlsCtorOverride={FakeHlsCtor}
			forceHlsJs
			{...overrides}
		/>
	);
}

/** Assert the observable channel/profile contract without coupling to its random viewer id. */
function expectLiveSource(
	source: string,
	channelId: string,
	profile: string
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
});

describe("Player", () => {
	it("uses a viewer-scoped browser-safe profile and releases it on unmount", () => {
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

	it("falls back to hls.js when Safari reports a native decode error", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
			"probably"
		);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		render(<Player channelId={CHANNEL_ID} />);
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "error", {
			configurable: true,
			get: () => ({ code: 3, message: "Media failed to decode" })
		});

		fireEvent.error(video);

		await waitFor(() => expect(fakeInstances).toHaveLength(1));
		expect(fakeInstances[0]?.attachMedia).toHaveBeenCalledWith(video);
		expectLiveSource(
			fakeInstances[0]?.loadSource.mock.calls[0]?.[0] as string,
			CHANNEL_ID,
			"original-quality"
		);
		expect(screen.queryByTestId("player-error")).not.toBeInTheDocument();
	});

	it("exhausts bounded automatic media recovery before showing Retry", () => {
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
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));

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

		expect(screen.getByText("Playback error")).toBeInTheDocument();
		expect(screen.queryByText(/192\.168\.1\.20|viewer|secret/)).toBeNull();
	});

	it("offers Extra Stats from the video context menu in advanced mode", async () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		render(
			<AdvancedModeProvider>
				<Player
					channelId={CHANNEL_ID}
					hlsCtorOverride={FakeHlsCtor}
					forceHlsJs
				/>
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
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					channelId: CHANNEL_ID,
					profile: "original-quality",
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
					lastError: null
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			)
		);
		try {
			render(
				<AdvancedModeProvider>
					<Player
						channelId={CHANNEL_ID}
						hlsCtorOverride={FakeHlsCtor}
						forceHlsJs
					/>
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
			expect(stats).toHaveTextContent("12.0 s");
			expect(stats).toHaveTextContent("Behind live");
			expect(stats).toHaveTextContent("4.3 s");
			expect(stats).toHaveTextContent("Dropped frames");
			expect(stats).toHaveTextContent("25 / 1060 (2.4%)");
			expect(stats).toHaveTextContent("Server status");
			expect(stats).toHaveTextContent("Idle (kept warm)");
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
				forceHlsJs
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
		expect(screen.getByText("Delayed")).toBeInTheDocument();

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
