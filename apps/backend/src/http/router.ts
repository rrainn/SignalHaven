import { Router } from "express";
import { serve, setup } from "swagger-ui-express";
import type { Pool } from "pg";

import type { EpgService } from "../epg/epg.service";
import type { EpgGridService } from "../epg/epg-grid.service";
import type { EpgMatcherService } from "../epg/epg-matcher.service";
import type { RecordingsService } from "../recordings/recordings.service";
import type { ChannelsRepository } from "../repositories/channels.repository";
import type { HealthRepository } from "../repositories/health.repository";
import type { SearchService } from "../search/search.service";
import type { SeriesRulesService } from "../series/series-rules.service";
import type { SettingsService } from "../settings/settings.service";
import type { StreamingService } from "../streaming/streaming.service";
import type { SystemStatusService } from "../system/system-status.service";
import type { TunersService } from "../tuners/tuners.service";
import type { TunerLineupSyncService } from "../tuners/tuner-lineup-sync.service";
import type { MetricsCollector } from "../observability/metrics";

import { isDevelopment, resolveEnvironment } from "./env";
import { generateOpenApiDocument } from "./openapi";
import { createChannelsRouter } from "./routes/channels";
import { createAdvancedRouter } from "./routes/advanced";
import { createDebugRouter } from "./routes/debug";
import { createEpgRouter } from "./routes/epg";
import { createEpgGridRouter } from "./routes/epg-grid";
import { createHealthRouter } from "./routes/health";
import { createMetricsRouter } from "./routes/metrics";
import { createRecordingsRouter } from "./routes/recordings";
import { createSearchRouter } from "./routes/search";
import { createSeriesRulesRouter } from "./routes/series-rules";
import { createSettingsRouter } from "./routes/settings";
import { createStreamRouter } from "./routes/stream";
import { createSystemRouter } from "./routes/system";
import { createTunersRouter } from "./routes/tuners";

export interface ApiV1Dependencies {
	healthRepository: HealthRepository;
	settingsService: SettingsService;
	systemStatusService: SystemStatusService;
	tunersService: TunersService;
	lineupSyncService: TunerLineupSyncService;
	/** Repository used by the tuner-sync endpoint to upsert channel rows. */
	channelsRepository: ChannelsRepository;
	epgService: EpgService;
	epgGridService: EpgGridService;
	epgMatcherService: EpgMatcherService;
	streamingService?: StreamingService | undefined;
	recordingsService?: RecordingsService | undefined;
	seriesRulesService?: SeriesRulesService | undefined;
	searchService?: SearchService | undefined;
	metrics?: MetricsCollector | undefined;
	/** pg Pool forwarded to the debug bundle endpoint for DB stats. */
	pool?: Pool | undefined;
	/** Path to the current rotating log file (from `LOG_FILE` env var). */
	logFilePath?: string | undefined;
	env?: NodeJS.ProcessEnv;
	configure?: ((router: Router) => void) | undefined;
}

export function createApiV1Router(deps: ApiV1Dependencies): Router {
	const router = Router();
	const environment = resolveEnvironment(deps.env ?? process.env);

	router.use(createHealthRouter(deps.healthRepository));
	router.use(createSettingsRouter(deps.settingsService));
	router.use(createSystemRouter(deps.systemStatusService, deps.env));
	router.use(
		createTunersRouter(
			deps.tunersService,
			deps.epgService,
			deps.lineupSyncService
		)
	);
	router.use(createEpgRouter(deps.epgService));
	router.use(createEpgGridRouter(deps.epgGridService));
	router.use(
		createChannelsRouter(
			deps.epgMatcherService,
			deps.tunersService,
			deps.channelsRepository
		)
	);
	if (deps.streamingService) {
		router.use(createStreamRouter(deps.streamingService));
	}
	router.use(
		createAdvancedRouter({
			streaming: deps.streamingService,
			recordings: deps.recordingsService,
			env: deps.env
		})
	);
	// Register the static `/recordings/conflicts` path before `/recordings/:id`.
	if (deps.seriesRulesService) {
		router.use(createSeriesRulesRouter(deps.seriesRulesService));
	}
	if (deps.recordingsService) {
		router.use(createRecordingsRouter(deps.recordingsService));
	}
	if (deps.searchService) {
		router.use(createSearchRouter(deps.searchService));
	}

	// Observability routes
	if (deps.metrics) {
		router.use(
			createMetricsRouter({
				collector: deps.metrics,
				streamingService: deps.streamingService,
				recordingsService: deps.recordingsService
			})
		);
	}

	router.use(
		createDebugRouter({
			settingsService: deps.settingsService,
			pool: deps.pool,
			metrics: deps.metrics,
			logFilePath: deps.logFilePath
		})
	);

	router.get("/openapi.json", (_req, res) => {
		res.json(generateOpenApiDocument());
	});

	if (isDevelopment(environment)) {
		const spec = generateOpenApiDocument();
		router.use("/docs", serve, setup(spec));
	}

	if (deps.configure) {
		deps.configure(router);
	}

	return router;
}
