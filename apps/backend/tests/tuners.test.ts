import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
	Tuner,
	TunerCapabilities,
	TunerDiscoveryResult,
	TunerLineupChannel,
	TunerStatus,
	TunerStreamUrl
} from "@signalhaven/shared";
import request from "supertest";

import { createApp } from "../src/app";
import type { EpgService } from "../src/epg/epg.service";
import { EventBus } from "../src/events/event-bus";
import type { HealthRepository } from "../src/repositories/health.repository";
import type {
	ChannelsRepository,
	ChannelRecord,
	CreateChannelInput
} from "../src/repositories/channels.repository";
import type {
	TunersRepository,
	UpdateTunerInput,
	CreateTunerInput
} from "../src/repositories/tuners.repository";
import {
	TunerRegistry,
	type TunerProvider,
	type TunerProviderFactory
} from "../src/tuners/provider";
import { TunersService } from "../src/tuners/tuners.service";
import { TunerLineupSyncService } from "../src/tuners/tuner-lineup-sync.service";

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
	lastLineupSyncAt: Date | null;
	lastLineupSyncStatus: string | null;
	lastLineupSyncError: string | null;
}

/** In-memory stand-in for ChannelsRepository, used by sync tests. */
class InMemoryChannelsRepository {
	private rows = new Map<string, ChannelRecord>();

	async create(input: CreateChannelInput): Promise<ChannelRecord> {
		const row = {
			id: randomUUID(),
			tunerId: input.tunerId,
			number: input.number,
			providerChannelId: input.providerChannelId ?? null,
			name: input.name,
			logoUrl: input.logoUrl ?? null,
			tvgId: input.tvgId ?? null,
			enabled: input.enabled,
			sortOrder: input.sortOrder,
			lineupMissingCount: 0
		} as ChannelRecord;
		this.rows.set(row.id, row);
		return row;
	}

	async getById(id: string): Promise<ChannelRecord | null> {
		return this.rows.get(id) ?? null;
	}

	async list(): Promise<ChannelRecord[]> {
		return [...this.rows.values()];
	}

	async listByTunerId(tunerId: string): Promise<ChannelRecord[]> {
		return [...this.rows.values()].filter((r) => r.tunerId === tunerId);
	}

	async update(
		id: string,
		patch: {
			number?: string;
			providerChannelId?: string | null;
			name?: string;
			logoUrl?: string | null;
			tvgId?: string | null;
			sortOrder?: number;
			lineupMissingCount?: number;
		}
	): Promise<ChannelRecord | null> {
		const row = this.rows.get(id);
		if (!row) return null;
		const updated = { ...row, ...patch } as ChannelRecord;
		this.rows.set(id, updated);
		return updated;
	}

	async deleteById(id: string): Promise<void> {
		this.rows.delete(id);
	}
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
			updatedAt: now,
			lastLineupSyncAt: null,
			lastLineupSyncStatus: null,
			lastLineupSyncError: null
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

	async recordLineupSync(
		id: string,
		state: { status: "success" | "error"; error?: string }
	): Promise<void> {
		const row = this.rows.get(id);
		if (!row) return;
		row.lastLineupSyncAt = new Date();
		row.lastLineupSyncStatus = state.status;
		row.lastLineupSyncError = state.error ?? null;
	}

