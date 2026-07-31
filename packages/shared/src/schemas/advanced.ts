import "../zod-openapi-setup";

import { z } from "zod";

/** One FFmpeg process that an operator may inspect or stop. */
export const ffmpegWorkItemSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["live-stream", "recording", "recording-playback"]),
	label: z.string().min(1),
	channelId: z.string().optional(),
	recordingId: z.string().optional(),
	state: z.string().min(1),
	startedAt: z.string(),
	profile: z.string().optional(),
	hwaccel: z.string().nullable().optional(),
	clientCount: z.number().int().nonnegative().optional()
});

export const ffmpegWorkListSchema = z.object({
	items: z.array(ffmpegWorkItemSchema)
});

export type FfmpegWorkItem = z.infer<typeof ffmpegWorkItemSchema>;
export type FfmpegWorkList = z.infer<typeof ffmpegWorkListSchema>;

/** One active Comskip commercial-analysis process visible to operators. */
export const comskipWorkItemSchema = z.object({
	id: z.string().min(1),
	recordingId: z.string().min(1),
	label: z.string().min(1),
	state: z.literal("running"),
	startedAt: z.string()
});

export const comskipWorkListSchema = z.object({
	items: z.array(comskipWorkItemSchema)
});

export type ComskipWorkItem = z.infer<typeof comskipWorkItemSchema>;
export type ComskipWorkList = z.infer<typeof comskipWorkListSchema>;

/** External address reported by the SignalHaven server's IP lookup. */
export const externalIpResponseSchema = z.object({
	ip: z.string().min(1)
});

export type ExternalIpResponse = z.infer<typeof externalIpResponseSchema>;

/** Best-effort RF measurements reported by an active HDHomeRun tuner. */
export const channelQualitySchema = z.object({
	channelId: z.string().uuid(),
	active: z.boolean(),
	checkedAt: z.string(),
	tunerIndex: z.number().int().nonnegative().optional(),
	lock: z.string().optional(),
	signalStrengthPercent: z.number().min(0).max(100).optional(),
	signalQualityPercent: z.number().min(0).max(100).optional(),
	symbolQualityPercent: z.number().min(0).max(100).optional(),
	networkRateMbps: z.number().nonnegative().optional()
});

export type ChannelQuality = z.infer<typeof channelQualitySchema>;

/** Server-side details paired with browser playback statistics. */
export const streamStatusSchema = z.object({
	channelId: z.string(),
	profile: z.string(),
	hwaccel: z.string().nullable(),
	state: z.string(),
	startedAt: z.string(),
	refCount: z.number().int().nonnegative(),
	timeShift: z.object({
		enabled: z.boolean(),
		windowSeconds: z.number(),
		bufferBytes: z.number(),
		maxBufferBytes: z.number().nullable()
	}),
	pipeline: z.object({
		mode: z.enum(["remux", "transcode"]),
		health: z.enum(["starting", "healthy", "slow", "stalled"]),
		speed: z.number().nonnegative().nullable(),
		fps: z.number().nonnegative().nullable(),
		outputTimeSeconds: z.number().nonnegative().nullable(),
		lastProgressAt: z.string().nullable(),
		progressAgeSeconds: z.number().nonnegative().nullable()
	}),
	lastError: z
		.object({
			category: z.string().optional(),
			message: z.string(),
			ts: z.string()
		})
		.nullable()
});

export type StreamStatus = z.infer<typeof streamStatusSchema>;
