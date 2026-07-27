import "../zod-openapi-setup";

import { z } from "zod";

/** Strategies the EPG matcher may use, in descending confidence order. */
export const epgMatchStrategySchema = z.enum([
	"tvg-id",
	"channel-number",
	"display-name",
	"normalized-name",
	"stream-metadata-name",
	"channel-number-prefix"
]);

export type EpgMatchStrategy = z.infer<typeof epgMatchStrategySchema>;

/** A single ranked candidate returned by `GET /channels/:id/epg-candidates`. */
export const epgCandidateSchema = z.object({
	epgChannelId: z.string().uuid(),
	sourceId: z.string().uuid(),
	externalId: z.string(),
	displayName: z.string(),
	strategy: epgMatchStrategySchema,
	/** 0–100; higher is a better match. */
	score: z.number().int().min(0).max(100)
});

export type EpgCandidate = z.infer<typeof epgCandidateSchema>;

export const epgCandidatesResponseSchema = z.object({
	channelId: z.string().uuid(),
	candidates: z.array(epgCandidateSchema)
});

export type EpgCandidatesResponse = z.infer<typeof epgCandidatesResponseSchema>;

/** PUT body for `/channels/:id/epg-mapping`. */
export const channelEpgMappingPutSchema = z.object({
	epgChannelId: z.string().uuid()
});

export type ChannelEpgMappingPut = z.infer<typeof channelEpgMappingPutSchema>;

/** Persisted mapping, returned by the mapping PUT endpoint. */
export const channelEpgMappingSchema = z.object({
	channelId: z.string().uuid(),
	epgChannelId: z.string().uuid(),
	/** True when the mapping was set manually; auto-match never overwrites it. */
	manual: z.boolean()
});

export type ChannelEpgMapping = z.infer<typeof channelEpgMappingSchema>;

export const channelIdParamSchema = z.object({
	id: z.string().uuid()
});