	async update(id: string, input: UpdateTunerInput): Promise<TunerRow | null> {
		const existing = this.rows.get(id);
		if (!existing) {
			return null;
		}
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

/**
 * Mock provider used for both registry and route tests. Records every method
 * call so tests can assert that the rest of the system actually delegates
 * through `TunerProvider` rather than reaching past it.
 */
class MockProvider implements TunerProvider {
	readonly kind = "hdhomerun" as const;
	readonly id: string;
	readonly calls: string[] = [];

	constructor(row: Tuner) {
		this.id = row.id;
	}

	getCapabilities(): TunerCapabilities {
		this.calls.push("getCapabilities");
		return { supportsTranscoding: true, concurrentStreams: 3 };
	}

	async getLineup(): Promise<TunerLineupChannel[]> {
		this.calls.push("getLineup");
		return [{ channelId: "1", number: "5.1", name: "Mock 5" }];
	}

	async getStreamUrl(channelId: string): Promise<TunerStreamUrl> {
		this.calls.push(`getStreamUrl:${channelId}`);
		return { url: `http://mock/stream/${channelId}` };
	}

	async getStatus(): Promise<TunerStatus> {
		this.calls.push("getStatus");
		return { online: true, checkedAt: new Date(0).toISOString() };
	}
}

function mockFactory(
	discovered: TunerDiscoveryResult[] = []
): TunerProviderFactory & { lastInstance?: MockProvider } {
	const factory: TunerProviderFactory & { lastInstance?: MockProvider } = {
		kind: "hdhomerun",
		create(row) {
			const instance = new MockProvider(row);
			factory.lastInstance = instance;
			return instance;
		},
		async discover() {
			return discovered;
		}
	};
	return factory;
}

interface Harness {
	app: ReturnType<typeof createApp>;
	bus: EventBus;
	service: TunersService;
	repo: InMemoryTunersRepository;
	channelsRepo: InMemoryChannelsRepository;
	registry: TunerRegistry;
	factory: ReturnType<typeof mockFactory>;
}

function buildHarness(
	discovered: TunerDiscoveryResult[] = [],
	epgService?: EpgService
): Harness {
	const bus = new EventBus();
	const repo = new InMemoryTunersRepository();
	const channelsRepo = new InMemoryChannelsRepository();
	const factory = mockFactory(discovered);
	const registry = new TunerRegistry([factory]);
	const service = new TunersService({
		repository: repo as unknown as TunersRepository,
		registry,
		bus
	});
	const lineupSyncService = new TunerLineupSyncService({
		channels: channelsRepo as unknown as ChannelsRepository,
		tuners: service
	});

	const app = createApp({
		env: { ...process.env, NODE_ENV: "test" },
		healthRepository: stubHealthRepository(),
		tunersService: service,
		channelsRepository: channelsRepo as unknown as ChannelsRepository,
		lineupSyncService,
		epgService:
			epgService ??
			({
				ensureTunerSource: async () => null
			} as unknown as EpgService),
		bus
	});

	return { app, bus, service, repo, channelsRepo, registry, factory };
}

test("TunerRegistry hydrates providers via factory.create from a row", () => {
	const factory = mockFactory();
	const registry = new TunerRegistry([factory]);
	assert.ok(registry.has("hdhomerun"));
	assert.deepEqual(registry.kinds(), ["hdhomerun"]);

	const row: Tuner = {
		id: randomUUID(),
		kind: "hdhomerun",
		name: "Living Room",
		config: { host: "192.0.2.10" },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
	const provider = registry.fromRow(row);
	assert.equal(provider.kind, "hdhomerun");
	assert.equal(provider.id, row.id);
	assert.equal(provider.getCapabilities().concurrentStreams, 3);
});

test("TunerRegistry.fromRow throws on unknown kind", () => {
	const registry = new TunerRegistry([mockFactory()]);
	const row: Tuner = {
		id: randomUUID(),
		kind: "iptv",
		name: "x",
		config: { url: "http://example.com/p.m3u" },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
	assert.throws(() => registry.fromRow(row), /No tuner provider registered/);
});

test("TunerRegistry.discover merges results and isolates failing providers", async () => {
	const ok: TunerProviderFactory = {
		kind: "hdhomerun",
		create: () => {
			throw new Error("not used");
		},
		discover: async () => [
			{ kind: "hdhomerun", name: "Found", config: { host: "10.0.0.1" } }
		]
	};
	const bad: TunerProviderFactory = {
		kind: "iptv",
		create: () => {
			throw new Error("not used");
		},
		discover: async () => {
			throw new Error("network down");
		}
	};
	const registry = new TunerRegistry([ok, bad]);
	const errors: Array<{ kind: string; error: unknown }> = [];
	const results = await registry.discover((kind, error) => {
		errors.push({ kind, error });
	});
	assert.equal(results.length, 1);
	assert.equal(errors.length, 1);
	assert.equal(errors[0]?.kind, "iptv");
});

test("POST /api/v1/tuners validates body and persists", async () => {
	const { app } = buildHarness();
	const response = await request(app)
		.post("/api/v1/tuners")
		.send({
			kind: "hdhomerun",
			name: "Den",
			config: { host: "192.0.2.20" }
		});

	assert.equal(response.status, 201);
	assert.equal(response.body.kind, "hdhomerun");
	assert.equal(response.body.name, "Den");
	assert.deepEqual(response.body.config, { host: "192.0.2.20" });
	assert.match(response.body.id, /[0-9a-f-]{36}/);
});

test("POST /api/v1/tuners provisions its tuner-owned guide source", async () => {
	const provisioned: Tuner[] = [];
	const epgService = {
		ensureTunerSource: async (tuner: Tuner) => {
			provisioned.push(tuner);
			return null;
		}
	} as unknown as EpgService;
	const { app } = buildHarness([], epgService);

	const response = await request(app)
		.post("/api/v1/tuners")
		.send({
			kind: "hdhomerun",
			name: "Den",
			config: { host: "192.0.2.20" }
		});

	assert.equal(response.status, 201);
	assert.equal(provisioned.length, 1);
	assert.equal(provisioned[0]?.id, response.body.id);
});

test("POST /api/v1/tuners rejects per-kind config drift", async () => {
	const { app } = buildHarness();
	const response = await request(app)
		.post("/api/v1/tuners")
		.send({
			kind: "iptv",
			name: "no url",
			config: { host: "192.0.2.30" }
		});

	// Two layers reject this: zod (no `url`) and the registry (kind not
	// registered in this harness). Either way it must be a 4xx with a
	// validation envelope.
	assert.equal(response.status, 400);
	assert.ok(response.body.error);
});

test("GET /api/v1/tuners returns list ordered by creation", async () => {
	const { app } = buildHarness();
	await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "A", config: { host: "10.0.0.1" } })
		.expect(201);
	await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "B", config: { host: "10.0.0.2" } })
		.expect(201);

	const response = await request(app).get("/api/v1/tuners");
	assert.equal(response.status, 200);
	assert.equal(response.body.items.length, 2);
	assert.equal(response.body.items[0].name, "A");
	assert.equal(response.body.items[1].name, "B");
});

