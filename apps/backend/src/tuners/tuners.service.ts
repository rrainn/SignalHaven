import {
	tunerCreateSchema,
	tunerPatchSchema,
	tunerSchema,
	type Tuner,
	type TunerCreate,
	type TunerDiscoveryResult,
	type TunerLease,
	type TunerPatch
} from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import type {
	LineupSyncState,
	TunersRepository,
	UpdateTunerInput
} from "../repositories/tuners.repository";

import type { TunerProvider, TunerRegistry } from "./provider";
import { TunerAllocator } from "./tuner-allocator";

export interface TunersServiceOptions {
	repository: TunersRepository;
	registry: TunerRegistry;
	/** Optional bus; when provided, lifecycle events are published. */
	bus?: EventBus;
	/**
	 * Optional pre-built allocator. When omitted, the service builds one
	 * that resolves capacity from each provider's `getCapabilities()`.
	 * Tests may inject a custom allocator (e.g. with a fake clock).
	 */
	allocator?: TunerAllocator;
}

export class TunerNotFoundError extends Error {
	constructor(id: string) {
		super(`Tuner ${id} not found`);
		this.name = "TunerNotFoundError";
	}
}

export class UnsupportedTunerKindError extends Error {
	constructor(kind: string) {
		super(`Unsupported tuner kind "${kind}"`);
		this.name = "UnsupportedTunerKindError";
	}
}

/**
 * Persistence + lifecycle facade for tuners. Validates per-kind config via
 * the shared zod schemas, hydrates the matching `TunerProvider` through the
 * registry, and publishes change events on the WS bus so the UI can react
 * in real time.
 */
export class TunersService {
	private readonly repository: TunersRepository;
	private readonly registry: TunerRegistry;
	private readonly bus: EventBus | undefined;
	/**
	 * Caches one provider instance per tuner id. Providers may carry their
	 * own per-instance state (lineup cache, logo cache, ...) that we want to
	 * preserve across calls; recreating them on every request would defeat
	 * those caches. Invalidated on update/delete.
	 */
	private readonly providerCache = new Map<string, TunerProvider>();
	private readonly allocator: TunerAllocator;

	constructor(options: TunersServiceOptions) {
		this.repository = options.repository;
		this.registry = options.registry;
		this.bus = options.bus;
		this.allocator =
			options.allocator ??
			new TunerAllocator({
				capacity: async (providerId) => {
					const provider = await this.getProviderById(providerId);
					return provider.getCapabilities().concurrentStreams;
				},
				...(this.bus ? { bus: this.bus } : {})
			});
	}

	/** Returns the in-process tuner allocator (see {@link TunerAllocator}). */
	getAllocator(): TunerAllocator {
		return this.allocator;
	}

	/** Snapshot of every active tuner lease. */
	getActivity(): TunerLease[] {
		return this.allocator.getActivity();
	}

	async list(): Promise<Tuner[]> {
		const rows = await this.repository.list();
		return rows.map((row) => this.toApi(row));
	}

	async getById(id: string): Promise<Tuner> {
		const row = await this.repository.getById(id);
		if (!row) {
			throw new TunerNotFoundError(id);
		}
		return this.toApi(row);
	}

	/** Record a lineup import outcome through the service-owned repository. */
	async recordLineupSync(id: string, state: LineupSyncState): Promise<void> {
		await this.repository.recordLineupSync(id, state);
	}

	async create(input: unknown): Promise<Tuner> {
		const parsed = tunerCreateSchema.parse(input) as TunerCreate;
		if (!this.registry.has(parsed.kind)) {
			throw new UnsupportedTunerKindError(parsed.kind);
		}
		const created = await this.repository.create({
			kind: parsed.kind,
			name: parsed.name,
			config: parsed.config as Record<string, unknown>
		});
		const api = this.toApi(created);
		this.publish("created", api);
		return api;
	}

