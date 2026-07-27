import "../zod-openapi-setup";

import { z } from "zod";

import { recordingSchema } from "./recordings";

/**
 * Topics clients may subscribe to on the WebSocket event bus mounted at
 * `/api/v1/events`. Adding a new event type generally means adding a new
 * topic here so the client/server share a single source of truth.
 */
export const eventTopicSchema = z.enum([
	"recordings",
	"tuners",
	"epg",
	"jobs",
	"settings"
]);

export type EventTopic = z.infer<typeof eventTopicSchema>;

/**
 * Recording events published by the backend on the `recordings` topic.
 * Keeping the names here prevents producers and consumers from drifting.
 */
export const RECORDING_EVENT = {
	scheduled: "recording.scheduled",
	started: "recording.started",
	rescheduled: "recording.rescheduled",
	completed: "recording.completed",
	failed: "recording.failed",
	cancelled: "recording.cancelled",
	deleted: "recording.deleted"
} as const;

export const recordingEventNameSchema = z.enum(
	Object.values(RECORDING_EVENT) as [
		(typeof RECORDING_EVENT)[keyof typeof RECORDING_EVENT],
		...(typeof RECORDING_EVENT)[keyof typeof RECORDING_EVENT][]
	]
);

export type RecordingEventName = z.infer<typeof recordingEventNameSchema>;

/**
 * Inbound (client -> server) messages.
 */
export const subscribeMessageSchema = z.object({
	type: z.literal("subscribe"),
	topics: z.array(eventTopicSchema).min(1)
});

export const unsubscribeMessageSchema = z.object({
	type: z.literal("unsubscribe"),
	topics: z.array(eventTopicSchema).min(1)
});

export const clientPingMessageSchema = z.object({
	type: z.literal("ping")
});

export const clientMessageSchema = z.discriminatedUnion("type", [
	subscribeMessageSchema,
	unsubscribeMessageSchema,
	clientPingMessageSchema
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * Outbound (server -> client) messages.
 */
export const eventMessageSchema = z.object({
	type: z.literal("event"),
	topic: eventTopicSchema,
	event: z.string(),
	// Payload shape is defined per (topic, event) by the publishing module.
	data: z.unknown(),
	// Server timestamp (ISO 8601) so clients can detect stale buffered events.
	ts: z.string()
});

export type EventMessage = z.infer<typeof eventMessageSchema>;

/** A validated recording event with the public recording payload. */
export const recordingEventMessageSchema = eventMessageSchema.extend({
	topic: z.literal("recordings"),
	event: recordingEventNameSchema,
	data: recordingSchema
});

export type RecordingEventMessage = z.infer<typeof recordingEventMessageSchema>;

export const ackMessageSchema = z.object({
	type: z.literal("ack"),
	action: z.enum(["subscribe", "unsubscribe"]),
	topics: z.array(eventTopicSchema)
});

export const errorMessageSchema = z.object({
	type: z.literal("error"),
	code: z.string(),
	message: z.string()
});

export const pongMessageSchema = z.object({
	type: z.literal("pong")
});

export const serverMessageSchema = z.discriminatedUnion("type", [
	eventMessageSchema,
	ackMessageSchema,
	errorMessageSchema,
	pongMessageSchema
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
