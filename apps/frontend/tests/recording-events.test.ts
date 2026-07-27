import { describe, expect, it } from "vitest";
import {
	RECORDING_EVENT,
	type EventMessage,
	type Recording
} from "@signalhaven/shared";

import { parseRecordingEvent } from "../lib/recording-events";

const recording: Recording = {
	id: "99999999-9999-4999-8999-999999999999",
	channelId: "00000000-0000-4000-8000-000000000001",
	programId: "88888888-8888-4888-8888-888888888888",
	title: "Contract test",
	status: "scheduled",
	scheduledStart: "2026-01-01T11:30:00Z",
	scheduledEnd: "2026-01-01T12:30:00Z",
	actualStart: null,
	actualEnd: null,
	startReason: null,
	filePath: null,
	fileSize: null,
	durationSeconds: null,
	errorMessage: null,
	seriesRuleId: null,
	manuallyProtected: false,
	watchedAt: null,
	resumePositionSeconds: null
};

describe("recording lifecycle event contract", () => {
	it("accepts every recording event name published by the backend", () => {
		for (const event of Object.values(RECORDING_EVENT)) {
			const message: EventMessage = {
				type: "event",
				topic: "recordings",
				event,
				data: recording,
				ts: "2026-01-01T12:00:00Z"
			};

			expect(parseRecordingEvent(message)).toEqual({ event, recording });
		}
	});

	it("rejects unsupported recording event names", () => {
		expect(
			parseRecordingEvent({
				type: "event",
				topic: "recordings",
				event: "recordings.updated",
				data: recording,
				ts: "2026-01-01T12:00:00Z"
			})
		).toBeNull();
	});
});
