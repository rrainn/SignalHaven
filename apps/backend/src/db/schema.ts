import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	customType,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
	dataType() {
		return "tsvector";
	}
});

export const tuners = pgTable("tuners", {
	id: uuid("id").primaryKey(),
	kind: text("kind").notNull(),
	name: text("name").notNull(),
	config: jsonb("config").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	// Persist sync health so cadence checks and the Settings UI survive restarts.
	lastLineupSyncAt: timestamp("last_lineup_sync_at", { withTimezone: true }),
	lastLineupSyncStatus: text("last_lineup_sync_status"),
	lastLineupSyncError: text("last_lineup_sync_error")
});

export const channels = pgTable(
	"channels",
	{
		id: uuid("id").primaryKey(),
		tunerId: uuid("tuner_id")
			.notNull()
			.references(() => tuners.id, { onDelete: "cascade" }),
		number: text("number").notNull(),
		// Provider identity remains stable when display numbers or lineup order change.
		providerChannelId: text("provider_channel_id"),
		name: text("name").notNull(),
		logoUrl: text("logo_url"),
		tvgId: text("tvg_id"),
		enabled: boolean("enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull(),
		// Require repeated successful misses before removing a stored channel.
		lineupMissingCount: integer("lineup_missing_count").notNull().default(0)
	},
	(table) => [
		index("channels_tuner_sort_idx").on(table.tunerId, table.sortOrder),
		uniqueIndex("channels_tuner_provider_channel_id_unique")
			.on(table.tunerId, table.providerChannelId)
			.where(sql`${table.providerChannelId} IS NOT NULL`),
		index("channels_tvg_id_idx").on(table.tvgId)
	]
);

export const epgSources = pgTable(
	"epg_sources",
	{
		id: uuid("id").primaryKey(),
		kind: text("kind").notNull(),
		name: text("name").notNull(),
		url: text("url"),
		filePath: text("file_path"),
		tunerId: uuid("tuner_id").references(() => tuners.id, {
			onDelete: "cascade"
		}),
		refreshIntervalMinutes: integer("refresh_interval_minutes")
			.notNull()
			.default(720),
		timezone: text("timezone"),
		enabled: boolean("enabled").notNull().default(true),
		lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
		lastRefreshStatus: text("last_refresh_status"),
		lastRefreshError: text("last_refresh_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull()
	},
	(table) => [
		index("epg_sources_kind_idx").on(table.kind),
		unique("epg_sources_hdhomerun_tuner_unique").on(table.tunerId)
	]
);

export const epgChannels = pgTable(
	"epg_channels",
	{
		id: uuid("id").primaryKey(),
		sourceId: uuid("source_id")
			.notNull()
			.references(() => epgSources.id, { onDelete: "cascade" }),
		externalId: text("external_id").notNull(),
		displayName: text("display_name").notNull(),
		// XMLTV may provide aliases such as a callsign and tuner guide number.
		displayNames: text("display_names")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`)
	},
	(table) => [
		unique("epg_channels_source_external_unique").on(
			table.sourceId,
			table.externalId
		)
	]
);

/** Durable episode metadata intentionally outlives transient guide broadcasts. */
export const episodes = pgTable("episodes", {
	identityKey: text("identity_key").primaryKey(),
	providerEpisodeId: text("provider_episode_id"),
	seriesKey: text("series_key").notNull(),
	season: integer("season"),
	episode: integer("episode"),
	subtitle: text("subtitle"),
	originalAirDate: date("original_air_date"),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
		.defaultNow()
		.notNull()
});

export const epgPrograms = pgTable(
	"epg_programs",
	{
		id: uuid("id").primaryKey(),
		epgChannelId: uuid("epg_channel_id")
			.notNull()
			.references(() => epgChannels.id, { onDelete: "cascade" }),
		externalId: text("external_id"),
		providerEpisodeId: text("provider_episode_id"),
		episodeIdentityKey: text("episode_identity_key").references(
			() => episodes.identityKey,
			{ onDelete: "set null" }
		),
		start: timestamp("start", { withTimezone: true }).notNull(),
		stop: timestamp("stop", { withTimezone: true }).notNull(),
		title: text("title").notNull(),
		subtitle: text("subtitle"),
		description: text("description"),
		episode: integer("episode"),
		season: integer("season"),
		originalAirDate: date("original_air_date"),
		broadcastNewness: text("broadcast_newness").notNull().default("unknown"),
		newnessSource: text("newness_source").notNull().default("none"),
		categories: text("categories")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		artworkUrl: text("artwork_url"),
		searchTsv: tsvector("search_tsv")
	},
	(table) => [
		index("epg_programs_epg_channel_start_idx").on(
			table.epgChannelId,
			table.start
		),
		index("epg_programs_search_tsv_idx").using("gin", table.searchTsv)
	]
);

export const channelEpgMap = pgTable("channel_epg_map", {
	channelId: uuid("channel_id")
		.primaryKey()
		.references(() => channels.id, { onDelete: "cascade" }),
	epgChannelId: uuid("epg_channel_id")
		.notNull()
		.references(() => epgChannels.id, { onDelete: "cascade" }),
	manual: boolean("manual").notNull().default(false)
});

export const recordings = pgTable(
	"recordings",
	{
		id: uuid("id").primaryKey(),
		channelId: uuid("channel_id")
			.notNull()
			.references(() => channels.id, { onDelete: "cascade" }),
		programId: uuid("program_id").references(() => epgPrograms.id, {
			onDelete: "set null"
		}),
		episodeIdentityKey: text("episode_identity_key").references(
			() => episodes.identityKey,
			{ onDelete: "set null" }
		),
		episodeSubtitle: text("episode_subtitle"),
		episodeDescription: text("episode_description"),
		episodeSeason: integer("episode_season"),
		episodeNumber: integer("episode_number"),
		episodeCategories: text("episode_categories")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		episodeArtworkUrl: text("episode_artwork_url"),
		episodeOriginalAirDate: date("episode_original_air_date"),
		title: text("title").notNull(),
		status: text("status").notNull(),
		scheduledStart: timestamp("scheduled_start", {
			withTimezone: true
		}).notNull(),
		scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
		actualStart: timestamp("actual_start", { withTimezone: true }),
		actualEnd: timestamp("actual_end", { withTimezone: true }),
		startReason: text("start_reason"),
		filePath: text("file_path"),
		fileSize: bigint("file_size", { mode: "number" }),
		durationSeconds: integer("duration_seconds"),
		errorMessage: text("error_message"),
		schedulerJobId: uuid("scheduler_job_id"),
		seriesRuleId: uuid("series_rule_id").references(() => seriesRules.id, {
			onDelete: "set null"
		}),
		manuallyProtected: boolean("manually_protected").notNull().default(false),
		watchedAt: timestamp("watched_at", { withTimezone: true }),
		resumePositionSeconds: integer("resume_position_seconds"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull()
	},
	(table) => [
		index("recordings_status_scheduled_start_idx").on(
			table.status,
			table.scheduledStart
		),
		index("recordings_series_rule_idx").on(table.seriesRuleId),
		index("recordings_episode_identity_idx").on(table.episodeIdentityKey),
		index("recordings_channel_scheduled_start_idx").on(
			table.channelId,
			table.scheduledStart
		),
		index("recordings_actual_start_idx").on(table.actualStart),
		// Guide annotation covers every recording state for each program.
		index("recordings_program_updated_idx").on(
			table.programId,
			table.updatedAt.desc()
		),
		// pg_trgm keeps the library's literal title search index-backed.
		index("recordings_title_trgm_idx").using(
			"gin",
			table.title.op("gin_trgm_ops")
		),
		uniqueIndex("recordings_active_program_unique")
			.on(table.programId)
			.where(
				sql`${table.programId} IS NOT NULL AND ${table.status} IN ('scheduled', 'recording')`
			)
	]
);

export const seriesRules = pgTable("series_rules", {
	id: uuid("id").primaryKey(),
	title: text("title").notNull(),
	channelId: uuid("channel_id").references(() => channels.id, {
		onDelete: "set null"
	}),
	epgChannelId: uuid("epg_channel_id").references(() => epgChannels.id, {
		onDelete: "set null"
	}),
	keepCount: integer("keep_count").notNull(),
	newOnly: boolean("new_only").notNull().default(false),
	episodePolicy: text("episode_policy").notNull().default("all"),
	priority: integer("priority").notNull().default(0),
	retentionDays: integer("retention_days"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull()
});

/** Atomic, durable claim preventing a rule from recording one episode twice. */
export const seriesRuleEpisodes = pgTable(
	"series_rule_episodes",
	{
		seriesRuleId: uuid("series_rule_id")
			.notNull()
			.references(() => seriesRules.id, { onDelete: "cascade" }),
		episodeIdentityKey: text("episode_identity_key")
			.notNull()
			.references(() => episodes.identityKey, { onDelete: "cascade" }),
		state: text("state").notNull(),
		recordingId: uuid("recording_id").references(() => recordings.id, {
			onDelete: "set null"
		}),
		claimedAt: timestamp("claimed_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull()
	},
	(table) => [
		unique("series_rule_episodes_identity_unique").on(
			table.seriesRuleId,
			table.episodeIdentityKey
		),
		index("series_rule_episodes_recording_idx")
			.on(table.recordingId)
			.where(sql`${table.recordingId} IS NOT NULL`)
	]
);

export const settings = pgTable("settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull()
});

export const scheduledJobs = pgTable(
	"scheduled_jobs",
	{
		id: uuid("id").primaryKey(),
		kind: text("kind").notNull(),
		payload: jsonb("payload")
			.notNull()
			.default(sql`'{}'::jsonb`),
		runAt: timestamp("run_at", { withTimezone: true }).notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(1),
		lastError: text("last_error"),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull()
	},
	(table) => [
		index("scheduled_jobs_status_run_at_idx").on(table.status, table.runAt),
		index("scheduled_jobs_kind_idx").on(table.kind)
	]
);

/** One durable analysis owner per recording prevents overlapping detector work. */
export const commercialAnalyses = pgTable("commercial_analyses", {
	recordingId: uuid("recording_id")
		.primaryKey()
		.references(() => recordings.id, { onDelete: "cascade" }),
	status: text("status").notNull(),
	scheduledJobId: uuid("scheduled_job_id"),
	detectorVersion: text("detector_version"),
	queuedAt: timestamp("queued_at", { withTimezone: true }),
	startedAt: timestamp("started_at", { withTimezone: true }),
	completedAt: timestamp("completed_at", { withTimezone: true }),
	failedAt: timestamp("failed_at", { withTimezone: true }),
	diagnosticMessage: text("diagnostic_message"),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull()
});

/** Normalized commercial intervals remain independent of raw detector files. */
export const commercialMarkers = pgTable(
	"commercial_markers",
	{
		id: uuid("id").primaryKey(),
		recordingId: uuid("recording_id")
			.notNull()
			.references(() => recordings.id, { onDelete: "cascade" }),
		startMs: integer("start_ms").notNull(),
		endMs: integer("end_ms").notNull()
	},
	(table) => [
		index("commercial_markers_recording_start_idx").on(
			table.recordingId,
			table.startMs
		)
	]
);

export const schema = {
	tuners,
	channels,
	epgSources,
	epgChannels,
	epgPrograms,
	channelEpgMap,
	recordings,
	seriesRules,
	settings,
	scheduledJobs,
	commercialAnalyses,
	commercialMarkers
};
