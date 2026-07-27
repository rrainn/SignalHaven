"use client";

import type {
	Recording,
	RecordingListItem,
	RecordingPatch
} from "@signalhaven/shared";
import { useCallback, useRef, useState } from "react";

import { patchRecording } from "../../lib/api-client";

export interface OptimisticRecordingMutationOptions {
	recordings: RecordingListItem[];
	apply: (ids: string[], patch: Partial<Recording>) => void;
	send?:
		| ((id: string, patch: RecordingPatch) => Promise<Recording>)
		| undefined;
}

/**
 * Own optimistic recording mutations, per-row ordering, visible pending state,
 * and field-preserving rollback for library and series surfaces.
 */
export function useOptimisticRecordingMutations(
	options: OptimisticRecordingMutationOptions
) {
	const { recordings, apply, send } = options;
	const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<Error | null>(null);
	const versionById = useRef(new Map<string, number>());

	const mutate = useCallback(
		async (
			ids: string[],
			patch: RecordingPatch,
			optimisticPatch: Partial<Recording>
		): Promise<void> => {
			if (ids.length === 0) return;
			const sender = send ?? patchRecording;
			const snapshots = new Map(
				recordings
					.filter((recording) => ids.includes(recording.id))
					.map((recording) => [
						recording.id,
						captureOptimisticFields(recording, optimisticPatch)
					])
			);
			const versions = new Map<string, number>();
			for (const id of ids) {
				const version = (versionById.current.get(id) ?? 0) + 1;
				versionById.current.set(id, version);
				versions.set(id, version);
			}

			setError(null);
			setPendingIds((current) => new Set([...current, ...ids]));
			apply(ids, optimisticPatch);
			const results = await Promise.allSettled(
				ids.map((id) => sender(id, patch))
			);
			const failedIds: string[] = [];
			results.forEach((result, index) => {
				const id = ids[index];
				if (!id || versionById.current.get(id) !== versions.get(id)) {
					return;
				}
				if (result.status === "fulfilled") {
					apply([id], result.value);
					return;
				}
				failedIds.push(id);
				const snapshot = snapshots.get(id);
				if (snapshot) apply([id], snapshot);
			});
			setPendingIds((current) => {
				const next = new Set(current);
				for (const id of ids) {
					if (versionById.current.get(id) === versions.get(id)) {
						next.delete(id);
					}
				}
				return next;
			});
			if (failedIds.length > 0) {
				setError(
					new Error(
						failedIds.length === 1
							? "The recording update failed and was rolled back."
							: `${failedIds.length} recording updates failed and were rolled back.`
					)
				);
			}
		},
		[apply, recordings, send]
	);

	return {
		pendingIds,
		error,
		mutate,
		clearError: () => setError(null)
	};
}

/**
 * Roll back only fields owned by the attempted action so a concurrent
 * lifecycle refresh cannot lose newer status, size, progress, or metadata.
 */
function captureOptimisticFields(
	recording: RecordingListItem,
	patch: Partial<Recording>
): Partial<Recording> {
	return {
		...(patch.manuallyProtected !== undefined
			? { manuallyProtected: recording.manuallyProtected }
			: {}),
		...(patch.watchedAt !== undefined
			? { watchedAt: recording.watchedAt }
			: {}),
		...(patch.resumePositionSeconds !== undefined
			? { resumePositionSeconds: recording.resumePositionSeconds }
			: {})
	};
}
