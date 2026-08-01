import { z } from "zod";

/** Playback events accepted by the bounded, privacy-preserving QoE endpoint. */
export const playbackTelemetryEventNameSchema = z.enum([
	"startup_completed",
	"stall_started",
	"stall_ended",
	"rendition_changed",
	"fatal_error",
	"session_ended"
]);

/** Coarse failure classes keep diagnostics useful without unbounded labels. */
export const playbackStallCauseSchema = z.enum([
	"network",
	"encoder",
	"source",
	"packaging",
	"decoder",
	"unknown"
]);

/** Quality values are intentionally closed so profile labels remain bounded. */
export const playbackTelemetryProfileSchema = z.enum([
	"auto",
	"direct",
	"original-quality",
	"1080p",
	"720p",
	"480p",
	"audio-only",
	"unknown"
]);

/**
 * A privacy-preserving playback observation.
 *
 * Identifiers and URLs are deliberately not part of this contract. Zod strips
 * unknown keys so older or compromised clients cannot turn them into metrics.
 */
export const playbackTelemetryEventSchema = z.object({
	event: playbackTelemetryEventNameSchema,
	media: z.enum(["live", "recording"]),
	client: z.enum(["web", "apple"]),
	profile: playbackTelemetryProfileSchema,
	cause: playbackStallCauseSchema.optional().default("unknown"),
	durationSeconds: z.number().finite().min(0).max(3_600).optional(),
	latencySeconds: z.number().finite().min(0).max(300).optional(),
	bufferAheadSeconds: z.number().finite().min(0).max(300).optional(),
	watchedDurationSeconds: z.number().finite().min(0).max(86_400).optional(),
	stallDurationSeconds: z.number().finite().min(0).max(3_600).optional(),
	pipelineSpeed: z.number().finite().min(0).max(100).optional()
});

export type PlaybackTelemetryEvent = z.infer<
	typeof playbackTelemetryEventSchema
>;
export type PlaybackStallCause = z.infer<typeof playbackStallCauseSchema>;
