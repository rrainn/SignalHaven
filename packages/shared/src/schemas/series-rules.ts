import "../zod-openapi-setup";

import { z } from "zod";

/** How a series rule handles broadcasts whose provider newness is unknown. */
export const episodePolicySchema = z.enum([
	"all",
	"confirmed_new",
	"new_and_unknown"
]);

export type EpisodePolicy = z.infer<typeof episodePolicySchema>;

/**
 * A "season pass" rule (rrainn/SignalHaven#R3-series). The evaluator scans
 * upcoming EPG programs whose title matches `title` (case-insensitive),
 * optionally restricted to a single tuner channel or EPG channel, and
 * schedules a recording per matching program.
 *
 *   * `episodePolicy` — use provider-backed newness without treating a short
 *     guide cache as broadcast history.
 *   * `keepCount` — after a recording finishes, the oldest extra
 *     completed recordings produced by this rule are deleted (rows
 *     marked `manuallyProtected` are never evicted). When age retention
 *     is also configured, either policy may remove an eligible recording
 *     first.
 *   * `priority` — used by the conflict resolver: when tuners would be
 *     exhausted by competing series-rule candidates, the lowest
 *     priority candidate is dropped first.
 */
export const seriesRuleSchema = z.object({
	id: z.string().uuid(),
	title: z.string(),
	channelId: z.string().uuid().nullable(),
	epgChannelId: z.string().uuid().nullable(),
	keepCount: z.number().int().min(1),
	episodePolicy: episodePolicySchema,
	/** @deprecated Compatibility projection; prefer `episodePolicy`. */
	newOnly: z.boolean(),
	priority: z.number().int(),
	/**
	 * Maximum age, in days, for completed recordings produced by this
	 * rule. When set, recordings older than this are auto-deleted during
	 * library maintenance (independent of `keepCount`). `null` disables
	 * the age-based eviction (only `keepCount` applies).
	 */
	retentionDays: z.number().int().min(1).max(36500).nullable().default(null),
	createdAt: z.string(),
	updatedAt: z.string()
});

export type SeriesRule = z.infer<typeof seriesRuleSchema>;

export const seriesRuleListSchema = z.object({
	items: z.array(seriesRuleSchema)
});

export type SeriesRuleList = z.infer<typeof seriesRuleListSchema>;

export const seriesRuleCreateSchema = z.object({
	title: z.string().min(1).max(255),
	channelId: z.string().uuid().nullish(),
	epgChannelId: z.string().uuid().nullish(),
	keepCount: z.number().int().min(1).max(1000).default(5),
	episodePolicy: episodePolicySchema.optional(),
	/** @deprecated Accepted for older clients during the policy migration. */
	newOnly: z.boolean().optional(),
	priority: z.number().int().min(-100).max(100).default(0),
	retentionDays: z.number().int().min(1).max(36500).nullish()
});

export type SeriesRuleCreate = z.infer<typeof seriesRuleCreateSchema>;

export const seriesRulePatchSchema = z
	.object({
		title: z.string().min(1).max(255),
		channelId: z.string().uuid().nullable(),
		epgChannelId: z.string().uuid().nullable(),
		keepCount: z.number().int().min(1).max(1000),
		episodePolicy: episodePolicySchema,
		/** @deprecated Accepted for older clients during the policy migration. */
		newOnly: z.boolean(),
		priority: z.number().int().min(-100).max(100),
		retentionDays: z.number().int().min(1).max(36500).nullable()
	})
	.partial();

export type SeriesRulePatch = z.infer<typeof seriesRulePatchSchema>;

export const seriesRuleIdParamSchema = z.object({
	id: z.string().uuid()
});

/**
 * Stable reasons published on the `recordings` topic when the series
 * evaluator drops a candidate due to a conflict.
 */
export const recordingConflictReasonSchema = z.enum([
	"tuner_capacity",
	"duplicate"
]);

export type RecordingConflictReason = z.infer<
	typeof recordingConflictReasonSchema
>;

export const recordingConflictSchema = z.object({
	/** Stable client-supplied id so polling clients can dedupe. */
	id: z.string().uuid(),
	seriesRuleId: z.string().uuid().nullable(),
	programId: z.string().uuid().nullable(),
	channelId: z.string().uuid(),
	title: z.string(),
	scheduledStart: z.string(),
	scheduledEnd: z.string(),
	reason: recordingConflictReasonSchema,
	/**
	 * Account-safe description suitable for rendering directly to the user.
	 */
	message: z.string(),
	/**
	 * Compatibility field intentionally kept empty because peer identifiers
	 * may belong to another account.
	 */
	conflictsWith: z.array(z.string()).default([]),
	detectedAt: z.string()
});

export type RecordingConflict = z.infer<typeof recordingConflictSchema>;

export const recordingConflictListSchema = z.object({
	items: z.array(recordingConflictSchema)
});

export type RecordingConflictList = z.infer<typeof recordingConflictListSchema>;

/** WS event names emitted on the `recordings` topic by the evaluator. */
export const SERIES_RULE_EVENT = {
	evaluated: "series.evaluated",
	conflict: "recording.conflict",
	evicted: "recording.evicted"
} as const;
