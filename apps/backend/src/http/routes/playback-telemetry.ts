import { playbackTelemetryEventSchema } from "@signalhaven/shared";
import { Router, type RequestHandler } from "express";

import type { MetricsCollector } from "../../observability/metrics";
import { validate } from "../middleware/validate";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_EVENTS = 60;

interface RateLimitEntry {
	count: number;
	windowStartedAt: number;
}

/** Bound event ingestion per source address without retaining user identity. */
function createTelemetryRateLimiter(): RequestHandler {
	const entries = new Map<string, RateLimitEntry>();

	return (req, res, next) => {
		const now = Date.now();
		// A shared fallback keeps malformed proxy requests bounded without creating labels.
		const key = req.ip ?? "unknown";
		const current = entries.get(key);
		if (!current || now - current.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
			if (!current && entries.size >= 1_024) {
				// Bound anonymous source tracking even behind a noisy public reverse proxy.
				const oldestKey = entries.keys().next().value as string | undefined;
				if (oldestKey) entries.delete(oldestKey);
			}
			entries.set(key, { count: 1, windowStartedAt: now });
			next();
			return;
		}

		if (current.count >= RATE_LIMIT_MAX_EVENTS) {
			res.status(429).json({ error: "Playback telemetry rate limit exceeded" });
			return;
		}

		current.count += 1;
		next();
	};
}

/** Record low-cardinality playback QoE without persisting viewer data. */
export function createPlaybackTelemetryRouter(
	metrics: MetricsCollector
): Router {
	const router = Router();

	router.post(
		"/playback/telemetry",
		createTelemetryRateLimiter(),
		validate({ body: playbackTelemetryEventSchema }),
		(req, res) => {
			const event = playbackTelemetryEventSchema.parse(req.body);
			const labels = {
				cause: event.cause,
				client: event.client,
				media: event.media,
				profile: event.profile
			};

			if (
				event.event === "startup_completed" &&
				event.durationSeconds !== undefined
			) {
				metrics.observeHistogram(
					"playback_startup_duration_seconds",
					event.durationSeconds,
					labels
				);
			}
			if (event.event === "stall_ended") {
				metrics.incrementCounter("playback_rebuffer_events_total", labels);
				if (event.durationSeconds !== undefined) {
					metrics.observeHistogram(
						"playback_rebuffer_duration_seconds",
						event.durationSeconds,
						labels
					);
				}
			}
			if (event.event === "rendition_changed") {
				metrics.incrementCounter("playback_rendition_changes_total", labels);
			}
			if (event.event === "fatal_error") {
				metrics.incrementCounter("playback_fatal_errors_total", labels);
			}
			if (event.event === "session_ended" && event.watchedDurationSeconds) {
				metrics.observeHistogram(
					"playback_rebuffer_ratio",
					(event.stallDurationSeconds ?? 0) / event.watchedDurationSeconds,
					labels
				);
			}
			if (event.media === "live" && event.latencySeconds !== undefined) {
				metrics.observeHistogram(
					"playback_live_latency_seconds",
					event.latencySeconds,
					labels
				);
			}

			res.status(204).end();
		}
	);

	return router;
}
