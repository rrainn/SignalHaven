import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { TunerLease } from "@signalhaven/shared";
import request from "supertest";

import { createApp } from "../src/app";
import { createTestAuthentication } from "../src/auth/middleware";
import type { EpgService } from "../src/epg/epg.service";
import { EventBus } from "../src/events/event-bus";
import type { HealthRepository } from "../src/repositories/health.repository";
import type {
	CreateTunerInput,
	TunersRepository,
	UpdateTunerInput
} from "../src/repositories/tuners.repository";
import {
	TunerRegistry,
	type TunerProviderFactory
} from "../src/tuners/provider";
import {
	TunerAllocator,
	TunerUnavailableError
} from "../src/tuners/tuner-allocator";
import { TunersService } from "../src/tuners/tuners.service";

function stubHealthRepository(): HealthRepository {
	return { isHealthy: async () => true } as unknown as HealthRepository;
}

interface TunerRow {
	id: string;
	kind: string;
	name: string;
	config: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

class InMemoryTunersRepository {
	private rows = new Map<string, TunerRow>();

	async create(input: CreateTunerInput): Promise<TunerRow> {
		const now = new Date();
		const row: TunerRow = {
			id: randomUUID(),
			kind: input.kind,
			name: input.name,
			config: input.config,
			createdAt: now,
			updatedAt: now
		};
		this.rows.set(row.id, row);
		return row;
	}

	async getById(id: string): Promise<TunerRow | null> {
		return this.rows.get(id) ?? null;
	}

	async list(): Promise<TunerRow[]> {
		return [...this.rows.values()].sort(
			(a, b) => a.createdAt.getTime() - b.createdAt.getTime()
		);
	}

	async update(id: string, input: UpdateTunerInput): Promise<TunerRow | null> {
		const existing = this.rows.get(id);
		if (!existing) return null;
		const updated: TunerRow = {
			...existing,
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.kind !== undefined ? { kind: input.kind } : {}),
			...(input.config !== undefined ? { config: input.config } : {}),
			updatedAt: new Date()
		};
		this.rows.set(id, updated);
		return updated;
	}

	async delete(id: string): Promise<boolean> {
		return this.rows.delete(id);
	}
}

function fixedClock(start = new Date("2025-01-01T00:00:00.000Z")): () => Date {
	let n = 0;
	return () => new Date(start.getTime() + n++);
}

test("TunerAllocator grants leases up to capacity", async () => {
	const allocator = new TunerAllocator({
		capacity: async () => 2,
		clock: fixedClock()
	});
	const providerId = randomUUID();
	const a = await allocator.acquire({
		providerId,
		channelId: "5.1",
		purpose: "live",
		priority: 0
	});
	const b = await allocator.acquire({
		providerId,
		channelId: "5.2",
		purpose: "live",
		priority: 0
	});
	assert.equal(allocator.getActivity().length, 2);
	assert.equal(a.providerId, providerId);
	assert.equal(b.purpose, "live");

	// release frees the slot for a third acquire.
	assert.equal(allocator.release(a.leaseId), true);
	assert.equal(
		allocator.release(a.leaseId),
		false,
		"second release is a no-op"
	);
	const c = await allocator.acquire({
		providerId,
		channelId: "5.3",
		purpose: "live",
		priority: 0
	});
	const ids = allocator
		.getActivity()
		.map((l) => l.leaseId)
		.sort();
	assert.deepEqual(ids, [b.leaseId, c.leaseId].sort());
});

test("TunerAllocator throws TunerUnavailableError on exhaustion for live", async () => {
	const allocator = new TunerAllocator({ capacity: async () => 1 });
	const providerId = randomUUID();
	await allocator.acquire({
		providerId,
		channelId: "5.1",
		purpose: "live",
		priority: 5
	});
	await assert.rejects(
		allocator.acquire({
			providerId,
			channelId: "5.2",
			purpose: "live",
			priority: 10
		}),
		(err: unknown) => {
			assert.ok(err instanceof TunerUnavailableError);
			assert.equal(err.code, "TUNER_UNAVAILABLE");
			assert.equal(err.conflicts.length, 1);
			assert.equal(err.conflicts[0]?.channelId, "5.1");
			return true;
		}
	);
});

test("Recording pre-empts the lowest-priority live lease as a last resort", async () => {
	const bus = new EventBus();
	const events: Array<{ event: string; data: unknown }> = [];
	bus.subscribe("tuners", (e) => {
		events.push({ event: e.event, data: e.data });
	});

	const allocator = new TunerAllocator({
		capacity: async () => 2,
		bus,
		clock: fixedClock()
	});
	const providerId = randomUUID();

	// Two live leases with different priorities saturate the tuner.
	const high = await allocator.acquire({
		providerId,
		channelId: "5.1",
		purpose: "live",
		priority: 10
	});
	const low = await allocator.acquire({
		providerId,
		channelId: "5.2",
		purpose: "live",
		priority: 1
	});

	// A recording arrives — it should evict `low`, not `high`.
	const rec = await allocator.acquire({
		providerId,
		channelId: "5.3",
		purpose: "record",
		priority: 0
	});

	const remainingIds = allocator
		.getActivity()
		.map((l) => l.leaseId)
		.sort();
	assert.deepEqual(remainingIds, [high.leaseId, rec.leaseId].sort());

	const preempted = events.find((e) => e.event === "lease.preempted");
	assert.ok(preempted, "preemption event should be published on the bus");
	const data = preempted.data as { lease: TunerLease; reason: string };
	assert.equal(data.lease.leaseId, low.leaseId);
	assert.equal(data.reason, "preempted_by_higher_priority");
});

