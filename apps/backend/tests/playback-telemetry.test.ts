import assert from "node:assert/strict";
import test from "node:test";

import { playbackTelemetryEventSchema } from "@signalhaven/shared";
import request from "supertest";

import { createApp } from "../src/app";
import { createTestAuthentication } from "../src/auth/middleware";
import type { HealthRepository } from "../src/repositories/health.repository";

/** Build a network-independent app for playback telemetry behavior. */
function buildApp() {
	return createApp({
		authentication: createTestAuthentication(),
		env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent" },
		healthRepository: {
			isHealthy: async () => true
		} as unknown as HealthRepository
	});
}

test("playback telemetry accepts bounded QoE events", async () => {
	const app = buildApp();
	const response = await request(app).post("/api/v1/playback/telemetry").send({
		event: "stall_ended",
		media: "live",
		client: "web",
		profile: "480p",
		cause: "network",
		durationSeconds: 1.25,
		latencySeconds: 8
	});

	assert.equal(response.status, 204);
	const metrics = await request(app).get("/api/v1/metrics");
	assert.match(
		metrics.text,
		/playback_rebuffer_events_total\{cause="network",client="web",media="live",profile="480p"\} 1/
	);
	assert.match(metrics.text, /playback_rebuffer_duration_seconds_count/);
	assert.match(metrics.text, /playback_live_latency_seconds_count/);
});

test("playback telemetry rejects unbounded and unknown values", async () => {
	const app = buildApp();
	const response = await request(app).post("/api/v1/playback/telemetry").send({
		event: "stall_ended",
		media: "live",
		client: "web",
		profile: "8k-secret-channel",
		cause: "network",
		durationSeconds: 100_000
	});

	assert.equal(response.status, 400);
});

test("shared telemetry schema excludes identifiers and URLs", () => {
	const parsed = playbackTelemetryEventSchema.safeParse({
		event: "session_ended",
		media: "recording",
		client: "apple",
		profile: "auto",
		cause: "unknown",
		watchedDurationSeconds: 120,
		stallDurationSeconds: 0,
		channelId: "private-channel",
		url: "https://example.invalid/secret"
	});

	assert.equal(parsed.success, true);
	if (parsed.success) {
		assert.equal("channelId" in parsed.data, false);
		assert.equal("url" in parsed.data, false);
	}
});
