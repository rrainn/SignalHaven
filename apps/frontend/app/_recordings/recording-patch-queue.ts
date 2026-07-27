import type { RecordingPatch } from "@signalhaven/shared";

/** Request options retained until an ordered patch reaches the sender. */
export interface RecordingPatchQueueOptions {
	keepalive?: boolean;
}

export type RecordingPatchSender = (
	patch: RecordingPatch,
	options?: RecordingPatchQueueOptions
) => Promise<void>;

/**
 * Serialize recording patches so a slow older request can never overwrite a
 * newer resume position, watched flag, or protection choice on the server.
 */
export class OrderedRecordingPatchQueue {
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly send: RecordingPatchSender) {}

	/** Append one patch while allowing the queue to continue after failures. */
	enqueue(
		patch: RecordingPatch,
		options?: RecordingPatchQueueOptions
	): Promise<void> {
		return this.enqueueWith(this.send, patch, options);
	}

	/**
	 * Serialize a patch that needs a caller-specific sender, such as a detail
	 * action with a richer response, behind the same playback progress queue.
	 */
	enqueueWith<Result>(
		send: (
			patch: RecordingPatch,
			options?: RecordingPatchQueueOptions
		) => Promise<Result>,
		patch: RecordingPatch,
		options?: RecordingPatchQueueOptions
	): Promise<Result> {
		const operation = this.tail.then(() => send(patch, options));
		// Convert the result to void so every sender shape shares one queue tail.
		this.tail = operation.then(
			() => undefined,
			() => undefined
		);
		return operation;
	}
}
