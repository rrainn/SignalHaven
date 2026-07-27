import "../zod-openapi-setup";

import { z } from "zod";

/**
 * Global search shared schemas (rrainn/SignalHaven#U10-search).
 *
 * The `GET /api/v1/search` endpoint returns three result groups —
 * channels, upcoming programs, and recordings — each capped per group
 * by the `limit` query parameter. Schemas live in `@signalhaven/shared` so
 * the backend response and the frontend `api-client` stay aligned.
 */

/** Hard caps mirrored on both ends of the API. */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;
/** Reject obviously-too-long inputs at the edge to avoid pathological tsquery cost. */
export const SEARCH_MAX_QUERY_LENGTH = 256;

/** Discriminator used by the frontend to dispatch click handlers. */
export const searchHitKindSchema = z.enum(["channel", "program", "recording"]);
export type SearchHitKind = z.infer<typeof searchHitKindSchema>;

export const searchChannelHitSchema = z.object({
	kind: z.literal("channel"),
	id: z.string().uuid(),
	number: z.string(),
	name: z.string(),
	logoUrl: z.string().nullable().default(null),
	/** Higher = better match (trigram similarity, 0..1, or 1.0 for exact prefix). */
	score: z.number()
});
export type SearchChannelHit = z.infer<typeof searchChannelHitSchema>;

export const searchProgramHitSchema = z.object({
	kind: z.literal("program"),
	id: z.string().uuid(),
	title: z.string(),
	subtitle: z.string().nullable().default(null),
	/** ISO 8601. */
	start: z.string(),
	/** ISO 8601. */
	stop: z.string(),
	channelId: z.string().uuid().nullable().default(null),
	channelName: z.string().nullable().default(null),
	channelNumber: z.string().nullable().default(null),
	/** `ts_rank_cd` value; relative ordering only. */
	score: z.number()
});
export type SearchProgramHit = z.infer<typeof searchProgramHitSchema>;

export const searchRecordingHitSchema = z.object({
	kind: z.literal("recording"),
	id: z.string().uuid(),
	title: z.string(),
	status: z.string(),
	/** ISO 8601. */
	scheduledStart: z.string(),
	channelId: z.string().uuid(),
	channelName: z.string().nullable().default(null),
	channelNumber: z.string().nullable().default(null),
	programId: z.string().uuid().nullable().default(null),
	score: z.number()
});
export type SearchRecordingHit = z.infer<typeof searchRecordingHitSchema>;

export const searchResponseSchema = z.object({
	q: z.string(),
	channels: z.array(searchChannelHitSchema),
	programs: z.array(searchProgramHitSchema),
	recordings: z.array(searchRecordingHitSchema)
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/**
 * Coerced query parameter schema for `GET /api/v1/search`.
 *
 * `q` is normalised to a trimmed string so the route handler can short
 * circuit on empty input without re-checking. `limit` clamps to
 * `[1, SEARCH_MAX_LIMIT]` so a malicious caller cannot ask the server
 * to return millions of rows.
 */
export const searchQuerySchema = z.object({
	q: z
		.string()
		.min(1)
		.max(SEARCH_MAX_QUERY_LENGTH)
		.transform((value) => value.trim())
		.refine((value) => value.length > 0, "q must not be empty"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(SEARCH_MAX_LIMIT)
		.optional()
		.default(SEARCH_DEFAULT_LIMIT)
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
