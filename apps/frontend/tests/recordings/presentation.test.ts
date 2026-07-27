import type { Recording } from "@signalhaven/shared";
import { describe, expect, it } from "vitest";

import {
	formatEpisodeLabel,
	getRecordingFailurePresentation,
	getRecordingViewState
} from "../../app/_recordings/presentation";

/** Build the viewing fields needed by the presentation helpers. */
function recording(overrides: Partial<Recording> = {}): Recording {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		channelId: "00000000-0000-4000-8000-000000000aaa",
		programId: null,
		title: "Example",
		status: "completed",
		scheduledStart: "2026-01-01T00:00:00Z",
		scheduledEnd: "2026-01-01T01:00:00Z",
		actualStart: null,
		actualEnd: null,
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: 1_000,
		errorMessage: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		...overrides
	};
}

describe("recording presentation", () => {
	it("formats season, episode, and subtitle with graceful fallbacks", () => {
		expect(
			formatEpisodeLabel({
				season: 1,
				episode: 2,
				subtitle: "The Return"
			})
		).toBe("S01E02 · The Return");
		expect(
			formatEpisodeLabel({ season: null, episode: 7, subtitle: null })
		).toBe("Episode 7");
		expect(
			formatEpisodeLabel({
				season: null,
				episode: null,
				subtitle: "Special"
			})
		).toBe("Special");
		expect(
			formatEpisodeLabel({
				season: null,
				episode: null,
				subtitle: null
			})
		).toBeNull();
	});

	it("distinguishes unwatched, in-progress, and watched recordings", () => {
		expect(getRecordingViewState(recording())).toEqual({
			kind: "unwatched",
			label: "Unwatched",
			progressPercent: 0
		});
		expect(
			getRecordingViewState(recording({ resumePositionSeconds: 250 }))
		).toEqual({
			kind: "in-progress",
			label: "25% watched",
			progressPercent: 25
		});
		expect(
			getRecordingViewState(
				recording({
					watchedAt: "2026-01-02T00:00:00Z",
					resumePositionSeconds: 250
				})
			)
		).toEqual({
			kind: "watched",
			label: "Watched",
			progressPercent: 100
		});
	});

	it("maps internal recording failures to actionable copy without leaking raw output", () => {
		const rawFailure =
			"ffmpeg -i /Users/private/recording.ts token=top-secret exited 1";
		const presentation = getRecordingFailurePresentation(rawFailure);

		expect(presentation.summary).toBe("Recorder process failed");
		expect(presentation.detail).toContain("server logs");
		expect(presentation.detail).not.toContain(rawFailure);
		expect(presentation.detail).not.toContain("top-secret");
	});
});
