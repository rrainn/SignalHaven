import "../zod-openapi-setup";

import { z } from "zod";

/**
 * Per-key zod schemas for user-configurable settings persisted in the
 * `settings` table. Each top-level key in `settingsSchema` maps to one row
 * (key = field name, value = JSON document validated by its sub-schema).
 *
 * Keep these schemas conservative: every field needs a sane default in
 * `settingsDefaults` so a fresh install can return a fully populated
 * settings document before the user has saved anything.
 */
export const storageSettingsSchema = z.object({
	/**
	 * Absolute path on disk where recordings are written. `null` means the
	 * user has not configured storage yet — used to drive first-run UX.
	 */
	path: z.string().min(1).nullable(),
	/**
	 * Maximum total size, in gigabytes, the recordings library is allowed
	 * to occupy on disk. When the sum of `recordings.file_size` rises
	 * above this threshold, the oldest non-`manuallyProtected` rows are
	 * deleted (file + DB row) until the library fits inside the quota.
	 * `null` disables the quota entirely (unlimited).
	 */
	quotaGb: z.number().positive().max(1_000_000).nullable().default(null)
});

/**
 * Output quality profile selected per-stream. Profiles map to a fixed
 * resolution/bitrate target plus a codec strategy; the actual ffmpeg
 * arguments are built by the backend transcoder.
 *
 *   * `direct`           — passthrough; no transcoding (assumes the
 *                          upstream is already browser-friendly).
 *   * `original-quality` — keep the source resolution but transcode video
 *                          to h264 / audio to aac when the source codec
 *                          would otherwise be unplayable in browsers.
 *   * `1080p` / `720p` / `480p` — scale + transcode to a fixed ladder.
 *   * `audio-only`       — drop video; emit an audio-only HLS variant.
 */
export const transcodeProfileSchema = z.enum([
	"direct",
	"original-quality",
	"1080p",
	"720p",
	"480p",
	"audio-only"
]);

export type TranscodeProfile = z.infer<typeof transcodeProfileSchema>;

/** Concrete ffmpeg hardware-acceleration backends we know how to drive. */
export const hwaccelKindSchema = z.enum([
	"videotoolbox",
	"vaapi",
	"qsv",
	"nvenc"
]);

export type HwaccelKind = z.infer<typeof hwaccelKindSchema>;

/**
 * User-configurable hwaccel preference. `auto` lets the backend pick the
 * best detected backend; `none` forces software encoding; specifying a
 * kind pins it (and falls back to software if the detection later finds
 * the kind unavailable, with a warning logged).
 */
export const hwaccelSettingSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	hwaccelKindSchema
]);

export type HwaccelSetting = z.infer<typeof hwaccelSettingSchema>;

export const transcodingSettingsSchema = z.object({
	enabled: z.boolean(),
	preset: z.enum(["fast", "balanced", "quality"]),
	videoBitrateKbps: z.number().int().positive().max(100_000),
	audioBitrateKbps: z.number().int().positive().max(1024),
	/** Profile served when no `?profile=` query param is supplied. */
	defaultProfile: transcodeProfileSchema,
	/** User preference; resolved against `availableHwaccels` at runtime. */
	hwaccel: hwaccelSettingSchema,
	/**
	 * Hwaccels detected by the backend at startup. Persisted so the UI
	 * can surface them to the user; populated by the backend probe and
	 * generally not edited by the user directly.
	 */
	availableHwaccels: z.array(hwaccelKindSchema),
	/**
	 * Whether to extract EIA-608/708 closed captions from the upstream
	 * MPEG-TS into a WebVTT subtitle track exposed via the HLS master
	 * playlist (rrainn/SignalHaven#23). Captions extraction spawns a small
	 * sidecar ffmpeg per session; turning this off globally is a
	 * performance escape hatch for low-power hosts or for upstream
	 * sources that don't carry CC data.
	 */
	captionsEnabled: z.boolean()
});

/**
 * Visual density of the design system. `comfortable` is the default
 * spacing the layouts ship with; `compact` tightens vertical rhythm so
 * power users can fit more onto a screen (typically applied via a
 * `data-density="compact"` attribute on `<html>`).
 */
