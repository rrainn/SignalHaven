import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";
import { z } from "zod";

import { createApp } from "../src/app";
import { badRequest } from "../src/http/middleware/errors";
import { validate } from "../src/http/middleware/validate";
import type { RecordingsService } from "../src/recordings/recordings.service";
import type { HealthRepository } from "../src/repositories/health.repository";
import type { SeriesRulesService } from "../src/series/series-rules.service";

function stubHealthRepository(isHealthy: boolean): HealthRepository {
	return {
		isHealthy: async () => isHealthy
	} as unknown as HealthRepository;
}

function buildApp(isHealthy = true) {
	return createApp({
		env: { ...process.env, NODE_ENV: "test" },
		healthRepository: stubHealthRepository(isHealthy),
		configureV1Router: (router) => {
			router.post(
				"/__test/validate",
				validate({ body: z.object({ name: z.string().min(1) }) }),
				(req, res) => {
					res.json({ ok: true, name: (req.body as { name: string }).name });
				}
			);

			router.get("/__test/boom", (_req, _res, next) => {
				next(new Error("kaboom"));
			});

			router.get("/__test/teapot", (_req, _res, next) => {
				next(badRequest("nope", { reason: "demo" }));
			});
		}
	});
}

test("GET /api/v1/health returns version, uptime and db ok", async () => {
	const app = buildApp(true);
	const response = await request(app).get("/api/v1/health");

	assert.equal(response.status, 200);
	assert.equal(response.body.status, "ok");
	assert.equal(typeof response.body.version, "string");
	assert.ok(response.body.version.length > 0);
	assert.equal(typeof response.body.uptime, "number");
	assert.ok(response.body.uptime >= 0);
	assert.deepEqual(response.body.db, { ok: true });
	assert.match(response.headers["x-request-id"] ?? "", /[0-9a-f-]{8,}/);
});

test("GET /api/v1/health reports 503 when db is unhealthy", async () => {
	const app = buildApp(false);
	const response = await request(app).get("/api/v1/health");

	assert.equal(response.status, 503);
	assert.equal(response.body.status, "error");
	assert.deepEqual(response.body.db, { ok: false });
});

test("GET /api/v1/system/info returns release metadata and server uptime", async () => {
	const app = createApp({
		env: {
			...process.env,
			NODE_ENV: "test",
			SIGNALHAVEN_VERSION: "2.3.4",
			SIGNALHAVEN_GIT_SHA: "0123456789abcdef0123456789abcdef01234567"
		},
		healthRepository: stubHealthRepository(true)
	});
	const response = await request(app).get("/api/v1/system/info");

	assert.equal(response.status, 200);
	assert.equal(response.headers["cache-control"], "no-store");
	assert.equal(response.body.version, "2.3.4");
	assert.equal(
		response.body.gitCommit,
		"0123456789abcdef0123456789abcdef01234567"
	);
	assert.equal(typeof response.body.uptime, "number");
	assert.ok(response.body.uptime >= 0);
});

test("Unknown route returns standardized 404 error envelope", async () => {
	const app = buildApp();
	const response = await request(app).get("/does-not-exist");

	assert.equal(response.status, 404);
	assert.equal(response.body.error.code, "not_found");
	assert.equal(typeof response.body.error.message, "string");
	assert.equal(typeof response.body.error.requestId, "string");
});

test("Validation failure returns 400 with details and request id", async () => {
	const app = buildApp();
	const response = await request(app)
		.post("/api/v1/__test/validate")
		.send({ name: "" });

	assert.equal(response.status, 400);
	assert.equal(response.body.error.code, "bad_request");
	assert.ok(response.body.error.details);
	assert.ok(response.body.error.requestId);
	// request id header should be present and match envelope.
	assert.equal(response.headers["x-request-id"], response.body.error.requestId);
});

test("Successful POST returns parsed body", async () => {
	const app = buildApp();
	const response = await request(app)
		.post("/api/v1/__test/validate")
		.send({ name: "hello" });

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { ok: true, name: "hello" });
});

test("Unknown error becomes 500 with correlation id", async () => {
	const app = buildApp();
	const response = await request(app).get("/api/v1/__test/boom");

	assert.equal(response.status, 500);
	assert.equal(response.body.error.code, "internal_server_error");
	assert.equal(typeof response.body.error.requestId, "string");
	assert.ok(response.body.error.requestId.length > 0);
	assert.equal(response.headers["x-request-id"], response.body.error.requestId);
});

test("HttpError details propagate to response", async () => {
	const app = buildApp();
	const response = await request(app).get("/api/v1/__test/teapot");

	assert.equal(response.status, 400);
	assert.equal(response.body.error.code, "bad_request");
	assert.deepEqual(response.body.error.details, { reason: "demo" });
});

test("Incoming x-request-id header is propagated", async () => {
	const app = buildApp();
	const response = await request(app)
		.get("/api/v1/health")
		.set("x-request-id", "test-correlation-id");

	assert.equal(response.status, 200);
	assert.equal(response.headers["x-request-id"], "test-correlation-id");
});

test("GET /api/v1/openapi.json returns an OpenAPI 3.1 document", async () => {
	const app = buildApp();
	const response = await request(app).get("/api/v1/openapi.json");

	assert.equal(response.status, 200);
	assert.equal(response.body.openapi, "3.1.0");
	assert.equal(response.body.info.title, "SignalHaven API");
	assert.ok(response.body.paths["/api/v1/health"]);
});

test("GET /api/v1/recordings/conflicts reaches the static conflict route", async () => {
	// Stub only the lifecycle and route methods needed to expose both routers.
	const recordingsService = {
		attachLibraryMaintenance: () => undefined
	} as unknown as RecordingsService;
	const seriesRulesService = {
		attachBus: () => undefined,
		getConflicts: () => []
	} as unknown as SeriesRulesService;
	const app = createApp({
		env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent" },
		healthRepository: stubHealthRepository(true),
		recordingsService,
		seriesRulesService
	});

	const response = await request(app).get("/api/v1/recordings/conflicts");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { items: [] });
});

test("Swagger UI is served only outside production", async () => {
	const dev = createApp({
		env: { ...process.env, NODE_ENV: "development", LOG_LEVEL: "silent" },
		healthRepository: stubHealthRepository(true)
	});
	const devResponse = await request(dev).get("/api/v1/docs/");
	assert.notEqual(devResponse.status, 404);

	const prod = createApp({
		env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "silent" },
		healthRepository: stubHealthRepository(true)
	});
	const prodResponse = await request(prod).get("/api/v1/docs/");
	assert.equal(prodResponse.status, 404);
	assert.equal(prodResponse.body.error.code, "not_found");
});
