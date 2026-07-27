import { randomUUID } from "node:crypto";

import {
	TUNER_UNAVAILABLE_ERROR_CODE,
	type TunerLease,
	type TunerLeasePurpose
} from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";

/**
 * Resolves the hard concurrent-stream cap for a given tuner row. Looked up
 * lazily (and cached by callers) because it ultimately comes from the
 * provider's `getCapabilities()` and we don't want the allocator to take a
 * direct dependency on `TunersService`.
 */
export type TunerCapacityResolver = (providerId: string) => Promise<number>;

/** Inputs to {@link TunerAllocator.acquire}. */
export interface AcquireRequest {
	/** Persisted tuner row id this lease should be issued against. */
	providerId: string;
	/** Per-tuner channel id (from `provider.getLineup()`). */
	channelId: string;
	purpose: TunerLeasePurpose;
	/**
	 * Caller-provided priority within the purpose. Recordings always rank
	 * above live regardless, but ties are broken by `priority` then by
	 * acquisition time (older = "wins" / harder to evict).
	 */
	priority: number;
}

/**
 * Thrown by {@link TunerAllocator.acquire} when no capacity is available
 * and no lease can be pre-empted. Surfaces the conflicting leases so the
 * HTTP layer can echo them in the `TUNER_UNAVAILABLE` error envelope.
 */
export class TunerUnavailableError extends Error {
	readonly code = TUNER_UNAVAILABLE_ERROR_CODE;
	readonly conflicts: TunerLease[];

	constructor(providerId: string, conflicts: TunerLease[]) {
		super(`No tuner capacity available for provider ${providerId}`);
		this.name = "TunerUnavailableError";
		this.conflicts = conflicts;
	}
}

interface InternalLease extends TunerLease {
	/** Monotonic counter used to break ties during eviction selection. */
	readonly seq: number;
}

/**
 * Tracks active tuner leases per provider and arbitrates between live
 * viewing and recordings competing for the same hard cap (see
 * `TunerCapabilities.concurrentStreams`).
 *
 * Bookkeeping is O(1) per provider: a `Map<providerId, Set<lease>>` plus
 * a `Map<leaseId, lease>` reverse index. Acquires never scan all
 * channels — at worst we scan the (small) lease set for the *one*
 * provider being acquired against to pick a pre-emption victim.
 *
 * Acquires are serialised per provider through a lightweight promise
 * chain so two concurrent callers can't both observe `active.size <
 * capacity` and race past the cap.
 */
export class TunerAllocator {
	private readonly capacity: TunerCapacityResolver;
	private readonly bus: EventBus | undefined;
	private readonly clock: () => Date;
	private readonly idFactory: () => string;

	/** Reverse index for O(1) {@link release}. */
	private readonly leasesById = new Map<string, InternalLease>();
	/** Per-provider active lease sets for O(1) capacity checks. */
	private readonly leasesByProvider = new Map<string, Set<InternalLease>>();
	/** Per-provider serialisation queue; see class doc. */
	private readonly providerLocks = new Map<string, Promise<unknown>>();

	private seqCounter = 0;

	constructor(options: {
		capacity: TunerCapacityResolver;
		bus?: EventBus;
		clock?: () => Date;
		idFactory?: () => string;
	}) {
		this.capacity = options.capacity;
		this.bus = options.bus;
		this.clock = options.clock ?? (() => new Date());
		this.idFactory = options.idFactory ?? (() => randomUUID());
	}

	/**
	 * Issue a lease against `providerId`. Returns the new {@link TunerLease}.
	 *
	 * Pre-emption rules (recordings have higher priority):
	 * - A `record` request may evict the lowest-ranked `live` lease on the
	 *   same provider when capacity is full. This is a last resort: if any
	 *   slot is free we use it.
	 * - A `record` request never evicts another `record`; tied recordings
	 *   fail with {@link TunerUnavailableError} so the operator can resolve
	 *   the conflict explicitly.
	 * - A `live` request never evicts anything; it fails with
	 *   {@link TunerUnavailableError} when the tuner is full.
	 *
	 * Evicted leases are removed from the activity table and a
	 * `lease.preempted` event is published on the `tuners` topic so the
	 * affected client can react over WS.
	 */
	acquire(request: AcquireRequest): Promise<TunerLease> {
		return this.withProviderLock(request.providerId, async () => {
			const capacity = await this.capacity(request.providerId);
			const active = this.getOrCreateProviderSet(request.providerId);

			if (active.size < capacity) {
				return this.grant(request);
			}

			// No free slot: see if pre-emption is allowed.
			const victim = this.selectPreemptionVictim(active, request);
			if (!victim) {
				throw new TunerUnavailableError(
					request.providerId,
					this.toPublicLeases(active)
				);
			}

			this.evict(victim, "preempted_by_higher_priority");
			return this.grant(request);
		});
	}

