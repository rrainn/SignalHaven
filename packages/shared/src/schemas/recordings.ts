import "../zod-openapi-setup";

import { z } from "zod";

/**
 * Lifecycle states for a one-off recording row. Rows transition
 *
 *   scheduled -> recording -> completed | failed | cancelled
 *
 * Each transition emits a WS event on the `recordings` topic.
 */
export const recordingStatusSchema = z.enum([
	"scheduled",
	"recording",
	"completed",
	"failed",
	"cancelled"
]);

export type RecordingStatus = z.infer<typeof recordingStatusSchema>;

/**
 * Durable explanation for a recording that began after its scheduled start.
 * `null` means the program itself started on time, even if some pre-padding
 * was unavailable after recovery.
 */
export const recordingStartReasonSchema = z.enum(["late_start"]);

export type RecordingStartReason = z.infer<typeof recordingStartReasonSchema>;

/**
 * Persisted recording row, as returned by the API. Date-typed fields are
 * serialised as ISO 8601 strings so JSON consumers don't have to
 * special-case them.
 */
export const recordingSchema = z.object({
	id: z.string().uuid(),
	channelId: z.string().uuid(),
	programId: z.string().uuid().nullable(),
	title: z.string(),
	status: recordingStatusSchema,
	scheduledStart: z.string(),
	scheduledEnd: z.string(),
	actualStart: z.string().nullable(),
	actualEnd: z.string().nullable(),
	startReason: recordingStartReasonSchema.nullable().default(null),
	filePath: z.string().nullable(),
	fileSize: z.number().nullable(),
	durationSeconds: z.number().nullable(),
	errorMessage: z.string().nullable(),
	/** Set when the row was created by a series rule (rrainn/SignalHaven#R3-series). */
	seriesRuleId: z.string().uuid().nullable().default(null),
	/** When true, automatic `keepCount` eviction will leave this row alone. */
	manuallyProtected: z.boolean().default(false),
	/**
	 * ISO 8601 timestamp recorded when the user marks the recording
	 * watched. `null` indicates the player has never reached the
	 * watched threshold for this row.
	 */
	watchedAt: z.string().nullable().default(null),
	/**
	 * Last known playback position in seconds, used by the player to
	 * resume an interrupted viewing session. `null` means the user has
	 * not started playback yet (or has reset progress).
	 */
	resumePositionSeconds: z.number().int().min(0).nullable().default(null)
});

export type Recording = z.infer<typeof recordingSchema>;

/**
 * EPG-derived metadata bundled with `GET /api/v1/recordings/:id`. All
 * fields are optional because the recording may have been scheduled
 * without a linked program (one-off recording from `start`/`end`) or
 * the originating program row may have since been pruned.
 */
export const recordingMetadataSchema = z.object({
	subtitle: z.string().nullable(),
	description: z.string().nullable(),
	episode: z.number().int().nullable(),
	season: z.number().int().nullable(),
	categories: z.array(z.string()),
	artworkUrl: z.string().nullable(),
	originalAirDate: z.string().nullable().default(null)
});

export type RecordingMetadata = z.infer<typeof recordingMetadataSchema>;

/** Durable lifecycle for optional post-recording commercial analysis. */
export const commercialAnalysisStatusSchema = z.enum([
	"not_requested",
	"queued",
	"running",
	"completed",
	"failed"
]);

export type CommercialAnalysisStatus = z.infer<
	typeof commercialAnalysisStatusSchema
>;

/** Commercial boundaries use integer milliseconds throughout the API and DB. */
export const commercialMarkerSchema = z
	.object({
		startMs: z.number().int().min(0),
		endMs: z.number().int().positive()
	})
	.refine((marker) => marker.endMs > marker.startMs, {
		message: "Commercial marker end must be after its start"
	});

export type CommercialMarker = z.infer<typeof commercialMarkerSchema>;

