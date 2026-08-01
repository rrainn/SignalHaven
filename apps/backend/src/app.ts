import cors from "cors";
import compression from "compression";
import express, { json, urlencoded, type Express } from "express";

import { db, pool } from "./db/client";
import { EpgService } from "./epg/epg.service";
import { CommercialAnalysisService } from "./commercials/commercial-analysis.service";
import { resolveComskipPath } from "./commercials/comskip-detector";
import { EpgGridService } from "./epg/epg-grid.service";
import { EpgMatcherService } from "./epg/epg-matcher.service";
import { getEventBus } from "./events";
import type { EventBus } from "./events/event-bus";
import { isProduction, resolveEnvironment } from "./http/env";
import {
	createLogger,
	httpLogger,
	resolveLogFilePath
} from "./http/middleware/logger";
import { errorHandler, notFoundHandler } from "./http/middleware/errors";
import { requestId } from "./http/middleware/request-id";
import { createApiV1Router } from "./http/router";
import {
	createSettingsBackedRecordingsConfig,
	RecordingsService
} from "./recordings/recordings.service";
import { ChannelEpgMapRepository } from "./repositories/channel-epg-map.repository";
import { ChannelsRepository } from "./repositories/channels.repository";
import { LogicalChannelEpgMapRepository } from "./repositories/logical-channel-epg-map.repository";
import { EpgChannelsRepository } from "./repositories/epg-channels.repository";
import { EpgProgramsRepository } from "./repositories/epg-programs.repository";
import { EpgSourcesRepository } from "./repositories/epg-sources.repository";
import { HealthRepository } from "./repositories/health.repository";
import { RecordingsRepository } from "./repositories/recordings.repository";
import { CommercialsRepository } from "./repositories/commercials.repository";
import { ScheduledJobsRepository } from "./repositories/scheduled-jobs.repository";
import { SearchRepository } from "./repositories/search.repository";
import { SeriesRulesRepository } from "./repositories/series-rules.repository";
import { SeriesEpisodeClaimsRepository } from "./repositories/series-episode-claims.repository";
import { SettingsRepository } from "./repositories/settings.repository";
import { TunersRepository } from "./repositories/tuners.repository";
import { Scheduler } from "./scheduler/scheduler";
import { SearchService } from "./search/search.service";
import { SeriesRulesService } from "./series/series-rules.service";
import { SettingsService } from "./settings/settings.service";
import { DefaultChannelStreamResolver } from "./streaming/channel-resolver";
import { detectHwaccels, resolveHwaccel } from "./streaming/hwaccel";
import {
	StreamingService,
	type TimeShiftResolver,
	type TranscodingResolver
} from "./streaming/streaming.service";
import { SystemStatusService } from "./system/system-status.service";
import { createDefaultTunerRegistry } from "./tuners/registry";
import { TunersService } from "./tuners/tuners.service";
import { TunerLineupSyncService } from "./tuners/tuner-lineup-sync.service";
import {
	createErrorReporter,
	type ErrorReporter
} from "./observability/error-reporter";
import {
	MetricsCollector,
	createMetricsMiddleware,
	DB_DURATION_BUCKETS,
	EPG_DURATION_BUCKETS,
	HTTP_DURATION_BUCKETS
} from "./observability/metrics";

export interface CreateAppOptions {
	env?: NodeJS.ProcessEnv;
	healthRepository?: HealthRepository;
	settingsService?: SettingsService;
	systemStatusService?: SystemStatusService;
	tunersService?: TunersService;
	lineupSyncService?: TunerLineupSyncService;
	/** Override the channels repository used by the tuner-sync endpoint. */
	channelsRepository?: ChannelsRepository;
	epgService?: EpgService;
	epgGridService?: EpgGridService;
	epgMatcherService?: EpgMatcherService;
	streamingService?: StreamingService;
	recordingsService?: RecordingsService;
	seriesRulesService?: SeriesRulesService;
	searchService?: SearchService;
	scheduler?: Scheduler;
	bus?: EventBus;
	/** Override the error reporter (defaults to the no-op reporter). */
	errorReporter?: ErrorReporter;
	/**
	 * Hook for tests to register additional routes before the 404 handler runs.
	 * Receives the v1 router so test-only endpoints participate in validation,
	 * error handling and request id middleware.
	 */
	configureV1Router?: (router: import("express").Router) => void;
}

