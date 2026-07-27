"use client";

import type {
	EpgGridProgram,
	Recording,
	SeriesRule
} from "@signalhaven/shared";
import { useCallback, useRef, useState } from "react";

import {
	cancelRecording,
	createSeriesRule,
	scheduleRecordingByProgram
} from "../../lib/api-client";

export type ProgramRecordingAction = "schedule" | "cancel" | "series";

/** Recording fields that can be updated without replacing EPG metadata. */
export type ProgramRecordingPatch = Pick<
	EpgGridProgram,
	"recordingId" | "recordingStatus"
>;

export interface ProgramRecordingActionError {
	programId: string;
	action: ProgramRecordingAction;
	message: string;
}

export interface UseProgramRecordingActionsOptions {
	onProgramChange: (programId: string, patch: ProgramRecordingPatch) => void;
	schedule?:
		| ((
				program: EpgGridProgram
		  ) => Promise<Recording | void> | Recording | void)
		| undefined;
	cancel?:
		| ((
				recordingId: string,
				program: EpgGridProgram
		  ) => Promise<Recording | void> | Recording | void)
		| undefined;
	recordSeries?:
		| ((
				program: EpgGridProgram
		  ) => Promise<SeriesRule | void> | SeriesRule | void)
		| undefined;
}

/**
 * Runs program recording mutations with optimistic state, rollback, and a
 * synchronous in-flight guard so rapid clicks cannot submit duplicates.
 */
export function useProgramRecordingActions(
	options: UseProgramRecordingActionsOptions
) {
	const { onProgramChange, schedule: scheduleOverride } = options;
	const { cancel: cancelOverride, recordSeries: recordSeriesOverride } =
		options;
	const pendingRef = useRef(new Map<string, ProgramRecordingAction>());
	const [pending, setPending] = useState<
		ReadonlyMap<string, ProgramRecordingAction>
	>(() => new Map());
	const [error, setError] = useState<ProgramRecordingActionError | null>(null);

	const start = useCallback(
		(programId: string, action: ProgramRecordingAction): boolean => {
			if (pendingRef.current.has(programId)) return false;
			pendingRef.current.set(programId, action);
			setPending(new Map(pendingRef.current));
			setError(null);
			return true;
		},
		[]
	);

	const finish = useCallback((programId: string) => {
		pendingRef.current.delete(programId);
		setPending(new Map(pendingRef.current));
	}, []);

	const reportFailure = useCallback(
		(
			program: EpgGridProgram,
			action: ProgramRecordingAction,
			failure: unknown
		): Error => {
			// Preserve the original failure for developers while exposing concise UI copy.
			console.error(`Failed to ${action} recording for ${program.id}`, failure);
			const detail =
				failure instanceof Error && failure.message.length > 0
					? failure.message
					: "Please try again.";
			const message =
				action === "cancel"
					? `Couldn't cancel the recording. ${detail}`
					: action === "series"
						? `Couldn't create the series rule. ${detail}`
						: `Couldn't schedule the recording. ${detail}`;
			setError({ programId: program.id, action, message });
			return new Error(message);
		},
		[]
	);

	const schedule = useCallback(
		async (program: EpgGridProgram): Promise<void> => {
			if (!start(program.id, "schedule")) return;
			const previous: ProgramRecordingPatch = {
				recordingId: program.recordingId,
				recordingStatus: program.recordingStatus
			};
			onProgramChange(program.id, {
				recordingId: null,
				recordingStatus: "scheduled"
			});
			try {
				const scheduler =
					scheduleOverride ??
					(async (target: EpgGridProgram) => {
						const result = await scheduleRecordingByProgram({
							programId: target.id,
							channelId: target.channelId
						});
						return result.recording;
					});
				const recording = await scheduler(program);
				if (recording) {
					onProgramChange(program.id, {
						recordingId: recording.id,
						recordingStatus: recording.status
					});
				}
			} catch (failure) {
				onProgramChange(program.id, previous);
				throw reportFailure(program, "schedule", failure);
			} finally {
				finish(program.id);
			}
		},
		[finish, onProgramChange, reportFailure, scheduleOverride, start]
	);

	const cancel = useCallback(
		async (program: EpgGridProgram): Promise<void> => {
			if (!program.recordingId) {
				throw reportFailure(
					program,
					"cancel",
					new Error(
						"The recording identifier is unavailable; refresh and retry."
					)
				);
			}
			if (!start(program.id, "cancel")) return;
			const previous: ProgramRecordingPatch = {
				recordingId: program.recordingId,
				recordingStatus: program.recordingStatus
			};
			try {
				const canceller =
					cancelOverride ??
					((recordingId: string) => cancelRecording(recordingId));
				await canceller(program.recordingId, program);
				// In-progress cancellation may return before ffmpeg exits; show the
				// requested terminal state until the lifecycle event reconciles it.
				onProgramChange(program.id, {
					recordingId: program.recordingId,
					recordingStatus: "cancelled"
				});
			} catch (failure) {
				onProgramChange(program.id, previous);
				throw reportFailure(program, "cancel", failure);
			} finally {
				finish(program.id);
			}
		},
		[cancelOverride, finish, onProgramChange, reportFailure, start]
	);

	const recordSeries = useCallback(
		async (program: EpgGridProgram): Promise<void> => {
			if (!start(program.id, "series")) return;
			try {
				const recorder =
					recordSeriesOverride ??
					((target: EpgGridProgram) =>
						createSeriesRule({
							title: target.title,
							channelId: target.channelId,
							keepCount: 5,
							newOnly: false,
							priority: 0
						}));
				await recorder(program);
			} catch (failure) {
				throw reportFailure(program, "series", failure);
			} finally {
				finish(program.id);
			}
		},
		[finish, recordSeriesOverride, reportFailure, start]
	);

	const clearError = useCallback(() => setError(null), []);

	return { pending, error, schedule, cancel, recordSeries, clearError };
}
