import "../zod-openapi-setup";

import { z } from "zod";

/**
 * Supported tuner kinds. Each kind has its own zod-validated config payload
 * (see `tunerConfigSchema` below) so the rest of the system can stay
 * tuner-agnostic while still rejecting malformed config at the API edge.
 */
export const tunerKindSchema = z.enum(["hdhomerun", "iptv", "hls"]);

export type TunerKind = z.infer<typeof tunerKindSchema>;

/** HDHomeRun network tuner: discovered by IP and queried over its HTTP API. */
export const hdhomerunConfigSchema = z.object({
	/** Either an IP/host or a `hdhomerun://` device URL. */
	host: z.string().min(1),
	/** Optional friendly device id (e.g. `103xxxxx`). */
	deviceId: z.string().min(1).optional()
});

/** IPTV / M3U playlist source. */
export const iptvConfigSchema = z.object({
	/** URL pointing at an `.m3u` / `.m3u8` playlist. */
	url: z.string().url(),
	/** Optional XMLTV EPG URL hint that pairs with this playlist. */
	epgUrl: z.string().url().optional()
});

/** Generic HLS endpoint (single live stream). */
export const hlsConfigSchema = z.object({
	/** URL pointing at the master `.m3u8` playlist. */
	url: z.string().url(),
	/** Display name for the single channel produced by this tuner. */
	channelName: z.string().min(1).optional()
});

/**
 * Validates the per-kind `config` blob. Discriminated on `kind` so a future
 * kind only needs to be registered in `tunerKindSchema` and added here.
 */
export const tunerConfigSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("hdhomerun"), config: hdhomerunConfigSchema }),
	z.object({ kind: z.literal("iptv"), config: iptvConfigSchema }),
	z.object({ kind: z.literal("hls"), config: hlsConfigSchema })
]);

const tunerCommonShape = {
	name: z.string().min(1).max(255)
};

/** POST body. Discriminated by `kind`; `config` is validated per kind. */
export const tunerCreateSchema = z.discriminatedUnion("kind", [
	z.object({
		...tunerCommonShape,
		kind: z.literal("hdhomerun"),
		config: hdhomerunConfigSchema
	}),
	z.object({
		...tunerCommonShape,
		kind: z.literal("iptv"),
		config: iptvConfigSchema
	}),
	z.object({
		...tunerCommonShape,
		kind: z.literal("hls"),
		config: hlsConfigSchema
	})
]);

export type TunerCreate = z.infer<typeof tunerCreateSchema>;

/**
 * PATCH body. `name` may be updated independently. `config` updates require
 * `kind` so we can pick the right per-kind schema; supplying `kind` without
 * `config` is rejected (and vice versa).
 */
export const tunerPatchSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		kind: tunerKindSchema.optional(),
		config: z.record(z.string(), z.unknown()).optional()
	})
	.refine(
		(value) => (value.kind === undefined) === (value.config === undefined),
		{
			message: "`kind` and `config` must be provided together",
			path: ["config"]
		}
	)
	.refine(
		(value) => {
			if (value.kind === undefined || value.config === undefined) {
				return true;
			}
			return tunerConfigSchema.safeParse({
				kind: value.kind,
				config: value.config
			}).success;
		},
		{
			message: "Config does not match the schema for the given kind",
			path: ["config"]
		}
	);

export type TunerPatch = z.infer<typeof tunerPatchSchema>;

/** Persisted tuner row, as returned by the API. */
export const tunerSchema = z.object({
	id: z.string().uuid(),
	kind: tunerKindSchema,
	name: z.string(),
	config: z.record(z.string(), z.unknown()),
	createdAt: z.string(),
	updatedAt: z.string(),
	/** Timestamp and outcome of the latest automatic or manual lineup import. */
	lastLineupSyncAt: z.string().nullable().optional(),
	lastLineupSyncStatus: z.enum(["success", "error"]).nullable().optional(),
	lastLineupSyncError: z.string().nullable().optional()
});

export type Tuner = z.infer<typeof tunerSchema>;

export const tunerListSchema = z.object({
	items: z.array(tunerSchema)
});

export type TunerList = z.infer<typeof tunerListSchema>;

/** Path parameter validator for `GET/PATCH/DELETE /api/v1/tuners/:id`. */
export const tunerIdParamSchema = z.object({
	id: z.string().uuid()
});

/** A capability descriptor returned by `provider.getCapabilities()`. */
export const tunerCapabilitiesSchema = z.object({
	supportsTranscoding: z.boolean(),
	/** Hard cap on simultaneous streams the underlying device can serve. */
	concurrentStreams: z.number().int().positive()
});

export type TunerCapabilities = z.infer<typeof tunerCapabilitiesSchema>;

/** Live status reported by `provider.getStatus()`. */
export const tunerStatusSchema = z.object({
	online: z.boolean(),
	/** Free-form detail (e.g. "device unreachable"); optional. */
	message: z.string().optional(),
	/** ISO timestamp of when this status was sampled. */
	checkedAt: z.string()
});

