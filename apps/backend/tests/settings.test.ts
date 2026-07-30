import assert from "node:assert/strict";
import test from "node:test";

import { settingsDefaults } from "@signalhaven/shared";
import request from "supertest";

import { createApp } from "../src/app";
import { EventBus } from "../src/events/event-bus";
import type { HealthRepository } from "../src/repositories/health.repository";
import type { SettingsRepository } from "../src/repositories/settings.repository";
import { SettingsService } from "../src/settings/settings.service";
import { SystemStatusService } from "../src/system/system-status.service";

function stubHealthRepository(): HealthRepository {
	return { isHealthy: async () => true } as unknown as HealthRepository;
}

class InMemorySettingsRepository {
	private rows = new Map<string, Record<string, unknown>>();

	async listAll(): Promise<Record<string, Record<string, unknown>>> {
		const out: Record<string, Record<string, unknown>> = {};
		for (const [k, v] of this.rows) {
			out[k] = v;
		}
		return out;
	}

	async upsertMany(updates: Record<string, Record<string, unknown>>) {
		for (const [k, v] of Object.entries(updates)) {
			this.rows.set(k, v);
		}
	}

	// Match the rest of the SettingsRepository surface used in code paths
	// exercised here.
	async upsert(key: string, value: Record<string, unknown>) {
		this.rows.set(key, value);
		return { key, value };
	}
	async getByKey(key: string) {
		const value = this.rows.get(key);
		return value ? { key, value } : null;
	}
}

interface Harness {
	bus: EventBus;
	settingsRepo: InMemorySettingsRepository;
	systemStatus: SystemStatusService;
	app: ReturnType<typeof createApp>;
}

function buildHarness(
	opts: {
		hasTuners?: boolean;
		hasEpg?: boolean;
	} = {}
): Harness {
	const bus = new EventBus();
	const settingsRepo = new InMemorySettingsRepository();
	const settingsService = new SettingsService({
		repository: settingsRepo as unknown as SettingsRepository,
		bus
	});
	// We don't want to depend on a real DB in this test, so stub the system
	// status by extending the public surface used by the route layer.
	const systemStatus = {
		getStatus: async () => {
			const current = await settingsService.getAll();
			const hasTuners = opts.hasTuners ?? false;
			const hasEpg = opts.hasEpg ?? false;
			const hasStorage =
				typeof current.storage.path === "string" &&
				current.storage.path.length > 0;
			return {
				hasTuners,
				hasEpg,
				hasStorage,
				firstRun: !hasTuners && !hasEpg && !hasStorage
			};
		}
	} as unknown as SystemStatusService;

	const app = createApp({
		env: { ...process.env, NODE_ENV: "test" },
		healthRepository: stubHealthRepository(),
		settingsService,
		systemStatusService: systemStatus,
		bus
	});

	return { bus, settingsRepo, systemStatus, app };
}

test("GET /api/v1/settings returns defaults on a fresh install", async () => {
	const { app } = buildHarness();
	const response = await request(app).get("/api/v1/settings");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, settingsDefaults);
});

test("PATCH /api/v1/settings round-trip persists and returns merged document", async () => {
	const { app } = buildHarness();

	const patchResponse = await request(app)
		.patch("/api/v1/settings")
		.send({ ui: { theme: "dark", epgHoursVisible: 6, use24HourClock: true } });

	assert.equal(patchResponse.status, 200);
	assert.equal(patchResponse.body.ui.theme, "dark");
	assert.equal(patchResponse.body.ui.epgHoursVisible, 6);
	// Other top-level keys preserved at their defaults.
	assert.deepEqual(patchResponse.body.storage, settingsDefaults.storage);
	assert.deepEqual(
		patchResponse.body.transcoding,
		settingsDefaults.transcoding
	);

	const getResponse = await request(app).get("/api/v1/settings");
	assert.deepEqual(getResponse.body, patchResponse.body);
});

test("GET removes the legacy persisted Comskip executable path", async () => {
	const { app, settingsRepo } = buildHarness();
	await settingsRepo.upsert("recordings", {
		paddingBeforeSec: 0,
		paddingAfterSec: 0,
		commercialDetection: {
			enabled: true,
			detectorPath: "/legacy/comskip",
			detectorVersion: "legacy-v1"
		}
	});

	const response = await request(app).get("/api/v1/settings");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body.recordings.commercialDetection, {
		enabled: true,
		detectorVersion: "legacy-v1"
	});
});

