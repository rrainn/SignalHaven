import type { RecordingPatch } from "@signalhaven/shared";
import { describe, expect, it, vi } from "vitest";

import { OrderedRecordingPatchQueue } from "../../app/_recordings/recording-patch-queue";

/** Create a promise whose completion is controlled by the test. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("OrderedRecordingPatchQueue", () => {
	it("waits for an older write before sending a newer playback position", async () => {
		const first = deferred<void>();
		const sent: RecordingPatch[] = [];
		const sender = vi.fn(async (patch: RecordingPatch) => {
			sent.push(patch);
			if (sent.length === 1) await first.promise;
		});
		const queue = new OrderedRecordingPatchQueue(sender);

		const older = queue.enqueue({ resumePositionSeconds: 120 });
		const newer = queue.enqueue({ resumePositionSeconds: 180 });
		await Promise.resolve();

		expect(sender).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([{ resumePositionSeconds: 120 }]);

		first.resolve();
		await Promise.all([older, newer]);
		expect(sent).toEqual([
			{ resumePositionSeconds: 120 },
			{ resumePositionSeconds: 180 }
		]);
	});

	it("continues after a failed write so later state can reconcile", async () => {
		const sender = vi
			.fn<(patch: RecordingPatch) => Promise<void>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(undefined);
		const queue = new OrderedRecordingPatchQueue(sender);

		await expect(queue.enqueue({ watched: true })).rejects.toThrow("offline");
		await expect(
			queue.enqueue({ manuallyProtected: true })
		).resolves.toBeUndefined();
		expect(sender).toHaveBeenCalledTimes(2);
	});
});
