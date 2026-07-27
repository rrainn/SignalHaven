import type {
	Recording,
	RecordingMetadata,
	RecordingStartReason
} from "@signalhaven/shared";

/** Stable viewing states rendered consistently in every library surface. */
export type RecordingViewState =
	| {
			kind: "unwatched";
			label: "Unwatched";
			progressPercent: 0;
	  }
	| {
			kind: "in-progress";
			label: string;
			progressPercent: number;
	  }
	| {
			kind: "watched";
			label: "Watched";
			progressPercent: 100;
	  };

/** Derive watched state and bounded progress from persisted playback fields. */
export function getRecordingViewState(
	recording: Pick<
		Recording,
		"watchedAt" | "resumePositionSeconds" | "durationSeconds"
	>
): RecordingViewState {
	if (recording.watchedAt) {
		return { kind: "watched", label: "Watched", progressPercent: 100 };
	}
	const position = recording.resumePositionSeconds ?? 0;
	const duration = recording.durationSeconds ?? 0;
	if (position <= 0) {
		return { kind: "unwatched", label: "Unwatched", progressPercent: 0 };
	}
	const progressPercent =
		duration > 0
			? Math.max(1, Math.min(99, Math.round((position / duration) * 100)))
			: 0;
	return {
		kind: "in-progress",
		label: progressPercent > 0 ? `${progressPercent}% watched` : "In progress",
		progressPercent
	};
}

/** Format available episode metadata without exposing blank placeholders. */
export function formatEpisodeLabel(
	metadata: Pick<RecordingMetadata, "season" | "episode" | "subtitle">
): string | null {
	const episode =
		metadata.season !== null && metadata.episode !== null
			? `S${String(metadata.season).padStart(2, "0")}E${String(
					metadata.episode
				).padStart(2, "0")}`
			: metadata.episode !== null
				? `Episode ${metadata.episode}`
				: metadata.season !== null
					? `Season ${metadata.season}`
					: null;
	if (episode && metadata.subtitle) {
		return `${episode} · ${metadata.subtitle}`;
	}
	return episode ?? metadata.subtitle ?? null;
}

export interface RecordingFailurePresentation {
	summary: string;
	detail: string;
}

const FAILURE_PRESENTATIONS: Record<string, RecordingFailurePresentation> = {
	process_terminated: {
		summary: "Recording interrupted",
		detail:
			"SignalHaven stopped while this recording was in progress. Check the saved partial file, then schedule another airing if needed."
	},
	missed_window: {
		summary: "Recording window missed",
		detail:
			"SignalHaven started too late to capture a useful portion. Check that the server stays online and its clock is accurate."
	},
	retry_window_exhausted: {
		summary: "Not enough time remained",
		detail:
			"SignalHaven could not recover the tuner before the program ended. Check tuner availability and schedule another airing."
	},
	retries_exhausted: {
		summary: "Tuner retries exhausted",
		detail:
			"SignalHaven could not reach the source after several attempts. Check the tuner connection and channel mapping."
	},
	configuration_error: {
		summary: "Recording setup needs attention",
		detail:
			"Check the recording storage path, permissions, and available disk space in Settings."
	},
	source_configuration_error: {
		summary: "Channel source unavailable",
		detail:
			"Check that this channel still exists, has a valid tuner mapping, and can play live."
	},
	file_missing: {
		summary: "Recording file is missing",
		detail:
			"The library entry remains, but its file is no longer in recording storage. Run a library scan after checking the storage volume."
	}
};

/**
 * Convert persisted recorder failures into safe, actionable UI copy. Unknown
 * values may contain command lines, paths, or credentials, so they remain in
 * server diagnostics instead of being echoed into the browser.
 */
export function getRecordingFailurePresentation(
	errorMessage: string | null | undefined
): RecordingFailurePresentation {
	if (errorMessage && FAILURE_PRESENTATIONS[errorMessage]) {
		return FAILURE_PRESENTATIONS[errorMessage];
	}
	return {
		summary: "Recorder process failed",
		detail:
			"The recorder exited before finishing. Check tuner signal, recording storage, and the SignalHaven server logs for technical details."
	};
}

/** Explain why a completed file contains only part of the scheduled window. */
export function formatPartialRecordingReason(
	reason: RecordingStartReason | null
): string | null {
	return reason === "late_start"
		? "Capture started after the scheduled beginning."
		: null;
}
