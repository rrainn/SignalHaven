import {
	recordingEventMessageSchema,
	type EventMessage,
	type Recording,
	type RecordingEventName
} from "@signalhaven/shared";

/** Normalized recording event consumed by every live DVR screen. */
export interface ParsedRecordingEvent {
	event: RecordingEventName;
	recording: Recording;
}

/**
 * Validates a WebSocket message against the shared recording contract.
 * Unsupported topic/event combinations return `null` instead of mutating UI.
 */
export function parseRecordingEvent(
	message: EventMessage
): ParsedRecordingEvent | null {
	const parsed = recordingEventMessageSchema.safeParse(message);
	if (!parsed.success) return null;
	return {
		event: parsed.data.event,
		recording: parsed.data.data
	};
}
