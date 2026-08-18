import { Router } from "express";
import { serve, setup } from "swagger-ui-express";
import type { Pool } from "pg";

import type { AuthService } from "../auth/auth.service";
import type { AuthenticationMiddleware } from "../auth/middleware";
import type { MediaTicketService } from "../auth/media-ticket.service";

import type { EpgService } from "../epg/epg.service";
import type { CommercialAnalysisService } from "../commercials/commercial-analysis.service";
import type { EpgGridService } from "../epg/epg-grid.service";
import type { EpgMatcherService } from "../epg/epg-matcher.service";
import type { RecordingsService } from "../recordings/recordings.service";
import type { ChannelsRepository } from "../repositories/channels.repository";
import type { HealthRepository } from "../repositories/health.repository";
import type { SearchService } from "../search/search.service";
import type { SeriesRulesService } from "../series/series-rules.service";
import type { SettingsService } from "../settings/settings.service";
import type { UserPreferencesService } from "../settings/user-preferences.service";
import {
	ChannelNotStreamableError,
	type StreamingService
} from "../streaming/streaming.service";
import type { SystemStatusService } from "../system/system-status.service";
import type { TunersService } from "../tuners/tuners.service";
import type { TunerLineupSyncService } from "../tuners/tuner-lineup-sync.service";
import type { MetricsCollector } from "../observability/metrics";

import { isDevelopment, resolveEnvironment } from "./env";
import { generateOpenApiDocument } from "./openapi";
import { createChannelsRouter } from "./routes/channels";
import { createAdvancedRouter } from "./routes/advanced";
import { createAuthRouter } from "./routes/auth";
import { createDebugRouter } from "./routes/debug";
import { createEpgRouter } from "./routes/epg";
import { createEpgGridRouter } from "./routes/epg-grid";
import { createHealthRouter } from "./routes/health";
import { createMetricsRouter } from "./routes/metrics";
import { createMediaTicketsRouter } from "./routes/media-tickets";
import { createPlaybackTelemetryRouter } from "./routes/playback-telemetry";
import { createPreferencesRouter } from "./routes/preferences";
import { createRecordingsRouter } from "./routes/recordings";
import { createSearchRouter } from "./routes/search";
import { createSeriesRulesRouter } from "./routes/series-rules";
import { createSettingsRouter } from "./routes/settings";
import { createStreamRouter } from "./routes/stream";
import { createSystemRouter } from "./routes/system";
import { createTunersRouter } from "./routes/tuners";
import { createUsersRouter } from "./routes/users";

export interface ApiV1Dependencies {
	healthRepository: HealthRepository;
	authService: AuthService;
	authentication: AuthenticationMiddleware;
	mediaTicketService: MediaTicketService;
	userPreferencesService: UserPreferencesService;
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
	commercialAnalysisService?: CommercialAnalysisService | undefined;
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
	router.use(
		createAuthRouter({
			auth: deps.authService,
			authentication: deps.authentication,
			systemStatus: deps.systemStatusService,
			...(deps.env ? { env: deps.env } : {})
		})
	);

	// API discovery remains public so clients can learn how to authenticate.
	router.get("/openapi.json", (_req, res) => {
		res.json(generateOpenApiDocument());
	});

	if (isDevelopment(environment)) {
		const spec = generateOpenApiDocument();
		router.use("/docs", serve, setup(spec));
	}

	// Authentication is resolved once, then every remaining API is protected.
	router.use(
		deps.authentication.optional,
		deps.authentication.required,
		deps.authentication.cookieOrigin
	);
	// Account switches must never inherit protected responses from browser caches.
	router.use((_req, res, next) => {
		res.setHeader("Cache-Control", "private, no-store");
		next();
	});
	router.use(createPreferencesRouter(deps.userPreferencesService));
	router.use(
		createMediaTicketsRouter({
			assertLiveStreamable: deps.streamingService
				? (channelId: string) =>
						deps.streamingService!.assertStreamable(channelId)
				: async (channelId: string) => {
						// Reduced test/application compositions fail closed instead of issuing
						// an unusable capability without a channel-visibility boundary.
						throw new ChannelNotStreamableError(channelId);
					},
			tickets: deps.mediaTicketService,
			...(deps.recordingsService ? { recordings: deps.recordingsService } : {})
		})
	);
	router.use(createEpgGridRouter(deps.epgGridService));
	router.use(
		createChannelsRouter(
			deps.epgMatcherService,
			deps.tunersService,
			deps.channelsRepository,
			deps.authentication.admin,
			() => deps.epgGridService.invalidateSnapshot(),
			undefined
		)
	);
	if (deps.streamingService) {
		router.use(
			createStreamRouter(deps.streamingService, deps.authentication.admin)
		);
	}
	// Register the static `/recordings/conflicts` path before `/recordings/:id`.
	if (deps.seriesRulesService) {
		router.use(createSeriesRulesRouter(deps.seriesRulesService));
	}
	if (deps.recordingsService) {
		router.use(
			createRecordingsRouter(deps.recordingsService, deps.authentication.admin)
		);
	}
	if (deps.searchService) {
		router.use(createSearchRouter(deps.searchService));
	}

	// Observability routes
	if (deps.metrics) {
		router.use(createPlaybackTelemetryRouter(deps.metrics));
	}

	// Machine topology and global configuration are administrator-only.
	router.use(deps.authentication.admin);
	router.use(createUsersRouter(deps.authService));
	router.use(createSettingsRouter(deps.settingsService));
	router.use(createSystemRouter(deps.systemStatusService, deps.env));
	router.use(
		createTunersRouter(
			deps.tunersService,
			deps.epgService,
			deps.lineupSyncService,
			() => deps.epgGridService.invalidateSnapshot()
		)
	);
	router.use(createEpgRouter(deps.epgService));
	router.use(
		createAdvancedRouter({
			streaming: deps.streamingService,
			recordings: deps.recordingsService,
			commercialAnalysis: deps.commercialAnalysisService,
			env: deps.env
		})
	);

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

	if (deps.configure) {
		deps.configure(router);
	}

	return router;
}