export const densitySchema = z.enum(["comfortable", "compact"]);

export type Density = z.infer<typeof densitySchema>;

export const uiSettingsSchema = z.object({
	theme: z.enum(["light", "dark", "system"]),
	epgHoursVisible: z.number().int().min(1).max(24),
	use24HourClock: z.boolean(),
	/**
	 * Visual density of the layout. See {@link densitySchema}.
	 */
	density: densitySchema.default("comfortable"),
	/**
	 * Whether non-essential UI animations / transitions are enabled.
	 * `false` is honoured in addition to the system
	 * `prefers-reduced-motion` media query, so users can opt out
	 * irrespective of OS settings.
	 */
	animations: z.boolean().default(true)
});

/**
 * Recording-specific knobs. Padding values are absolute seconds applied
 * symmetrically around every scheduled recording's [start, end] window
 * (so a 30 second pre-padding starts ffmpeg 30 seconds early). Both
 * default to 0 — no padding — to match the rrainn/SignalHaven#R1-oneoff
 * acceptance criteria.
 */
export const recordingsSettingsSchema = z.object({
	paddingBeforeSec: z.number().int().min(0).max(3600),
	paddingAfterSec: z.number().int().min(0).max(3600),
	/**
	 * Optional post-processing stays inert until explicitly enabled. Zod strips
	 * the former detectorPath property from persisted rows during upgrades because
	 * executable selection now belongs to deployment configuration.
	 */
	commercialDetection: z
		.object({
			enabled: z.boolean(),
			detectorVersion: z.string().min(1).max(100)
		})
		.optional()
});

/** Disposable rolling-buffer policy for live television. */
export const timeShiftSettingsSchema = z.object({
	/** Disabled mode preserves the original short low-latency live playlist. */
	enabled: z.boolean().default(true),
	/** Directory for disposable segments; `null` uses the operating-system temp dir. */
	bufferPath: z.string().min(1).nullable().default(null),
	/** Maximum playable history retained for each active channel session. */
	durationMinutes: z.number().int().min(1).max(240).default(60),
	/** Aggregate allowance for all disposable time-shift sessions. */
	maxDiskGb: z.number().positive().max(10_000).default(10),
	/** How long a channel buffer remains reusable after its last viewer leaves. */
	idleGraceSeconds: z.number().int().min(0).max(3_600).default(30)
});

export type TimeShiftSettings = z.infer<typeof timeShiftSettingsSchema>;

/** Automatic tuner-lineup import policy. */
export const lineupSyncSettingsSchema = z.object({
	enabled: z.boolean().default(true),
	/** Imports run from an hourly scheduler tick when this interval is due. */
	intervalHours: z.number().int().min(1).max(168).default(24),
	/** Successful misses before a retained source becomes unavailable. */
	removalThreshold: z.number().int().min(2).max(10).default(3)
});

export type LineupSyncSettings = z.infer<typeof lineupSyncSettingsSchema>;

/**
 * User-tweakable preferences for the channel-centric list view (U5).
 *
 * All three lists store channel UUIDs:
 *   * `favorites` — channels the user has starred. Surfaced in the
 *     "Favorites" filter and used to bubble channels to the top of the
 *     list when sort = "favorites first".
 *   * `hidden`    — channels the user has hidden via bulk actions. Hidden
 *     channels are excluded from the guide and the channels list by
 *     default; the dedicated "Hidden" filter reveals them so they can
 *     be unhidden.
 *   * `order`     — manual sort order (channel ids in display order).
 *     Channels not present in the array fall back to the server-assigned
 *     `sortOrder`, appended in canonical order. Drag-to-reorder writes
 *     this list.
 *
 * Each list is bounded to keep the settings document small; the bound
 * is an order of magnitude above the realistic channel count.
 */
export const channelsSettingsSchema = z.object({
	favorites: z.array(z.string().uuid()).max(10_000).default([]),
	hidden: z.array(z.string().uuid()).max(10_000).default([]),
	order: z.array(z.string().uuid()).max(10_000).default([])
});

export type ChannelsSettings = z.infer<typeof channelsSettingsSchema>;