/** Analysis state and normalized markers returned with recording detail. */
export const commercialAnalysisSchema = z.object({
	status: commercialAnalysisStatusSchema,
	queuedAt: z.string().nullable(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	failedAt: z.string().nullable(),
	diagnosticMessage: z.string().nullable(),
	detectorVersion: z.string().nullable(),
	markers: z.array(commercialMarkerSchema)
});

export type CommercialAnalysis = z.infer<typeof commercialAnalysisSchema>;

/**
 * Detail response for `GET /api/v1/recordings/:id`. Extends the base
 * recording with the EPG-derived metadata (when available).
 */
export const recordingDetailSchema = recordingSchema.extend({
	metadata: recordingMetadataSchema.nullable(),
	commercialAnalysis: commercialAnalysisSchema.default({
		status: "not_requested",
		queuedAt: null,
		startedAt: null,
		completedAt: null,
		failedAt: null,
		diagnosticMessage: null,
		detectorVersion: null,
		markers: []
	})
});

export type RecordingDetail = z.infer<typeof recordingDetailSchema>;

/**
 * Bounded library row returned by `GET /api/v1/recordings`. Metadata is
 * batch-loaded for the visible page so cards and series views can render rich
 * episode information without issuing one detail request per recording.
 */
export const recordingListItemSchema = recordingSchema.extend({
	metadata: recordingMetadataSchema.nullable().default(null)
});

export type RecordingListItem = z.infer<typeof recordingListItemSchema>;

/** Default page size for the filtered listing endpoint. */
export const RECORDING_LIST_DEFAULT_LIMIT = 50;
/** Hard cap to keep the listing endpoint cheap. */
export const RECORDING_LIST_MAX_LIMIT = 200;

/**
 * Sort key for the listing endpoint. `scheduledStart` is the default
 * (chronological program order); `actualStart` orders by when the
 * recording actually started; `createdAt` orders by row creation.
 */
export const recordingListSortSchema = z.enum([
	"scheduledStart",
	"actualStart",
	"createdAt"
]);

export type RecordingListSort = z.infer<typeof recordingListSortSchema>;

export const recordingListDirectionSchema = z.enum(["asc", "desc"]);

export type RecordingListDirection = z.infer<
	typeof recordingListDirectionSchema
>;

/**
 * Query string for `GET /api/v1/recordings`. All fields are optional;
 * `from` / `to` filter on `scheduledStart` (inclusive lower bound /
 * strict upper bound) so callers can paginate by date window safely.
 *
 * Numeric fields arrive as strings on the wire; `coerce` (with strict
 * bounds checks below) keeps the wire contract HTTP-friendly without
 * giving up type safety.
 */
export const recordingListQuerySchema = z.object({
	/** Literal, case-insensitive title search. */
	search: z.string().trim().max(200).optional(),
	status: recordingStatusSchema.optional(),
	channelId: z.string().uuid().optional(),
	seriesRuleId: z.string().uuid().optional(),
	from: z.string().datetime({ offset: true }).optional(),
	to: z.string().datetime({ offset: true }).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(RECORDING_LIST_MAX_LIMIT)
		.default(RECORDING_LIST_DEFAULT_LIMIT),
	offset: z.coerce.number().int().min(0).default(0),
	/**
	 * Opaque keyset cursor returned by the previous page. `offset` remains in
	 * the response for accessible progress copy, but cursor paging prevents
	 * inserts or deletes ahead of the current page from shifting later rows.
	 */
	cursor: z.string().min(1).max(1024).optional(),
	sort: recordingListSortSchema.default("scheduledStart"),
	direction: recordingListDirectionSchema.default("desc")
});

export type RecordingListQuery = z.infer<typeof recordingListQuerySchema>;

/** Complete aggregate for a series represented in the current page. */
export const recordingSeriesGroupSchema = z.object({
	seriesRuleId: z.string().uuid(),
	title: z.string(),
	recordingCount: z.number().int().min(0),
	totalSize: z.number().min(0)
});

export type RecordingSeriesGroup = z.infer<typeof recordingSeriesGroupSchema>;

/** Complete aggregate for one-off rows when the current page contains one. */
export const recordingOneOffGroupSchema = z.object({
	recordingCount: z.number().int().min(0),
	totalSize: z.number().min(0)
});

export type RecordingOneOffGroup = z.infer<typeof recordingOneOffGroupSchema>;

/** Paginated wrapper returned by `GET /api/v1/recordings`. */
export const recordingListSchema = z.object({
	items: z.array(recordingListItemSchema),
	/** Total rows matching the filters (ignores `limit` / `offset`). */
	total: z.number().int().min(0).default(0),
	/** Sum of known file sizes across every row matching the filters. */
	totalSize: z.number().min(0).default(0),
	limit: z.number().int().min(1).default(RECORDING_LIST_DEFAULT_LIMIT),
	offset: z.number().int().min(0).default(0),
	/** Opaque keyset cursor for the next stable page, or `null` at the end. */
	nextCursor: z.string().nullable().default(null),
	/**
	 * Full-library counts for series encountered on this bounded page. The
	 * client merges these summaries while appending pages.
	 */
	seriesGroups: z.array(recordingSeriesGroupSchema).default([]),
	/** Full-library one-off aggregate when one-off rows occur on this page. */
	oneOffGroup: recordingOneOffGroupSchema.nullable().default(null)
});

export type RecordingList = z.infer<typeof recordingListSchema>;

/**
 * POST body. `start` / `end` are ISO 8601 timestamps; `end` must be
 * strictly after `start` (and at least one second long so we never
 * schedule a zero-length recording).
 */
export const recordingCreateSchema = z
	.object({
		channelId: z.string().uuid(),
		title: z.string().min(1).max(255),
		start: z.string().datetime({ offset: true }),
		end: z.string().datetime({ offset: true }),
		programId: z.string().uuid().optional()
	})
	.refine(
		(value) => new Date(value.end).getTime() > new Date(value.start).getTime(),
		{ message: "`end` must be strictly after `start`", path: ["end"] }
	);

export type RecordingCreate = z.infer<typeof recordingCreateSchema>;

/**
 * POST body for `/api/v1/recordings/by-program`. The server resolves the
 * channel via the channel ↔ EPG mapping and copies the program's
 * `start` / `stop` (with the configured padding) into the recording.
 */
export const recordingByProgramCreateSchema = z.object({
	programId: z.string().uuid(),
	/** Selects the intended tuner variant when several share one EPG channel. */
	channelId: z.string().uuid().optional()
});

export type RecordingByProgramCreate = z.infer<
	typeof recordingByProgramCreateSchema
>;

/**
 * Idempotent result for `POST /api/v1/recordings/by-program`.
 * `created=false` means an active schedule already owned the program.
 */
export const recordingByProgramResponseSchema = z.object({
	recording: recordingSchema,
	created: z.boolean()
});

export type RecordingByProgramResponse = z.infer<
	typeof recordingByProgramResponseSchema
>;

/** Path parameter validator for `GET / DELETE /api/v1/recordings/:id`. */
export const recordingIdParamSchema = z.object({
	id: z.string().uuid()
});

/**
 * Query string for `DELETE /api/v1/recordings/:id`. `keepFile=true`
 * preserves the on-disk recording (the row is still removed); the
 * default removes both row and file.
 */
export const recordingDeleteQuerySchema = z.object({
	keepFile: z
		.union([z.literal("true"), z.literal("false"), z.boolean()])
		.optional()
		.transform((v) => v === true || v === "true"),
	/**
	 * Protected rows reject ordinary deletion. The UI only sends this flag
	 * after the user explicitly chooses to delete protected recordings.
	 */
	overrideProtection: z
		.union([z.literal("true"), z.literal("false"), z.boolean()])
		.optional()
		.transform((v) => v === true || v === "true")
});

export type RecordingDeleteQuery = z.infer<typeof recordingDeleteQuerySchema>;

/**
 * Patch body for `PATCH /api/v1/recordings/:id`. Drives the player's
 * mark-as-watched + resume-position bookkeeping and the user's
 * "protect" flag. All fields are optional; supplying `null` for
 * `watchedAt` / `resumePositionSeconds` clears the state.
 */
export const recordingPatchSchema = z
	.object({
		watchedAt: z.string().datetime({ offset: true }).nullable().optional(),
		/**
		 * Convenience flag: `true` sets `watchedAt` to "now" server-side;
		 * `false` clears it. Mutually exclusive with `watchedAt`.
		 */
		watched: z.boolean().optional(),
		resumePositionSeconds: z.number().int().min(0).nullable().optional(),
		manuallyProtected: z.boolean().optional()
	})
	.refine(
		(value) => !(value.watched !== undefined && value.watchedAt !== undefined),
		{ message: "Specify either `watched` or `watchedAt`, not both" }
	);

export type RecordingPatch = z.infer<typeof recordingPatchSchema>;

/** Result of `POST /api/v1/recordings/library/scan`. */
export const recordingLibraryScanResultSchema = z.object({
	/** Recordings whose `file_path` no longer exists on disk. */
	missingFiles: z.number().int().min(0),
	/** Files in the recordings dir with no matching DB row. */
	orphanFiles: z.number().int().min(0),
	/** Recordings whose `file_size` was refreshed from disk. */
	resized: z.number().int().min(0),
	/** Total files scanned. */
	scanned: z.number().int().min(0)
});

export type RecordingLibraryScanResult = z.infer<
	typeof recordingLibraryScanResultSchema
>;

/** Stable reason set used in `errorMessage` for non-user-facing failures. */
export const RECORDING_FAILED_PROCESS_TERMINATED = "process_terminated";
/** Recording recovery found no capture time before the padded cutoff. */
export const RECORDING_FAILED_MISSED_WINDOW = "missed_window";
/** The next bounded retry would leave less than one second to capture. */
export const RECORDING_FAILED_RETRY_WINDOW_EXHAUSTED = "retry_window_exhausted";
/** The bounded number of transient recovery attempts has been consumed. */
export const RECORDING_FAILED_RETRIES_EXHAUSTED = "retries_exhausted";
/** Storage or another recording configuration is invalid. */
export const RECORDING_FAILED_CONFIGURATION = "configuration_error";
/** The persisted channel or tuner configuration cannot produce a source. */
export const RECORDING_FAILED_SOURCE_CONFIGURATION =
	"source_configuration_error";

/**
 * Stable error code returned by `POST /api/v1/recordings/by-program`
 * when the program's EPG channel has no tuner-channel mapping. Surfaced
 * as `ErrorResponse.code` so clients can prompt the user to set the
 * mapping (the 409 status indicates the precondition isn't met).
 */
export const RECORDING_CHANNEL_UNMAPPED_ERROR_CODE = "channel_unmapped";

/** Stable error code returned when an EPG program has already ended. */
export const RECORDING_PROGRAM_NOT_RECORDABLE_ERROR_CODE =
	"program_not_recordable";