	async update(id: string, input: unknown): Promise<Tuner> {
		const patch = tunerPatchSchema.parse(input) as TunerPatch;
		const existing = await this.repository.getById(id);
		if (!existing) {
			throw new TunerNotFoundError(id);
		}

		if (patch.kind !== undefined && !this.registry.has(patch.kind)) {
			throw new UnsupportedTunerKindError(patch.kind);
		}

		const updateInput: UpdateTunerInput = {};
		if (patch.name !== undefined) {
			updateInput.name = patch.name;
		}
		if (patch.kind !== undefined) {
			updateInput.kind = patch.kind;
		}
		if (patch.config !== undefined) {
			updateInput.config = patch.config;
		}

		const updated = await this.repository.update(id, updateInput);
		if (!updated) {
			throw new TunerNotFoundError(id);
		}
		// Config or kind may have changed; drop the cached provider so the next
		// accessor hydrates a fresh instance from the new row.
		this.providerCache.delete(id);
		const api = this.toApi(updated);
		this.publish("updated", api);
		return api;
	}

	async delete(id: string): Promise<void> {
		const existing = await this.repository.getById(id);
		if (!existing) {
			throw new TunerNotFoundError(id);
		}
		const removed = await this.repository.delete(id);
		if (!removed) {
			throw new TunerNotFoundError(id);
		}
		this.providerCache.delete(id);
		// Drop any outstanding leases against the removed tuner so the activity
		// table doesn't keep referencing a row that no longer exists. We
		// release rather than silently delete so subscribers see the lifecycle.
		for (const lease of this.allocator.getActivityForProvider(id)) {
			this.allocator.release(lease.leaseId);
		}
		if (this.bus) {
			this.bus.publish({
				topic: "tuners",
				event: "deleted",
				data: { id }
			});
		}
	}

	/**
	 * Run discovery across every registered factory and publish the merged
	 * result on the bus so subscribed clients can show candidates without
	 * polling. Returns the same payload to the HTTP caller.
	 */
	async discover(): Promise<TunerDiscoveryResult[]> {
		const results = await this.registry.discover();
		if (this.bus) {
			this.bus.publish({
				topic: "tuners",
				event: "discovered",
				data: { results }
			});
		}
		return results;
	}

	/**
	 * Hydrate the live `TunerProvider` for the given persisted row. Used by
	 * routes that need to talk to the underlying device (lineup, status, logo
	 * proxy, ...). Throws {@link TunerNotFoundError} when the row is missing
	 * and {@link UnsupportedTunerKindError} when its kind isn't registered.
	 */
	async getProviderById(id: string): Promise<TunerProvider> {
		const cached = this.providerCache.get(id);
		if (cached) {
			return cached;
		}
		const row = await this.repository.getById(id);
		if (!row) {
			throw new TunerNotFoundError(id);
		}
		const api = this.toApi(row);
		if (!this.registry.has(api.kind)) {
			throw new UnsupportedTunerKindError(api.kind);
		}
		const provider = this.registry.fromRow(api);
		this.providerCache.set(id, provider);
		return provider;
	}

	private toApi(row: {
		id: string;
		kind: string;
		name: string;
		config: unknown;
		createdAt: Date;
		updatedAt: Date;
		lastLineupSyncAt: Date | null;
		lastLineupSyncStatus: string | null;
		lastLineupSyncError: string | null;
	}): Tuner {
		return tunerSchema.parse({
			id: row.id,
			kind: row.kind,
			name: row.name,
			config: row.config,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			lastLineupSyncAt: row.lastLineupSyncAt?.toISOString() ?? null,
			lastLineupSyncStatus: row.lastLineupSyncStatus,
			lastLineupSyncError: row.lastLineupSyncError
		});
	}

	private publish(event: "created" | "updated", tuner: Tuner): void {
		if (!this.bus) {
			return;
		}
		this.bus.publish({
			topic: "tuners",
			event,
			data: { tuner }
		});
	}
}