/**
 * Persistent player preferences (rrainn/SignalHaven#U6-player).
 *
 *   * `volume` — last set volume in [0..1]. Mirrored to the `<video>`
 *     element's `volume` on mount so the user is never blasted with a
 *     fresh default after they tuned it down.
 *   * `muted`  — last mute state. Restored alongside `volume`.
 *   * `captionsEnabled` — last "captions on" toggle. The actual track
 *     surfaced is whichever the master playlist exposes (S3 sidecar);
 *     this just controls visibility.
 *   * `qualityByChannel` — per-channel S2 transcode-profile pin. When
 *     present the player loads `?profile=...` for that channel; when
 *     absent the player asks the backend for whatever its global
 *     default is. Bounded to the realistic channel count.
 */
export const playerSettingsSchema = z.object({
	volume: z.number().min(0).max(1).default(1),
	muted: z.boolean().default(false),
	captionsEnabled: z.boolean().default(false),
	qualityByChannel: z
		.record(z.string().uuid(), transcodeProfileSchema)
		.default({})
});

export type PlayerSettings = z.infer<typeof playerSettingsSchema>;

/**
 * Observability settings.
 *
 *   * `debugBundleEnabled` — when `true`, the `GET /api/v1/debug/bundle`
 *     endpoint is active and returns a diagnostics ZIP archive.  Disabled
 *     by default; operators enable it temporarily when diagnosing issues.
 */
export const observabilitySettingsSchema = z.object({
	debugBundleEnabled: z.boolean().default(false)
});

export type ObservabilitySettings = z.infer<typeof observabilitySettingsSchema>;

export const settingsSchema = z.object({
	storage: storageSettingsSchema,
	transcoding: transcodingSettingsSchema,
	ui: uiSettingsSchema,
	recordings: recordingsSettingsSchema,
	timeShift: timeShiftSettingsSchema.default({
		enabled: true,
		bufferPath: null,
		durationMinutes: 60,
		maxDiskGb: 10,
		idleGraceSeconds: 30
	}),
	// Optional in the public type so pre-feature settings snapshots remain valid.
	lineupSync: lineupSyncSettingsSchema.optional(),
	channels: channelsSettingsSchema,
	player: playerSettingsSchema,
	observability: observabilitySettingsSchema
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;

/**
 * Partial PATCH body. Each provided top-level key replaces the full value
 * for that key (the per-key schema is enforced strictly), but unspecified
 * keys are left untouched server-side.
 */
export const settingsPatchSchema = settingsSchema.partial().extend({
	// The full document accepts a missing legacy key, but PATCH must not
	// materialize time-shift unless the caller intentionally supplied it.
	timeShift: timeShiftSettingsSchema.optional()
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Defaults for every setting; used as the seed for a fresh install. */
export const settingsDefaults: Settings = {
	storage: {
		path: null,
		quotaGb: null
	},
	transcoding: {
		enabled: false,
		preset: "balanced",
		videoBitrateKbps: 4000,
		audioBitrateKbps: 192,
		defaultProfile: "direct",
		hwaccel: "auto",
		availableHwaccels: [],
		captionsEnabled: true
	},
	ui: {
		theme: "system",
		epgHoursVisible: 4,
		use24HourClock: false,
		density: "comfortable",
		animations: true
	},
	recordings: {
		paddingBeforeSec: 0,
		paddingAfterSec: 0,
		commercialDetection: {
			enabled: false,
			detectorVersion: "comskip-edl-v1"
		}
	},
	timeShift: {
		enabled: true,
		bufferPath: null,
		durationMinutes: 60,
		maxDiskGb: 10,
		idleGraceSeconds: 30
	},
	lineupSync: {
		enabled: true,
		intervalHours: 24,
		removalThreshold: 3
	},
	channels: {
		favorites: [],
		hidden: [],
		order: []
	},
	player: {
		volume: 1,
		muted: false,
		captionsEnabled: false,
		qualityByChannel: {}
	},
	observability: {
		debugBundleEnabled: false
	}
};

/**
 * High-level system status used by the UI to decide whether to render the
 * onboarding flow and which panels to gate.
 */
export const systemStatusSchema = z.object({
	firstRun: z.boolean(),
	hasTuners: z.boolean(),
	hasEpg: z.boolean(),
	hasStorage: z.boolean()
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;