test("GET /api/v1/tuners/:id returns the row or 404", async () => {
	const { app } = buildHarness();
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });

	const ok = await request(app).get(`/api/v1/tuners/${created.body.id}`);
	assert.equal(ok.status, 200);
	assert.equal(ok.body.id, created.body.id);

	const missing = await request(app).get(
		"/api/v1/tuners/00000000-0000-4000-8000-000000000000"
	);
	assert.equal(missing.status, 404);
	assert.equal(missing.body.error.code, "not_found");
});

test("PATCH /api/v1/tuners/:id updates name and bumps updatedAt", async () => {
	const { app } = buildHarness();
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });

	const before = created.body.updatedAt;
	await new Promise((r) => setTimeout(r, 5));
	const patch = await request(app)
		.patch(`/api/v1/tuners/${created.body.id}`)
		.send({ name: "Living Room" });

	assert.equal(patch.status, 200);
	assert.equal(patch.body.name, "Living Room");
	assert.notEqual(patch.body.updatedAt, before);
});

test("PATCH rejects config without kind (and vice versa)", async () => {
	const { app } = buildHarness();
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });

	const orphanConfig = await request(app)
		.patch(`/api/v1/tuners/${created.body.id}`)
		.send({ config: { host: "10.0.0.2" } });
	assert.equal(orphanConfig.status, 400);

	const orphanKind = await request(app)
		.patch(`/api/v1/tuners/${created.body.id}`)
		.send({ kind: "hdhomerun" });
	assert.equal(orphanKind.status, 400);
});

test("DELETE /api/v1/tuners/:id removes the row and 404s afterwards", async () => {
	const { app } = buildHarness();
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });

	const del = await request(app).delete(`/api/v1/tuners/${created.body.id}`);
	assert.equal(del.status, 204);

	const missing = await request(app).get(`/api/v1/tuners/${created.body.id}`);
	assert.equal(missing.status, 404);
});

test("POST /api/v1/tuners/discover delegates to the registry", async () => {
	const { app } = buildHarness([
		{ kind: "hdhomerun", name: "Auto", config: { host: "10.1.1.1" } }
	]);
	const response = await request(app).post("/api/v1/tuners/discover");
	assert.equal(response.status, 200);
	assert.equal(response.body.results.length, 1);
	assert.equal(response.body.results[0].name, "Auto");
});

test("CRUD lifecycle publishes tuners.* events on the bus", async () => {
	const { app, bus } = buildHarness([
		{ kind: "hdhomerun", name: "Auto", config: { host: "10.1.1.1" } }
	]);
	const received: Array<{ event: string; data: unknown }> = [];
	bus.subscribe("tuners", (e) => {
		received.push({ event: e.event, data: e.data });
	});

	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } });
	await request(app)
		.patch(`/api/v1/tuners/${created.body.id}`)
		.send({ name: "Living" });
	await request(app).delete(`/api/v1/tuners/${created.body.id}`);
	await request(app).post("/api/v1/tuners/discover");

	const events = received.map((r) => r.event);
	assert.deepEqual(events, ["created", "updated", "deleted", "discovered"]);
});

