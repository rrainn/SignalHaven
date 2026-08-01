import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { test } from "node:test";

import { errorHandler } from "../src/http/middleware/errors";
import { createAdvancedRouter } from "../src/http/routes/advanced";
import type { RecordingsService } from "../src/recordings/recordings.service";

test("advanced external IP route is disabled unless explicitly enabled", async () => {
	const app = express();
	let fetchCalled = false;
	app.use(
		"/api/v1",
		createAdvancedRouter({
			env: {},
			fetch: async () => {
				fetchCalled = true;
				return new Response("203.0.113.42", { status: 200 });
			}
		})
	);
	app.use(errorHandler());

	const response = await request(app).get("/api/v1/advanced/external-ip");

	assert.equal(response.status, 403);
	assert.equal(response.body.error.code, "external_ip_lookup_disabled");
	assert.equal(fetchCalled, false);
});

test("advanced external IP route returns the server address from the configured lookup", async () => {
	const app = express();
	const calls: string[] = [];
	app.use(
		"/api/v1",
		createAdvancedRouter({
			env: { SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED: "true" },
			fetch: async (input) => {
				calls.push(String(input));
				return new Response("203.0.113.42\n", { status: 200 });
			}
		})
	);

	const response = await request(app).get("/api/v1/advanced/external-ip");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { ip: "203.0.113.42" });
	assert.deepEqual(calls, ["https://ip.rrainn.space"]);
	assert.equal(response.headers["cache-control"], "no-store");
});

test("advanced external IP route accepts the lookup's JSON response", async () => {
	const app = express();
	app.use(
		"/api/v1",
		createAdvancedRouter({
			env: { SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED: "1" },
			fetch: async () =>
				Response.json({
					ip: "2001:db8::42",
					version: 6,
					country: "US"
				})
		})
	);

	const response = await request(app).get("/api/v1/advanced/external-ip");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { ip: "2001:db8::42" });
});

test("advanced Comskip route returns active commercial-analysis work", async () => {
	const app = express();
	app.use(
		"/api/v1",
		createAdvancedRouter({
			commercialAnalysis: {
				getActiveWork: () => [
					{
						recordingId: "recording-1",
						label: "Evening News",
						state: "running",
						startedAt: "2026-07-20T12:00:00.000Z"
					}
				]
			}
		})
	);

	const response = await request(app).get("/api/v1/advanced/comskip");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, {
		items: [
			{
				id: "commercial:recording-1",
				recordingId: "recording-1",
				label: "Evening News",
				state: "running",
				startedAt: "2026-07-20T12:00:00.000Z"
			}
		]
	});
	assert.equal(response.headers["cache-control"], "no-store");
});

test("advanced FFmpeg controls address exact recording playback sessions", async () => {
	const stopped: string[] = [];
	const recordings = {
		getActiveFfmpegWork: async () => [
			{
				recordingId: "recording-1",
				playbackSessionId: "playback-session-1",
				title: "Evening News",
				kind: "recording-playback" as const,
				state: "ready",
				startedAt: "2026-07-20T12:00:00.000Z",
				profile: "original-quality",
				hwaccel: null,
				clientCount: 2
			}
		],
		stopPlayback: (id: string) => {
			stopped.push(id);
			return true;
		}
	} as unknown as RecordingsService;
	const app = express();
	app.use("/api/v1", createAdvancedRouter({ recordings }));
	app.use(errorHandler());

	const list = await request(app).get("/api/v1/advanced/ffmpeg");
	assert.equal(list.status, 200);
	assert.deepEqual(list.body.items, [
		{
			id: "playback:playback-session-1",
			kind: "recording-playback",
			label: "Evening News",
			recordingId: "recording-1",
			state: "ready",
			startedAt: "2026-07-20T12:00:00.000Z",
			profile: "original-quality",
			hwaccel: null,
			clientCount: 2
		}
	]);

	const removed = await request(app).delete(
		"/api/v1/advanced/ffmpeg/playback:playback-session-1"
	);
	assert.equal(removed.status, 204);
	assert.deepEqual(stopped, ["playback-session-1"]);
});
