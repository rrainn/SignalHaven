import "../zod-openapi-setup";

import { z } from "zod";

/**
 * Schemas for the EPG **grid** (a.k.a. "guide") payload consumed by the
 * Frontend live grid view (U4-guide).
 *
 * The grid is a snapshot of every visible channel together with the
 * programs that intersect a given `[from, to]` time window. Channels are
 * always returned, even when they have no mapped EPG programs in the
 * window (the row is rendered with a "No guide data" placeholder).
 *
 * Both date-typed fields are serialised as ISO 8601 strings — JSON
 * consumers don't have to special case them, and the shared schema is
 * the single source of truth for client and server.
 */

/** A single channel row in the guide. */
export const epgGridChannelSchema = z.object({
	id: z.string().uuid(),
	number: z.string(),
	name: z.string(),
	logoUrl: z.string().nullable(),
	/** False when the channel has no EPG mapping yet. */
	hasMapping: z.boolean()
});

export type EpgGridChannel = z.infer<typeof epgGridChannelSchema>;

/** A single program cell positioned by `[start, stop]` on `channelId`. */
export const epgGridProgramSchema = z.object({
	id: z.string().uuid(),
	channelId: z.string().uuid(),
	start: z.string(),
	stop: z.string(),
	title: z.string(),
	subtitle: z.string().nullable(),
	/** Recording row that owns the status, used for cancellation actions. */
	recordingId: z.string().uuid().nullable(),
	/**
	 * Lifecycle of any recording attached to this program. `null` when
	 * the program isn't being / hasn't been recorded.
	 */
	recordingStatus: z
		.enum(["scheduled", "recording", "completed", "failed", "cancelled"])
		.nullable()
});

export type EpgGridProgram = z.infer<typeof epgGridProgramSchema>;

/** Rich metadata loaded only when a user asks to see program details. */
export const epgProgramSchema = epgGridProgramSchema.extend({
	description: z.string().nullable(),
	categories: z.array(z.string()).default([])
});

export type EpgProgram = z.infer<typeof epgProgramSchema>;

/** Params for the stable program-details route used by search results. */
export const epgProgramIdParamSchema = z.object({
	id: z.string().uuid()
});

/** Program details include the mapped tuner channel needed for live viewing. */
export const epgProgramDetailsSchema = z.object({
	program: epgProgramSchema,
	channel: epgGridChannelSchema
});

export type EpgProgramDetails = z.infer<typeof epgProgramDetailsSchema>;

/** Query params for `GET /api/v1/epg/grid`. */
export const epgGridQuerySchema = z.object({
	from: z.string(),
	to: z.string()
});

export type EpgGridQuery = z.infer<typeof epgGridQuerySchema>;

/** Full grid payload returned by `GET /api/v1/epg/grid`. */
export const epgGridSchema = z.object({
	from: z.string(),
	to: z.string(),
	channels: z.array(epgGridChannelSchema),
	programs: z.array(epgGridProgramSchema)
});

export type EpgGrid = z.infer<typeof epgGridSchema>;
