import { Router } from "express";

import type { RecordingsService } from "../../recordings/recordings.service";
import type { StreamingService } from "../../streaming/streaming.service";
import type { MetricsCollector } from "../../observability/metrics";

export interface MetricsRouteDependencies {
	collector: MetricsCollector;
	streamingService?: StreamingService | undefined;
	recordingsService?: RecordingsService | undefined;
}

/**
 * `GET /metrics` — Prometheus text-format metrics endpoint.
 *
 * Before rendering, this route refreshes the gauge values that are
 * derived from live service state (active sessions / recordings /
 * ffmpeg processes) so the snapshot is always current.
 */
export function createMetricsRouter(deps: MetricsRouteDependencies): Router {
	const router = Router();

	router.get("/metrics", (_req, res) => {
		const { collector, streamingService, recordingsService } = deps;
		let ffmpegProcesses = 0;

		// Refresh live gauges.
		if (streamingService) {
			const activeSessions = streamingService.getActiveSessionCount();
			collector.setGauge("stream_sessions_active", activeSessions);
			// FFmpeg processes: each stream session runs one (or two with captions)
			// ffmpeg process.  We conservatively count one per session here; a
			// future enhancement could expose a more precise count from
			// StreamSession itself.
			ffmpegProcesses += activeSessions;
		}

		if (recordingsService) {
			const activeRecordings = recordingsService.getActiveRecordingCount();
			collector.setGauge("recordings_active", activeRecordings);
			ffmpegProcesses +=
				activeRecordings + recordingsService.getActivePlaybackSessionCount();
		}
		collector.setGauge("ffmpeg_processes_total", ffmpegProcesses);

		const body = collector.renderPrometheus();

		res
			.status(200)
			.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
			.end(body);
	});

	return router;
}
