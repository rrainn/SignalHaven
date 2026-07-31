import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
	ChannelListItem,
	PlayerSettings,
	RecordingDetail
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

import { RecordingPlayerPage } from "../../app/_recordings/RecordingPlayerPage";
import type { HlsModule } from "../../app/_player/useHls";

/**
 * Behavioural tests for the U8 recording playback page. The actual
 * Player surface is covered by `tests/player/Player.test.tsx`; this
 * file focuses on the U8-specific lifecycle:
 *
 *   - Resume position is seeded onto `<video>.currentTime` when the
 *     element loads metadata.
 *   - Resume position is persisted on a coarse timer.
 *   - Crossing the 90% mark flips the recording to watched.
 */

class FakeHls {
	static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
	static isSupported = () => true;
	attachMedia = vi.fn();
	loadSource = vi.fn();
	stopLoad = vi.fn();
	destroy = vi.fn();
	on = vi.fn();
}

const FakeHlsCtor = FakeHls as unknown as HlsModule;

const REC: RecordingDetail = {
	id: "11111111-1111-4111-8111-111111111111",
	channelId: "00000000-0000-4000-8000-000000000aaa",
	programId: null,
	title: "Sherlock S01E01",
	status: "completed",
	scheduledStart: "2025-01-01T00:00:00Z",
	scheduledEnd: "2025-01-01T01:00:00Z",
	actualStart: null,
	actualEnd: null,
	startReason: null,
	filePath: "/var/lib/signalhaven/recordings/sherlock.mkv",
	fileSize: 2_500_000_000,
	durationSeconds: 3000,
	errorMessage: null,
	seriesRuleId: null,
	manuallyProtected: false,
	watchedAt: null,
	resumePositionSeconds: 600,
	commercialAnalysis: {
		status: "not_requested",
		queuedAt: null,
		startedAt: null,
		completedAt: null,
		failedAt: null,
		diagnosticMessage: null,
		detectorVersion: null,
		markers: []
	},
	metadata: {
		subtitle: "A Study in Pink",
		description: "Sherlock and John meet for the first time.",
		episode: 1,
		season: 1,
		categories: ["Drama"],
		artworkUrl: null,
		originalAirDate: null
	}
};

const SETTINGS: PlayerSettings = {
	volume: 1,
	muted: false,
	captionsEnabled: false,
	qualityByChannel: {}
};

const CHANNEL: ChannelListItem = {
	id: REC.channelId,
	number: "7.1",
	name: "KXYZ",
	logoUrl: null,
	tvgId: null,
	tunerId: "22222222-2222-4222-8222-222222222222",
	tunerName: "Living room tuner",
	tunerKind: "hdhomerun",
	enabled: true,
	sortOrder: 1,
	hasMapping: true
};

beforeEach(() => {
	pushMock.mockClear();
});

function renderPage(overrides: {
	recording?: RecordingDetail;
	patchProgress?: ReturnType<typeof vi.fn>;
	retryAnalysis?: ReturnType<typeof vi.fn>;
}) {
	const recording = overrides.recording ?? REC;
	const patchProgress =
		overrides.patchProgress ?? vi.fn().mockResolvedValue(undefined);
	// The mocked dynamic import keeps the nested player independent from MSE.
	return {
		patchProgress,
		...render(
			<RecordingPlayerPage
				recordingId={recording.id}
				initialRecording={recording}
				initialChannel={CHANNEL}
				initialPlayerSettings={SETTINGS}
				patchProgress={patchProgress}
				retryAnalysis={overrides.retryAnalysis}
				// Player.test covers actual stream attachment and recovery behavior.
			/>
		)
	};
}

// Stub hls.js dynamic import so the inner useHls hook resolves it.
vi.mock("hls.js", () => ({ default: FakeHlsCtor }));