export interface CreatedApp {
	app: Express;
	scheduler: Scheduler;
	tunersService: TunersService;
	lineupSyncService: TunerLineupSyncService;
	epgService: EpgService;
	epgMatcherService: EpgMatcherService;
	recordingsService: RecordingsService;
	seriesRulesService: SeriesRulesService;
	metrics: MetricsCollector;
}

export function createApp(options: CreateAppOptions = {}): Express {
	return createAppWithServices(options).app;
}

/**
 * Build the express app together with the long-lived background services
 * (the scheduler and recordings service) so the entry point in
 * {@link ./index} can start them after migrations have run. Tests that
 * only need the HTTP surface continue to use {@link createApp} which
 * discards the service handles.
 */
export function createAppWithServices(
	options: CreateAppOptions = {}
): CreatedApp {
	const env = options.env ?? process.env;
	const environment = resolveEnvironment(env);
	const logger = createLogger(env);
	const errorReporter = options.errorReporter ?? createErrorReporter(env);
	const healthRepository =
		options.healthRepository ?? new HealthRepository(pool);
	const bus = options.bus ?? getEventBus();
	const settingsService =
		options.settingsService ??
		new SettingsService({
			repository: new SettingsRepository(db),
			bus
		});
	const systemStatusService =
		options.systemStatusService ??
		new SystemStatusService({
			database: db,
			settings: settingsService
		});
	const tunersService =
		options.tunersService ??
		new TunersService({
			repository: new TunersRepository(db),
			registry: createDefaultTunerRegistry(),
			bus
		});
	const channelsRepository =
		options.channelsRepository ?? new ChannelsRepository(db);
	const epgGridService =
		options.epgGridService ??
		new EpgGridService({
			channels: new ChannelsRepository(db),
			channelEpgMap: new LogicalChannelEpgMapRepository(db),
			epgPrograms: new EpgProgramsRepository(db),
			recordings: new RecordingsRepository(db)
		});
	const epgMatcherService =
		options.epgMatcherService ??
		new EpgMatcherService({
			channelsRepository: new ChannelsRepository(db),
			epgChannelsRepository: new EpgChannelsRepository(db),
			epgSourcesRepository: new EpgSourcesRepository(db),
			channelEpgMapRepository: new ChannelEpgMapRepository(db),
			logicalChannelEpgMapRepository: new LogicalChannelEpgMapRepository(db),
			bus,
			onMappingsChanged: () => epgGridService.invalidateSnapshot()
		});
	const streamingService =
		options.streamingService ??
		new StreamingService({
			allocator: tunersService.getAllocator(),
			resolver: new DefaultChannelStreamResolver(
				new ChannelsRepository(db),
				tunersService
			),
			bus,
			logger,
			transcodingResolver:
				createSettingsBackedTranscodingResolver(settingsService),
			timeShiftResolver: createSettingsBackedTimeShiftResolver(settingsService)
		});
	const scheduler =
		options.scheduler ??
		new Scheduler({
			bus,
			jobsRepository: new ScheduledJobsRepository(db),
			// Background detector processes remain bounded on low-power DVR hosts.
			maxConcurrencyByKind: { "commercial-analysis": 1 }
		});
	const lineupSyncService =
		options.lineupSyncService ??
		new TunerLineupSyncService({
			channels: channelsRepository,
			tuners: tunersService,
			bus,
			onSyncComplete: async () => {
				// Persisted channel metadata must be visible before mappings refresh.
				epgGridService.invalidateSnapshot();
				await epgMatcherService.autoMatchUnmapped();
			},
			resolveRemovalThreshold: async () =>
				(await settingsService.getAll()).lineupSync?.removalThreshold ?? 3,
			resolveSchedule: async () => {
				const { enabled, intervalHours } = (await settingsService.getAll())
					.lineupSync ?? { enabled: true, intervalHours: 24 };
				return { enabled, intervalHours };
			}
		});
	const recordingsRepository = new RecordingsRepository(db);
	const commercialAnalysis = options.recordingsService
		? undefined
		: new CommercialAnalysisService({
				repository: new CommercialsRepository(db),
				recordings: recordingsRepository,
				scheduler,
				bus,
				resolveConfig: async () => {
					const { commercialDetection } = (await settingsService.getAll())
						.recordings;
					return {
						enabled: commercialDetection?.enabled ?? false,
						detectorVersion:
							commercialDetection?.detectorVersion ?? "comskip-edl-v1",
						executablePath: resolveComskipPath(env)
					};
				}
			});
	const recordingsService =
		options.recordingsService ??
		new RecordingsService({
			repository: recordingsRepository,
			scheduler,
			allocator: tunersService.getAllocator(),
			resolver: new DefaultChannelStreamResolver(
				new ChannelsRepository(db),
				tunersService
			),
			config: createSettingsBackedRecordingsConfig(() =>
				settingsService.getAll()
			),
			epgPrograms: new EpgProgramsRepository(db),
			channelEpgMap: new LogicalChannelEpgMapRepository(db),
			seriesRules: new SeriesRulesRepository(db),
			logger,
			bus,
			...(commercialAnalysis ? { commercialAnalysis } : {}),
			playbackOptions: {
				// Re-read hardware settings for each fresh VOD session so recordings
				// follow the same safe fallback behavior as live transcoding.
				resolveHwaccel: async () => {
					const current = await settingsService.getAll();
					return resolveHwaccel(
						current.transcoding.hwaccel,
						current.transcoding.availableHwaccels
					);
				}
			}
		});
	// Subscribe to `recording.completed` so storage-quota + per-series
	// retention enforcement run automatically (rrainn/SignalHaven#R4-library).
	recordingsService.attachLibraryMaintenance();
	const epgService =
		options.epgService ??
		new EpgService({
			repository: new EpgSourcesRepository(db),
			pool,
			bus,
			scheduler,
			matcher: epgMatcherService,
			resolveHdhomerunGuideUrl: async (tunerId) => {
				const provider = await tunersService.getProviderById(tunerId);
				if (
					provider.kind !== "hdhomerun" ||
					typeof provider.getGuideUrl !== "function"
				) {
					throw new Error(
						`Tuner ${tunerId} does not support an HDHomeRun guide`
					);
				}
				return provider.getGuideUrl();
			},
			// After every successful EPG refresh, re-arm scheduled recordings
			// whose linked program may have shifted (rrainn/SignalHaven#R2-epg-record),
			// and re-run the series-rule evaluator (rrainn/SignalHaven#R3-series) so
			// newly-discovered episodes are scheduled immediately.
			onRefreshComplete: async () => {
				await recordingsService.reconcileProgramSchedules();
				await seriesRulesService.evaluate().catch(() => undefined);
			},
			onMappingsChanged: () => epgGridService.invalidateSnapshot()
		});

	const seriesRulesService =
		options.seriesRulesService ??
		new SeriesRulesService({
			rules: new SeriesRulesRepository(db),
			recordings: new RecordingsRepository(db),
			epgPrograms: new EpgProgramsRepository(db),
			channels: new ChannelsRepository(db),
			channelEpgMap: new LogicalChannelEpgMapRepository(db),
			episodeClaims: new SeriesEpisodeClaimsRepository(db),
			schedule: (input) =>
				recordingsService.schedule({
					channelId: input.channelId,
					title: input.title,
					start: input.start,
					end: input.end,
					programId: input.programId,
					seriesRuleId: input.seriesRuleId
				}),
			// Route keep-count eviction through the recording service so active
			// playback sessions are stopped before their source files are removed.
			deleteRecording: (id) => recordingsService.delete(id),
			capacity: async (providerId) => {
				try {
					const provider = await tunersService.getProviderById(providerId);
					return provider.getCapabilities().concurrentStreams;
				} catch {
					return null;
				}
			},
			logger,
			bus
		});
	// Subscribe to `recording.completed` so finished episodes trigger
	// `keepCount` enforcement automatically.
	seriesRulesService.attachBus();

	const searchService =
		options.searchService ?? new SearchService(new SearchRepository(db));

	// ---------------------------------------------------------------------------
	// Metrics
	// ---------------------------------------------------------------------------

	const metrics = new MetricsCollector()
		// HTTP
		.registerCounter(
			"http_requests_total",
			"Total number of HTTP requests, partitioned by method, route and status"
		)
		.registerHistogram(
			"http_request_duration_seconds",
			"HTTP request latency in seconds",
			HTTP_DURATION_BUCKETS
		)
		// Streaming
		.registerGauge(
			"stream_sessions_active",
			"Number of currently active HLS stream sessions"
		)
		.registerGauge(
			"ffmpeg_processes_total",
			"Number of ffmpeg processes currently running"
		)
		// Playback QoE labels are closed enums so metrics remain safe to aggregate.
		.registerHistogram(
			"playback_startup_duration_seconds",
			"Time from playback request to the first rendered frame in seconds",
			[1, 2, 3, 5, 8, 12, 20, 30]
		)
		.registerCounter(
			"playback_rebuffer_events_total",
			"Total number of completed playback rebuffer events"
		)
		.registerHistogram(
			"playback_rebuffer_duration_seconds",
			"Duration of playback rebuffer events in seconds",
			[0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60]
		)
		.registerHistogram(
			"playback_rebuffer_ratio",
			"Fraction of watched playback time spent rebuffering",
			[0.0001, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
		)
		.registerCounter(
			"playback_rendition_changes_total",
			"Total number of adaptive rendition changes"
		)
		.registerCounter(
			"playback_fatal_errors_total",
			"Total number of fatal playback errors"
		)
		.registerHistogram(
			"playback_live_latency_seconds",
			"Observed distance from the live edge in seconds",
			[2, 4, 6, 8, 10, 12, 15, 18, 24, 30, 60]
		)
		.registerCounter(
			"playback_pipeline_under_speed_total",
			"Adaptive pipelines stopped after sustained output below real time"
		)
		// Recordings
		.registerGauge(
			"recordings_active",
			"Number of recordings currently in progress"
		)
		// EPG
		.registerHistogram(
			"epg_refresh_duration_seconds",
			"Duration of EPG source refresh operations in seconds",
			EPG_DURATION_BUCKETS
		)
		// DB
		.registerHistogram(
			"db_query_duration_seconds",
			"Duration of database query operations in seconds",
			DB_DURATION_BUCKETS
		);

	// Capacity failures arrive on existing bounded event topics without identifiers.
	bus.subscribe("tuners", ({ event, data }) => {
		if (
			event === "session.error" &&
			(data as { category?: unknown }).category === "encoder_capacity"
		) {
			metrics.incrementCounter("playback_pipeline_under_speed_total", {
				media: "live"
			});
		}
	});
	bus.subscribe("recordings", ({ event, data }) => {
		if (
			event === "recording.playback.error" &&
			(data as { category?: unknown }).category === "encoder_capacity"
		) {
			metrics.incrementCounter("playback_pipeline_under_speed_total", {
				media: "recording"
			});
		}
	});

	// Instrument the pg pool to capture DB query durations.
	instrumentPool(pool, metrics);

	// Hook EPG refresh durations via the event bus.
	attachEpgMetrics(bus, metrics);

	// Hook error reporter into the error handler.
	const reportError = (err: unknown) => {
		if (err instanceof Error) {
			errorReporter.report(err);
		}
	};

	const app = express();

	app.disable("x-powered-by");

	// Request id must run before logging so logs include the id.
	app.use(requestId());
	app.use(httpLogger(logger));

	// The production Next.js rewrite preserves Content-Encoding, so compress
	// large JSON here before it crosses the internal proxy boundary.
	app.use(compression());

	// Metrics middleware collects HTTP request counts + latencies.
	app.use(createMetricsMiddleware(metrics));

	// In production we serve same-origin only (no CORS headers added). In
	// development/test we allow any origin to ease cross-origin tooling, but
	// we never combine that with `credentials: true` to avoid the dangerous
	// "reflect arbitrary Origin + cookies" pattern flagged by CORS scanners.
	app.use(
		cors(
			isProduction(environment)
				? { origin: false }
				: { origin: true, credentials: false }
		)
	);

	app.use(json({ limit: "1mb" }));
	app.use(urlencoded({ extended: false, limit: "1mb" }));

	app.use(
		"/api/v1",
		createApiV1Router({
			healthRepository,
			settingsService,
			systemStatusService,
			tunersService,
			channelsRepository,
			lineupSyncService,
			epgService,
			epgGridService,
			epgMatcherService,
			streamingService,
			recordingsService,
			commercialAnalysisService: commercialAnalysis,
			seriesRulesService,
			searchService,
			metrics,
			pool,
			logFilePath: resolveLogFilePath(env) ?? undefined,
			env,
			configure: options.configureV1Router
		})
	);

	app.use(notFoundHandler);
	app.use(errorHandler(reportError));

	return {
		app,
		scheduler,
		tunersService,
		lineupSyncService,
		epgService,
		epgMatcherService,
		recordingsService,
		seriesRulesService,
		metrics
	};
}

export const app = createApp();

/**
 * Build a transcoding resolver that re-reads the live settings document
 * on every attach so a user changing the default profile / hwaccel from
 * the settings UI takes effect on the next viewer (running ffmpeg
 * sessions are not torn down — they finish at their original config).
 *
 * The resolver also defends against the user pinning a hwaccel that
 * isn't installed: {@link resolveHwaccel} falls back to software so a
 * stale `availableHwaccels` list never breaks playback.
 */
function createSettingsBackedTranscodingResolver(
	settings: SettingsService
): TranscodingResolver {
	return {
		resolve: async (requestedProfile, channelDefault) => {
			const current = await settings.getAll();
			const profile =
				requestedProfile ??
				channelDefault ??
				current.transcoding.defaultProfile;
			const hwaccel = resolveHwaccel(
				current.transcoding.hwaccel,
				current.transcoding.availableHwaccels
			);
			return {
				profile,
				hwaccel,
				captionsEnabled: current.transcoding.captionsEnabled
			};
		}
	};
}

/** Re-read the disposable-buffer policy whenever a fresh session starts. */
function createSettingsBackedTimeShiftResolver(
	settings: SettingsService
): TimeShiftResolver {
	return {
		resolve: async () => {
			const { timeShift } = await settings.getAll();
			return {
				enabled: timeShift.enabled,
				bufferPath: timeShift.bufferPath,
				durationSeconds: timeShift.durationMinutes * 60,
				maxDiskBytes: Math.floor(timeShift.maxDiskGb * 1024 ** 3),
				idleGraceMs: timeShift.idleGraceSeconds * 1000
			};
		}
	};
}

/**
 * Probe ffmpeg for hwaccel backends and persist the result into settings.
 * Called once during boot (from `index.ts`) so the live `availableHwaccels`
 * field reflects the host the binary is actually running on. Failures are
 * swallowed: the settings document continues to advertise an empty list,
 * and the user can still pick `none` / a specific kind manually.
 */
export async function bootstrapHwaccelDetection(
	settings: SettingsService
): Promise<void> {
	try {
		const detected = await detectHwaccels();
		const current = await settings.getAll();
		const before = current.transcoding.availableHwaccels;
		const same =
			before.length === detected.length &&
			before.every((kind, idx) => kind === detected[idx]);
		if (same) {
			return;
		}
		await settings.patch({
			transcoding: {
				...current.transcoding,
				availableHwaccels: detected
			}
		});
	} catch {
		// Detection / persistence is best-effort; continue with defaults.
	}
}

// ---------------------------------------------------------------------------
// Instrumentation helpers (private to this module)
// ---------------------------------------------------------------------------

/**
 * Monkey-patch `pool.query` to record every DB query duration in the
 * metrics collector.  Only the promise-returning overloads are
 * instrumented; callback-style calls fall through unchanged.
 *
 * **Limitation**: queries executed via `pool.connect()` followed by
 * `client.query()` are not captured.  For complete coverage those call
 * sites should be wrapped individually or a per-client hook should be
 * added inside `pool.on('connect', ...)`.
 */
function instrumentPool(
	pool: import("pg").Pool,
	metrics: MetricsCollector
): void {
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;

	// @ts-expect-error — patching the pg Pool for instrumentation
	pool.query = (...args: unknown[]): unknown => {
		const start = process.hrtime.bigint();
		const result = original(...args);
		if (result instanceof Promise) {
			result.finally(() => {
				const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
				metrics.observeHistogram("db_query_duration_seconds", durationSec);
			});
		}
		return result;
	};
}

/**
 * Subscribe to the event bus to record EPG refresh durations.
 *
 * The EPG service emits an `epg.refresh.completed` event on the `epg`
 * topic; we listen for it and record the duration (if provided) in the
 * histogram.
 */
function attachEpgMetrics(
	bus: import("./events/event-bus").EventBus,
	metrics: MetricsCollector
): void {
	// Track pending refresh start times keyed by source id.
	const starts = new Map<string, bigint>();

	bus.subscribe("epg", (event) => {
		const payload = event.data as
			| { type?: string; sourceId?: string }
			| undefined;
		const type = payload?.type ?? event.event;
		const sourceId = payload?.sourceId;

		if (type === "epg.refresh.started" && sourceId) {
			starts.set(sourceId, process.hrtime.bigint());
		} else if (type === "epg.refresh.completed" && sourceId) {
			const startNs = starts.get(sourceId);
			if (startNs !== undefined) {
				const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
				metrics.observeHistogram("epg_refresh_duration_seconds", durationSec);
				starts.delete(sourceId);
			}
		} else if (type === "epg.refresh.failed" && sourceId) {
			// Clean up the start time even if the refresh failed.
			starts.delete(sourceId);
		}
	});
}
