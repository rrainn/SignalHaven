import type { Pool } from "pg";
import { Router } from "express";

import type { SettingsService } from "../../settings/settings.service";
import type { MetricsCollector } from "../../observability/metrics";
import { generateDiagnosticsBundle } from "../../observability/diagnostics";
import { notFound } from "../middleware/errors";

export interface DebugRouteDependencies {
	settingsService: SettingsService;
	pool?: Pool | undefined;
	metrics?: MetricsCollector | undefined;
	/** Path to the current rotating log file (from `LOG_FILE` env var). */
	logFilePath?: string | undefined;
}

/**
 * `GET /debug/bundle` — download a diagnostics ZIP archive.
 *
 * This endpoint is gated behind the `settings.observability.debugBundleEnabled`
 * flag and returns 404 when that flag is `false` (the default).  Operators
 * enable it temporarily via the settings API when diagnosing issues.
 */
export function createDebugRouter(deps: DebugRouteDependencies): Router {
	const router = Router();

	router.get("/debug/bundle", async (_req, res, next) => {
		// Capture the timestamp immediately so the filename is consistent with
		// when the request arrived, not when the bundle finishes generating.
		const requestedAt = new Date().toISOString().replace(/[:.]/g, "-");

		try {
			const settings = await deps.settingsService.getAll();
			if (!settings.observability.debugBundleEnabled) {
				return next(notFound("Debug bundle endpoint is disabled"));
			}

			const bundle = await generateDiagnosticsBundle({
				pool: deps.pool,
				metrics: deps.metrics,
				logFilePath: deps.logFilePath
			});

			res
				.status(200)
				.set("Content-Type", "application/zip")
				.set(
					"Content-Disposition",
					`attachment; filename="signalhaven-diagnostics-${requestedAt}.zip"`
				)
				.end(bundle);
		} catch (error) {
			next(error);
		}
	});

	return router;
}