test("PATCH /api/v1/settings rejects invalid values", async () => {
	const { app } = buildHarness();

	const response = await request(app)
		.patch("/api/v1/settings")
		.send({ ui: { theme: "neon", epgHoursVisible: 6, use24HourClock: false } });

	assert.equal(response.status, 400);
	assert.equal(response.body.error.code, "bad_request");
	assert.ok(response.body.error.details);
});

test("PATCH /api/v1/settings validates and persists the time-shift policy", async () => {
	const { app } = buildHarness();
	const timeShift = {
		enabled: true,
		bufferPath: "/var/lib/signalhaven/timeshift",
		durationMinutes: 30,
		maxDiskGb: 5,
		idleGraceSeconds: 45
	};

	const saved = await request(app)
		.patch("/api/v1/settings")
		.send({ timeShift });

	assert.equal(saved.status, 200);
	assert.deepEqual(saved.body.timeShift, timeShift);

	const invalid = await request(app)
		.patch("/api/v1/settings")
		.send({ timeShift: { ...timeShift, durationMinutes: 0 } });
	assert.equal(invalid.status, 400);
});

test("PATCH preserves keys that were not part of the patch body", async () => {
	const { app } = buildHarness();

	await request(app)
		.patch("/api/v1/settings")
		.send({ storage: { path: "/srv/recordings" } })
		.expect(200);

	await request(app)
		.patch("/api/v1/settings")
		.send({ ui: { theme: "light", epgHoursVisible: 8, use24HourClock: false } })
		.expect(200);

	const response = await request(app).get("/api/v1/settings");
	assert.equal(response.body.storage.path, "/srv/recordings");
	assert.equal(response.body.ui.theme, "light");
	assert.equal(response.body.ui.epgHoursVisible, 8);
});

test("PATCH publishes a settings.updated event on the WS bus", async () => {
	const { app, bus } = buildHarness();
	const received: Array<{ event: string; data: unknown }> = [];
	bus.subscribe("settings", (e) => {
		received.push({ event: e.event, data: e.data });
	});

	await request(app)
		.patch("/api/v1/settings")
		.send({ storage: { path: "/srv/dvr" } })
		.expect(200);

	assert.equal(received.length, 1);
	assert.equal(received[0]?.event, "updated");
	const data = received[0]?.data as {
		changedKeys: string[];
		settings: { storage: { path: string | null } };
	};
	assert.deepEqual(data.changedKeys, ["storage"]);
	assert.equal(data.settings.storage.path, "/srv/dvr");
});

test("GET /api/v1/system/status reports firstRun on an empty install", async () => {
	const { app } = buildHarness();
	const response = await request(app).get("/api/v1/system/status");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, {
		firstRun: true,
		hasTuners: false,
		hasEpg: false,
		hasStorage: false
	});
});

test("system/status flips firstRun=false once any signal becomes true", async () => {
	const { app } = buildHarness({ hasTuners: true });
	const response = await request(app).get("/api/v1/system/status");

	assert.equal(response.status, 200);
	assert.equal(response.body.firstRun, false);
	assert.equal(response.body.hasTuners, true);
	assert.equal(response.body.hasEpg, false);
	assert.equal(response.body.hasStorage, false);
});

test("system/status reflects storage path becoming configured", async () => {
	const { app } = buildHarness();

	await request(app)
		.patch("/api/v1/settings")
		.send({ storage: { path: "/srv/dvr" } })
		.expect(200);

	const response = await request(app).get("/api/v1/system/status");
	assert.equal(response.body.hasStorage, true);
	assert.equal(response.body.firstRun, false);
});

test("OpenAPI spec exposes the settings and system status endpoints", async () => {
	const { app } = buildHarness();
	const response = await request(app).get("/api/v1/openapi.json");

	assert.equal(response.status, 200);
	assert.ok(response.body.paths["/api/v1/settings"]);
	assert.ok(response.body.paths["/api/v1/settings"].get);
	assert.ok(response.body.paths["/api/v1/settings"].patch);
	assert.ok(response.body.paths["/api/v1/system/status"]);
});