export type TunerStatus = z.infer<typeof tunerStatusSchema>;

/** A channel as advertised by a tuner's lineup. */
export const tunerLineupChannelSchema = z.object({
	/** Stable per-tuner channel id used by `provider.getStreamUrl(channelId)`. */
	channelId: z.string().min(1),
	/** Display channel number (e.g. "5.1"). */
	number: z.string().min(1),
	name: z.string().min(1),
	/** Provider guide identity, such as an M3U `tvg-id`. */
	tvgId: z.string().min(1).optional(),
	logoUrl: z.string().url().optional()
});

export type TunerLineupChannel = z.infer<typeof tunerLineupChannelSchema>;

export const tunerLineupSchema = z.array(tunerLineupChannelSchema);

/** Options passed to `provider.getStreamUrl()`. */
export const tunerStreamOptionsSchema = z.object({
	/** Request a transcoded stream when the provider supports it. */
	transcode: z.boolean().optional(),
	/** Optional preset name; provider-specific. */
	preset: z.string().min(1).optional()
});

export type TunerStreamOptions = z.infer<typeof tunerStreamOptionsSchema>;

export const tunerStreamUrlSchema = z.object({
	url: z.string().url()
});

export type TunerStreamUrl = z.infer<typeof tunerStreamUrlSchema>;

/**
 * One auto-discovered tuner candidate. Shape mirrors `tunerCreateSchema` so
 * the result can be POSTed straight back to `/api/v1/tuners`.
 */
export const tunerDiscoveryResultSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("hdhomerun"),
		name: z.string().min(1),
		config: hdhomerunConfigSchema
	}),
	z.object({
		kind: z.literal("iptv"),
		name: z.string().min(1),
		config: iptvConfigSchema
	}),
	z.object({
		kind: z.literal("hls"),
		name: z.string().min(1),
		config: hlsConfigSchema
	})
]);

export type TunerDiscoveryResult = z.infer<typeof tunerDiscoveryResultSchema>;

export const tunerDiscoveryResponseSchema = z.object({
	results: z.array(tunerDiscoveryResultSchema)
});

export type TunerDiscoveryResponse = z.infer<
	typeof tunerDiscoveryResponseSchema
>;

/**
 * Why a stream is occupying a tuner. Recordings outrank live viewing when
 * the {@link TunerAllocator} has to choose which lease to evict on
 * exhaustion (see `tunerAllocator.acquire`).
 */
export const tunerLeasePurposeSchema = z.enum(["live", "record"]);

export type TunerLeasePurpose = z.infer<typeof tunerLeasePurposeSchema>;

/**
 * One active lease tracked by {@link TunerAllocator}. Returned by
 * `GET /api/v1/tuners/activity` and embedded in `TUNER_UNAVAILABLE`
 * conflict details so callers can surface what's currently in the way.
 */
export const tunerLeaseSchema = z.object({
	/** Opaque id used to release the lease later. */
	leaseId: z.string().min(1),
	/** Persisted tuner row id this lease was issued against. */
	providerId: z.string().uuid(),
	/** Per-tuner channel id (from `provider.getLineup()`). */
	channelId: z.string().min(1),
	purpose: tunerLeasePurposeSchema,
	/** Caller-provided priority. Higher wins; ties go to the older lease. */
	priority: z.number().int(),
	/** ISO 8601 timestamp of when the lease was granted. */
	acquiredAt: z.string()
});

export type TunerLease = z.infer<typeof tunerLeaseSchema>;

/** Response body of `GET /api/v1/tuners/activity`. */
export const tunerActivityResponseSchema = z.object({
	leases: z.array(tunerLeaseSchema)
});

export type TunerActivityResponse = z.infer<typeof tunerActivityResponseSchema>;

/**
 * Stable error code returned (in `error.code`) when the allocator can't
 * satisfy an `acquire()` and no lower-priority lease is available to
 * pre-empt. The `error.details.conflicts` field carries the offending
 * {@link TunerLease}s so the UI can show "in use by ...".
 */
export const TUNER_UNAVAILABLE_ERROR_CODE = "TUNER_UNAVAILABLE";

/**
 * Response body for `POST /api/v1/tuners/:id/sync`. Reports how many
 * sources were added, updated, retained as missing, or marked unavailable.
 */
export const tunerSyncResponseSchema = z.object({
	/** Channels inserted from the tuner lineup that were not yet in the DB. */
	added: z.number().int().nonnegative(),
	/** Channels already in the DB whose name or logo changed in the lineup. */
	updated: z.number().int().nonnegative(),
	/** Deprecated compatibility counter; lineup sync never deletes source rows. */
	removed: z.number().int().nonnegative(),
	/** Sources retained in their group after reaching the missing threshold. */
	unavailable: z.number().int().nonnegative(),
	/** Channels retained while waiting for the consecutive-miss threshold. */
	missing: z.number().int().nonnegative(),
	/** Total persisted channels for this tuner after the sync. */
	total: z.number().int().nonnegative()
});

export type TunerSyncResponse = z.infer<typeof tunerSyncResponseSchema>;