test("OpenAPI document advertises the tuner endpoints", async () => {
	const { app } = buildHarness();
	const response = await request(app).get("/api/v1/openapi.json");
	assert.equal(response.status, 200);
	assert.ok(response.body.paths["/api/v1/tuners"]);
	assert.ok(response.body.paths["/api/v1/tuners"].get);
	assert.ok(response.body.paths["/api/v1/tuners"].post);
	assert.ok(response.body.paths["/api/v1/tuners/discover"]);
	assert.ok(response.body.paths["/api/v1/tuners/{id}"]);
	assert.ok(response.body.paths["/api/v1/tuners/{id}"].patch);
	assert.ok(response.body.paths["/api/v1/tuners/{id}"].delete);
});

// ---------------------------------------------------------------------------
// POST /api/v1/tuners/:id/sync
// ---------------------------------------------------------------------------

test("POST /api/v1/tuners/:id/sync adds all lineup channels on first sync", async () => {
	const { app } = buildHarness();

	// Create the tuner so the route can look it up.
	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } })
		.expect(201);

	// MockProvider.getLineup() returns [{ channelId:"1", number:"5.1", name:"Mock 5" }]
	const sync = await request(app).post(
		`/api/v1/tuners/${created.body.id}/sync`
	);

	assert.equal(sync.status, 200);
	assert.equal(sync.body.added, 1);
	assert.equal(sync.body.updated, 0);
	assert.equal(sync.body.removed, 0);
	assert.equal(sync.body.total, 1);
});

test("POST /api/v1/tuners/:id/sync counts an update when the channel name changes", async () => {
	const { app, channelsRepo, factory } = buildHarness();

	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } })
		.expect(201);

	// Pre-populate the channel with the current name so there is an existing row.
	await channelsRepo.create({
		tunerId: created.body.id,
		number: "5.1",
		name: "Old Name",
		enabled: true,
		sortOrder: 0
	});

	// Override the mock to return a different name for the same channel number.
	const provider = factory.lastInstance;
	if (provider) {
		provider.getLineup = async () => [
			{ channelId: "1", number: "5.1", name: "New Name" }
		];
	}

	const sync = await request(app).post(
		`/api/v1/tuners/${created.body.id}/sync`
	);

	assert.equal(sync.status, 200);
	assert.equal(sync.body.added, 0);
	assert.equal(sync.body.updated, 1);
	assert.equal(sync.body.removed, 0);
	assert.equal(sync.body.total, 1);
});

test("POST /api/v1/tuners/:id/sync removes channels after three fresh misses", async () => {
	const { app, channelsRepo, factory } = buildHarness();

	const created = await request(app)
		.post("/api/v1/tuners")
		.send({ kind: "hdhomerun", name: "Den", config: { host: "10.0.0.1" } })
		.expect(201);

	// Seed a channel that will NOT appear in the provider lineup.
	await channelsRepo.create({
		tunerId: created.body.id,
		number: "99.9",
		name: "Gone",
		enabled: true,
		sortOrder: 1
	});

	// Trigger provider creation so factory.lastInstance is populated before
	// we override getLineup. The status endpoint calls getProviderById which
	// hydrates and caches the provider instance.
	await request(app).get(`/api/v1/tuners/${created.body.id}/status`);

	// Override the mock to return an empty lineup (no channels at all).
	const provider = factory.lastInstance;
	if (provider) {
		provider.getLineup = async () => [];
	}

	const first = await request(app).post(
		`/api/v1/tuners/${created.body.id}/sync`
	);
	const second = await request(app).post(
		`/api/v1/tuners/${created.body.id}/sync`
	);
	const sync = await request(app).post(
		`/api/v1/tuners/${created.body.id}/sync`
	);

	assert.equal(first.body.removed, 0);
	assert.equal(second.body.removed, 0);
	assert.equal(sync.status, 200);
	assert.equal(sync.body.added, 0);
	assert.equal(sync.body.updated, 0);
	assert.equal(sync.body.removed, 1);
	assert.equal(sync.body.total, 0);
});

test("POST /api/v1/tuners/:id/sync returns 404 for unknown tuner", async () => {
	const { app } = buildHarness();
	const res = await request(app).post(
		"/api/v1/tuners/00000000-0000-4000-8000-000000000000/sync"
	);
	assert.equal(res.status, 404);
	assert.equal(res.body.error.code, "not_found");
});