	/**
	 * Release a previously acquired lease. No-ops if the lease was already
	 * released (or was pre-empted) so callers can safely call this from
	 * `finally` blocks without coordinating with eviction events.
	 */
	release(leaseId: string): boolean {
		const lease = this.leasesById.get(leaseId);
		if (!lease) {
			return false;
		}
		this.removeLease(lease);
		this.publish("lease.released", { lease: this.toPublicLease(lease) });
		return true;
	}

	/** Snapshot of every active lease across every provider. */
	getActivity(): TunerLease[] {
		return [...this.leasesById.values()].map((lease) =>
			this.toPublicLease(lease)
		);
	}

	/** Active leases for one provider; useful for status panels. */
	getActivityForProvider(providerId: string): TunerLease[] {
		const set = this.leasesByProvider.get(providerId);
		if (!set) {
			return [];
		}
		return this.toPublicLeases(set);
	}

	// ---------- internals ----------

	private grant(request: AcquireRequest): TunerLease {
		const lease: InternalLease = {
			leaseId: this.idFactory(),
			providerId: request.providerId,
			channelId: request.channelId,
			purpose: request.purpose,
			priority: request.priority,
			acquiredAt: this.clock().toISOString(),
			seq: ++this.seqCounter
		};
		this.leasesById.set(lease.leaseId, lease);
		this.getOrCreateProviderSet(request.providerId).add(lease);
		this.publish("lease.acquired", { lease: this.toPublicLease(lease) });
		return this.toPublicLease(lease);
	}

	/**
	 * Pick the lease that should be evicted to satisfy `incoming`, or
	 * `undefined` if no eviction is permitted. Implements the policy
	 * documented on {@link acquire}.
	 */
	private selectPreemptionVictim(
		active: Set<InternalLease>,
		incoming: AcquireRequest
	): InternalLease | undefined {
		if (incoming.purpose !== "record") {
			return undefined;
		}
		let victim: InternalLease | undefined;
		for (const lease of active) {
			if (lease.purpose !== "live") {
				continue;
			}
			if (!victim) {
				victim = lease;
				continue;
			}
			// Prefer evicting the lowest priority; on ties evict the newest
			// (higher seq) so long-running viewers are protected against churn.
			if (
				lease.priority < victim.priority ||
				(lease.priority === victim.priority && lease.seq > victim.seq)
			) {
				victim = lease;
			}
		}
		return victim;
	}

	private evict(lease: InternalLease, reason: string): void {
		this.removeLease(lease);
		this.publish("lease.preempted", {
			lease: this.toPublicLease(lease),
			reason
		});
	}

	private removeLease(lease: InternalLease): void {
		this.leasesById.delete(lease.leaseId);
		const set = this.leasesByProvider.get(lease.providerId);
		if (!set) {
			return;
		}
		set.delete(lease);
		if (set.size === 0) {
			this.leasesByProvider.delete(lease.providerId);
		}
	}

	private getOrCreateProviderSet(providerId: string): Set<InternalLease> {
		let set = this.leasesByProvider.get(providerId);
		if (!set) {
			set = new Set();
			this.leasesByProvider.set(providerId, set);
		}
		return set;
	}

	/**
	 * Serialise async work per provider id. Two concurrent acquires against
	 * the same provider would otherwise both read `active.size < capacity`
	 * before either added its lease, blowing past the cap.
	 *
	 * The lock map keeps at most one entry per provider id (bounded by the
	 * number of configured tuners), so unbounded growth isn't a concern.
	 */
	private async withProviderLock<T>(
		providerId: string,
		fn: () => Promise<T>
	): Promise<T> {
		const previous = this.providerLocks.get(providerId) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chained = previous.then(() => next);
		this.providerLocks.set(providerId, chained);
		try {
			await previous;
			return await fn();
		} finally {
			release();
			// If we're still the tail of the queue, drop the entry so a quiescent
			// provider doesn't retain a settled promise reference forever.
			if (this.providerLocks.get(providerId) === chained) {
				this.providerLocks.delete(providerId);
			}
		}
	}

	private toPublicLease(lease: InternalLease): TunerLease {
		return {
			leaseId: lease.leaseId,
			providerId: lease.providerId,
			channelId: lease.channelId,
			purpose: lease.purpose,
			priority: lease.priority,
			acquiredAt: lease.acquiredAt
		};
	}

	private toPublicLeases(set: Iterable<InternalLease>): TunerLease[] {
		const out: TunerLease[] = [];
		for (const lease of set) {
			out.push(this.toPublicLease(lease));
		}
		return out;
	}

	private publish(
		event: "lease.acquired" | "lease.released" | "lease.preempted",
		data: Record<string, unknown>
	): void {
		if (!this.bus) {
			return;
		}
		this.bus.publish({ topic: "tuners", event, data });
	}
}