test("Recording does not pre-empt other recordings; surfaces conflicts", async () => {
	const allocator = new TunerAllocator({ capacity: async () => 1 });
	const providerId = randomUUID();
	const existing = await allocator.acquire({
		providerId,
		channelId: "5.1",
		purpose: "record",
		priority: 0
	});
	await assert.rejects(
		allocator.acquire({
			providerId,
			channelId: "5.2",
			purpose: "record",
			priority: 100
		}),
		(err: unknown) => {
			assert.ok(err instanceof TunerUnavailableError);
			assert.equal(err.conflicts.length, 1);
			assert.equal(err.conflicts[0]?.leaseId, existing.leaseId);
			return true;
		}
	);
});

test("Live request never pre-empts even a lower-priority recording", async () => {
	const allocator = new TunerAllocator({ capacity: async () => 1 });
	const providerId = randomUUID();
	await allocator.acquire({
		providerId,
		channelId: "5.1",
		purpose: "record",
		priority: -100
	});
	await assert.rejects(
		allocator.acquire({
			providerId,
			channelId: "5.2",
			purpose: "live",
			priority: 100
		}),
		TunerUnavailableError
	);
});

test("Concurrent acquires never blow past capacity (race-condition stress)", async () => {
	// Capacity resolver yields to the event loop so racing callers all
	// observe the same pre-add `active.size` if no serialisation happens.
	const allocator = new TunerAllocator({
		capacity: async () => {
			await new Promise((r) => setImmediate(r));
			return 3;
		}
	});
	const providerId = randomUUID();

	const attempts = await Promise.allSettled(
		Array.from({ length: 50 }, (_, i) =>
			allocator.acquire({
				providerId,
				channelId: `c${i}`,
				purpose: "live",
				priority: 0
			})
		)
	);

	const granted = attempts.filter((a) => a.status === "fulfilled").length;
	const failed = attempts.length - granted;
	assert.equal(granted, 3, "exactly capacity-many acquires should succeed");
	assert.equal(failed, 47);
	assert.equal(allocator.getActivity().length, 3);
});

test("Allocator isolates capacity per provider", async () => {
	const allocator = new TunerAllocator({ capacity: async () => 1 });
	const a = randomUUID();
	const b = randomUUID();
	await allocator.acquire({
		providerId: a,
		channelId: "1",
		purpose: "live",
		priority: 0
	});
	// Different provider -> independent capacity bucket.
	await allocator.acquire({
		providerId: b,
		channelId: "1",
		purpose: "live",
		priority: 0
	});
	assert.equal(allocator.getActivity().length, 2);
	assert.equal(allocator.getActivityForProvider(a).length, 1);
	assert.equal(allocator.getActivityForProvider(b).length, 1);
});

// ---------- HTTP integration ----------

function buildHttpHarness() {
	const bus = new EventBus();
	const repo = new InMemoryTunersRepository();
	const factory: TunerProviderFactory = {
		kind: "hdhomerun",
		create: (row) => ({
			id: row.id,
			kind: "hdhomerun",
			getCapabilities: () => ({
				supportsTranscoding: false,
				concurrentStreams: 2
			}),
			getLineup: async () => [],
			getStreamUrl: async () => ({ url: "http://x" }),
			getStatus: async () => ({
				online: true,
				checkedAt: new Date(0).toISOString()
			})
		}),
		discover: async () => []
	};
	const registry = new TunerRegistry([factory]);
	const service = new TunersService({
		repository: repo as unknown as TunersRepository,
		registry,
		bus
	});
	const app = createApp({
		authentication: createTestAuthentication(),
		env: { ...process.env, NODE_ENV: "test" },
		healthRepository: stubHealthRepository(),
		tunersService: service,
		epgService: {
			ensureTunerSource: async () => null
		} as unknown as EpgService,
		bus
	});
	return { app, service };
}

test("GET /api/v1/tuners/activity returns active leases", async () => {
	const { app, service } = buildHttpHarness();
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });
	assert.equal(created.status, 201);

	const empty = await request(app).get("/api/v1/tuners/activity");
	assert.equal(empty.status, 200);
	assert.deepEqual(empty.body, { leases: [] });

	const lease = await service.getAllocator().acquire({
		providerId: created.body.id,
		channelId: "5.1",
		purpose: "live",
		priority: 0
	});

	const populated = await request(app).get("/api/v1/tuners/activity");
	assert.equal(populated.status, 200);
	assert.equal(populated.body.leases.length, 1);
	assert.equal(populated.body.leases[0].leaseId, lease.leaseId);
	assert.equal(populated.body.leases[0].purpose, "live");
});

test("Deleting a tuner releases its outstanding leases", async () => {
	const { app, service } = buildHttpHarness();
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });
	await service.getAllocator().acquire({
		providerId: created.body.id,
		channelId: "5.1",
		purpose: "live",
		priority: 0
	});
	assert.equal(service.getActivity().length, 1);

	const del = await request(app).delete(`/api/v1/tuners/${created.body.id}`);
	assert.equal(del.status, 204);
	assert.equal(service.getActivity().length, 0);
});

test("OpenAPI document advertises the activity endpoint", async () => {
	const { app } = buildHttpHarness();
	const response = await request(app).get("/api/v1/openapi.json");
	assert.equal(response.status, 200);
	assert.ok(response.body.paths["/api/v1/tuners/activity"]);
	assert.ok(response.body.paths["/api/v1/tuners/activity"].get);
});