describe("RecordingPlayerPage", () => {
	it("shows actionable failed-recording details without mounting the player or leaking raw output", () => {
		const rawFailure = "ffmpeg /private/file.ts token=top-secret exited 1";
		renderPage({
			recording: {
				...REC,
				status: "failed",
				errorMessage: rawFailure
			}
		});

		expect(screen.getByTestId("recording-failure-detail")).toHaveTextContent(
			"Recorder process failed"
		);
		expect(screen.getByTestId("recording-failure-detail")).toHaveTextContent(
			"server logs"
		);
		expect(screen.queryByText(rawFailure)).not.toBeInTheDocument();
		expect(screen.queryByText(/top-secret/)).not.toBeInTheDocument();
		expect(screen.queryByTestId("player")).not.toBeInTheDocument();
	});

	it("renders the recording metadata and the Player surface", () => {
		renderPage({});
		expect(screen.getByTestId("recording-player-page")).toBeInTheDocument();
		expect(screen.getByTestId("recording-title")).toHaveTextContent(
			"Sherlock S01E01"
		);
		expect(screen.getByTestId("recording-description")).toHaveTextContent(
			"Sherlock and John meet for the first time."
		);
		expect(screen.getByTestId("recording-episode")).toHaveTextContent(
			"S01E01 · A Study in Pink"
		);
		expect(screen.getByTestId("recording-metadata")).toHaveTextContent(
			"7.1 KXYZ"
		);
		expect(screen.getByTestId("recording-metadata")).toHaveTextContent("Drama");
		expect(screen.getByTestId("player")).toBeInTheDocument();
		// Recording mode → the seek bar is rendered.
		expect(screen.getByTestId("player-seek")).toBeInTheDocument();
	});

	it("renders commercial regions and offers a manual skip inside one", async () => {
		renderPage({
			recording: {
				...REC,
				resumePositionSeconds: 0,
				commercialAnalysis: {
					...REC.commercialAnalysis,
					status: "completed",
					markers: [{ startMs: 600_000, endMs: 660_000 }]
				}
			}
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let currentTime = 620;
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			}
		});

		fireEvent.timeUpdate(video);
		const skip = await screen.findByRole("button", { name: "Skip Commercial" });
		fireEvent.click(skip);

		// With no generated seekable range, skipping replaces the lazy window and
		// resets the media element to that window's relative timestamp zero.
		expect(currentTime).toBe(0);
		expect(screen.getByTestId("player-time")).toHaveTextContent(
			"11:00 / 50:00"
		);
		expect(screen.getByTestId("player-commercial-markers")).toBeInTheDocument();
	});

	it("reruns completed Comskip analysis for an existing recording", async () => {
		const retryAnalysis = vi.fn().mockResolvedValue({
			...REC.commercialAnalysis,
			status: "queued",
			queuedAt: "2026-01-01T00:00:00Z"
		});
		renderPage({
			recording: {
				...REC,
				commercialAnalysis: {
					...REC.commercialAnalysis,
					status: "completed",
					completedAt: "2025-12-31T23:00:00Z",
					detectorVersion: "comskip-edl-v1",
					markers: [{ startMs: 600_000, endMs: 660_000 }]
				}
			},
			retryAnalysis
		});

		fireEvent.click(screen.getByRole("button", { name: "Rerun Comskip" }));

		await waitFor(() => expect(retryAnalysis).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId("commercial-analysis-state")).toHaveTextContent(
			"Queued"
		);
	});

	it("offers Comskip for an older recording that has not been analyzed", () => {
		renderPage({});

		expect(
			screen.getByRole("button", { name: "Run Comskip" })
		).toBeInTheDocument();
	});

	it("shows failed analysis diagnostics and retries manually", async () => {
		const retryAnalysis = vi.fn().mockResolvedValue({
			...REC.commercialAnalysis,
			status: "queued",
			queuedAt: "2026-01-01T00:00:00Z"
		});
		render(
			<RecordingPlayerPage
				recordingId={REC.id}
				initialRecording={{
					...REC,
					commercialAnalysis: {
						...REC.commercialAnalysis,
						status: "failed",
						diagnosticMessage: "Comskip exited 1"
					}
				}}
				initialChannel={CHANNEL}
				initialPlayerSettings={SETTINGS}
				retryAnalysis={retryAnalysis}
			/>
		);

		expect(screen.getByTestId("commercial-analysis-state")).toHaveTextContent(
			"Comskip exited 1"
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry Comskip" }));

		await waitFor(() => expect(retryAnalysis).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId("commercial-analysis-state")).toHaveTextContent(
			"Queued"
		);
	});

	it("explains when playback is a partial late-start recording", () => {
		renderPage({
			recording: {
				...REC,
				startReason: "late_start"
			}
		});

		expect(screen.getByTestId("recording-late-start")).toHaveTextContent(
			"Partial recording"
		);
	});

	it("starts the lazy playback window at the persisted resume position", async () => {
		renderPage({});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 3000
		});
		fireEvent(video, new Event("loadedmetadata"));
		expect(video.currentTime).toBe(0);
		expect(screen.getByTestId("player-time")).toHaveTextContent(
			"10:00 / 50:00"
		);
	});

	it("uses the recording duration before the progressive HLS manifest is complete", () => {
		renderPage({});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 60
		});

		fireEvent.durationChange(video);

		expect(video.currentTime).toBe(0);
		expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
			"aria-valuemax",
			"3000"
		);
	});

	it("does not mark a recording watched at the end of the partial HLS timeline", async () => {
		const patchProgress = vi.fn().mockResolvedValue(undefined);
		renderPage({
			patchProgress,
			recording: { ...REC, resumePositionSeconds: 0 }
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 60
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => 55
		});

		fireEvent.timeUpdate(video);

		await waitFor(() => {
			expect(patchProgress).toHaveBeenCalledWith({
				resumePositionSeconds: 55
			});
		});
		expect(
			patchProgress.mock.calls.some((call) => call[0]?.watched === true)
		).toBe(false);
	});

	it("persists the resume position once enough time has elapsed", async () => {
		const patchProgress = vi.fn().mockResolvedValue(undefined);
		renderPage({ patchProgress });
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let cur = 0;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 3000
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => cur,
			set: (v: number) => {
				cur = v;
			}
		});
		fireEvent(video, new Event("loadedmetadata"));
		patchProgress.mockClear();

		// Tick forward by 12 seconds — past the 10s threshold so a resume
		// PATCH should fire.
		cur = 12;
		fireEvent(video, new Event("timeupdate"));

		await waitFor(() => {
			expect(patchProgress).toHaveBeenCalled();
		});
		const last =
			patchProgress.mock.calls[patchProgress.mock.calls.length - 1]?.[0];
		expect(last).toEqual({ resumePositionSeconds: 612 });
	});

	it("surfaces a failed progress write and lets the user retry it", async () => {
		const patchProgress = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(undefined);
		renderPage({ patchProgress });
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let currentTime = 0;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 3000
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
			}
		});
		fireEvent(video, new Event("loadedmetadata"));
		patchProgress.mockClear();

		currentTime = 12;
		fireEvent(video, new Event("timeupdate"));

		expect(
			await screen.findByTestId("recording-progress-error")
		).toHaveTextContent("could not be saved");
		fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
		await waitFor(() => expect(patchProgress).toHaveBeenCalledTimes(2));
		expect(patchProgress).toHaveBeenLastCalledWith({
			resumePositionSeconds: 612
		});
	});

	it("flips the recording to watched once playback crosses 90%", async () => {
		const patchProgress = vi.fn().mockResolvedValue(undefined);
		renderPage({
			patchProgress,
			recording: { ...REC, resumePositionSeconds: 0 }
		});

		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let cur = 0;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 3000
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => cur,
			set: (v: number) => {
				cur = v;
			}
		});

		cur = 2800; // 93%
		fireEvent(video, new Event("timeupdate"));

		await waitFor(() => {
			const calls = patchProgress.mock.calls.map((c) => c[0]);
			expect(calls.some((c) => c.watched === true)).toBe(true);
		});
	});

	it("clears resumePositionSeconds when playback ends", async () => {
		const patchProgress = vi.fn().mockResolvedValue(undefined);
		renderPage({
			patchProgress,
			recording: { ...REC, resumePositionSeconds: 0 }
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 3000
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => 3000
		});

		fireEvent(video, new Event("ended"));
		await waitFor(() => {
			const matched = patchProgress.mock.calls.find(
				(c) => c[0]?.watched === true && c[0]?.resumePositionSeconds === null
			);
			expect(matched).toBeTruthy();
		});
	});

	it("clears a stale resume position on ended after already crossing the watched threshold", async () => {
		const patchProgress = vi.fn().mockResolvedValue(undefined);
		renderPage({
			patchProgress,
			recording: { ...REC, resumePositionSeconds: 0 }
		});
		const video = screen.getByTestId("player-video") as HTMLVideoElement;
		let cur = 2800;
		Object.defineProperty(video, "duration", {
			configurable: true,
			get: () => 3000
		});
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			get: () => cur,
			set: (value: number) => {
				cur = value;
			}
		});

		// Crossing 90% marks the recording watched but does not yet clear resume.
		fireEvent(video, new Event("timeupdate"));
		await waitFor(() => {
			expect(
				patchProgress.mock.calls.some((call) => call[0]?.watched === true)
			).toBe(true);
		});
		patchProgress.mockClear();

		fireEvent(video, new Event("ended"));

		await waitFor(() => {
			expect(patchProgress).toHaveBeenCalledWith({
				watched: true,
				resumePositionSeconds: null
			});
		});
	});
});
