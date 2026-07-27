import "../zod-openapi-setup";

import { z } from "zod";

/**
 * Supported EPG source kinds.
 *
 * - `xmltv`: a remote URL or local file pointing at an XMLTV document.
 * - `hdhomerun_guide`: Silicondust guide data associated with a configured
 *   HDHomeRun tuner. SignalHaven resolves the tuner's rotating `DeviceAuth` token
 *   at refresh time instead of persisting the credential.
 */
export const epgSourceKindSchema = z.enum(["xmltv", "hdhomerun_guide"]);

export type EpgSourceKind = z.infer<typeof epgSourceKindSchema>;

const baseShape = {
	name: z.string().min(1).max(255),
	kind: epgSourceKindSchema,
	url: z.string().url().nullish(),
	filePath: z.string().min(1).nullish(),
	tunerId: z.string().uuid().nullish(),
	refreshIntervalMinutes: z
		.number()
		.int()
		.min(5)
		.max(7 * 24 * 60)
		.default(720),
	timezone: z.string().min(1).max(64).nullish(),
	enabled: z.boolean().default(true)
};

/** POST body for creating an EPG source. */
export const epgSourceCreateSchema = z
	.object(baseShape)
	.superRefine((value, context) => {
		if (value.kind === "xmltv" && !value.url && !value.filePath) {
			context.addIssue({
				code: "custom",
				message: "An XMLTV URL or file path must be provided",
				path: ["url"]
			});
		}
		if (value.kind === "hdhomerun_guide" && !value.url && !value.tunerId) {
			context.addIssue({
				code: "custom",
				message: "An HDHomeRun tuner must be provided",
				path: ["tunerId"]
			});
		}
	});

export type EpgSourceCreate = z.infer<typeof epgSourceCreateSchema>;

/** PATCH body for updating an EPG source. All fields optional. */
export const epgSourcePatchSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	url: z.string().url().nullish(),
	filePath: z.string().min(1).nullish(),
	tunerId: z.string().uuid().nullish(),
	refreshIntervalMinutes: z
		.number()
		.int()
		.min(5)
		.max(7 * 24 * 60)
		.optional(),
	timezone: z.string().min(1).max(64).nullish(),
	enabled: z.boolean().optional()
});

export type EpgSourcePatch = z.infer<typeof epgSourcePatchSchema>;

/** Persisted EPG source row, returned by the API. */
export const epgSourceSchema = z.object({
	id: z.string().uuid(),
	kind: epgSourceKindSchema,
	name: z.string(),
	url: z.string().nullable(),
	filePath: z.string().nullable(),
	// Default preserves compatibility during rolling frontend/backend deploys.
	tunerId: z.string().uuid().nullable().default(null),
	refreshIntervalMinutes: z.number().int(),
	timezone: z.string().nullable(),
	enabled: z.boolean(),
	lastRefreshAt: z.string().nullable(),
	lastRefreshStatus: z.string().nullable(),
	lastRefreshError: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string()
});

export type EpgSource = z.infer<typeof epgSourceSchema>;

export const epgSourceListSchema = z.object({
	items: z.array(epgSourceSchema)
});

export type EpgSourceList = z.infer<typeof epgSourceListSchema>;

export const epgSourceIdParamSchema = z.object({
	id: z.string().uuid()
});

/** Outcome reported by `POST /api/v1/epg/sources/:id/refresh`. */
export const epgRefreshResultSchema = z.object({
	channelsSeen: z.number().int(),
	programsSeen: z.number().int(),
	channelsUpserted: z.number().int(),
	/** Compatibility total for programs inserted or changed. */
	programsUpserted: z.number().int(),
	programsInserted: z.number().int(),
	programsChanged: z.number().int(),
	programsUnchanged: z.number().int(),
	programsPruned: z.number().int(),
	durationMs: z.number().int()
});

export type EpgRefreshResult = z.infer<typeof epgRefreshResultSchema>;
