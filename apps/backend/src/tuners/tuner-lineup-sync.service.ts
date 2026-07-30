import type {
	TunerLineupChannel,
	TunerSyncResponse
} from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import type {
	ChannelRecord,
	ChannelsRepository
} from "../repositories/channels.repository";

import type { TunersService } from "./tuners.service";

export interface TunerLineupSyncServiceOptions {
	channels: ChannelsRepository;
	tuners: TunersService;
	bus?: EventBus;
	/** Resolves the successful-miss threshold for marking a source unavailable. */
	resolveRemovalThreshold?: () => Promise<number>;
	/** Resolves the live automatic-import policy for each scheduler tick. */
	resolveSchedule?: () => Promise<{ enabled: boolean; intervalHours: number }>;
	/** Clock injection keeps cadence behavior deterministic in tests. */
	now?: () => Date;
	/** Re-evaluates guide mappings after provider metadata has been persisted. */
	onSyncComplete?: (tunerId: string) => Promise<void> | void;
}

export interface SyncTunerOptions {
	/** Invalidates the provider cache before reading the lineup. */
	forceRefresh?: boolean;
}

/**
 * Imports tuner lineups into persistent channels with overlap protection and
 * retained-source lifecycle. A failed fetch never mutates channel state or advances a
 * missing-channel counter.
 */
export class TunerLineupSyncService {
	private readonly inFlight = new Map<string, Promise<TunerSyncResponse>>();
	private readonly now: () => Date;

	constructor(private readonly options: TunerLineupSyncServiceOptions) {
		this.now = options.now ?? (() => new Date());
	}

	/** Coalesce concurrent imports for the same tuner into one reconciliation. */
	syncTuner(
		tunerId: string,
		options: SyncTunerOptions = {}
	): Promise<TunerSyncResponse> {
		const active = this.inFlight.get(tunerId);
		if (active) return active;

		const operation = this.performSync(tunerId, options).finally(() => {
			if (this.inFlight.get(tunerId) === operation) {
				this.inFlight.delete(tunerId);
			}
		});
		this.inFlight.set(tunerId, operation);
		return operation;
	}

	/** Sync every tuner whose last attempt is older than the configured cadence. */
	async syncDueTuners(): Promise<void> {
		const schedule = await (this.options.resolveSchedule?.() ??
			Promise.resolve({ enabled: true, intervalHours: 24 }));
		if (!schedule.enabled) return;
		const nowMs = this.now().getTime();
		const intervalMs = Math.max(1, schedule.intervalHours) * 60 * 60 * 1000;
		const tuners = await this.options.tuners.list();

		const outcomes = await Promise.allSettled(
			tuners
				.filter((tuner) => {
					// Retry transient failures on the next hourly tick instead of
					// making operators wait for the full successful-sync cadence.
					if (tuner.lastLineupSyncStatus === "error") return true;
					const last = tuner.lastLineupSyncAt
						? Date.parse(tuner.lastLineupSyncAt)
						: Number.NaN;
					return !Number.isFinite(last) || nowMs - last >= intervalMs;
				})
				.map((tuner) => this.syncTuner(tuner.id, { forceRefresh: true }))
		);
		const failures = outcomes
			.filter((outcome) => outcome.status === "rejected")
			.map((outcome) => outcome.reason);
		if (failures.length > 0) {
			// Individual tuner failures are already persisted and published above.
			throw new Error(`${failures.length} tuner lineup sync(s) failed`);
		}
	}

	private async performSync(
		tunerId: string,
		options: SyncTunerOptions
	): Promise<TunerSyncResponse> {
		try {
			const provider = await this.options.tuners.getProviderById(tunerId);
			if (options.forceRefresh) provider.refreshLineup?.();
			const lineup = await provider.getLineup();
			const existing = await this.options.channels.listByTunerId(tunerId);
			const matches = matchLineupChannels(lineup, existing);
			const matchedExistingIds = new Set(
				[...matches.values()].map((channel) => channel.id)
			);
			const removalThreshold = Math.max(
				2,
				await (this.options.resolveRemovalThreshold?.() ?? Promise.resolve(3))
			);
			let added = 0;
			let updated = 0;
			const removed = 0;
			let unavailable = 0;

			for (let index = 0; index < lineup.length; index += 1) {
				const incoming = lineup[index]!;
				const stored = matches.get(index);
				if (!stored) {
					await this.options.channels.create({
						tunerId,
						number: incoming.number,
						providerChannelId: incoming.channelId,
						name: incoming.name,
						tvgId: incoming.tvgId ?? null,
						...(incoming.logoUrl !== undefined
							? { logoUrl: incoming.logoUrl }
							: {}),
						enabled: true,
						sortOrder: index
					});
					added += 1;
					continue;
				}

				const logoUrl = incoming.logoUrl ?? null;
				const tvgId = incoming.tvgId ?? null;
				const displayChanged =
					stored.number !== incoming.number ||
					stored.providerChannelId !== incoming.channelId ||
					stored.name !== incoming.name ||
					stored.logoUrl !== logoUrl ||
					stored.tvgId !== tvgId ||
					stored.sortOrder !== index;
				if (
					displayChanged ||
					stored.lineupMissingCount > 0 ||
					stored.sourceStatus !== "active"
				) {
					await this.options.channels.update(stored.id, {
						...(displayChanged
							? {
									number: incoming.number,
									providerChannelId: incoming.channelId,
									name: incoming.name,
									logoUrl,
									tvgId,
									sortOrder: index
								}
							: {}),
						lineupMissingCount: 0,
						sourceStatus: "active"
					});
					if (displayChanged) updated += 1;
				}
			}

			for (const stored of existing) {
				if (matchedExistingIds.has(stored.id)) continue;
				const missingCount = stored.lineupMissingCount + 1;
				if (missingCount >= removalThreshold) {
					await this.options.channels.update(stored.id, {
						lineupMissingCount: missingCount,
						sourceStatus: "unavailable"
					});
					if (stored.sourceStatus !== "unavailable") unavailable += 1;
				} else {
					await this.options.channels.update(stored.id, {
						lineupMissingCount: missingCount,
						sourceStatus: "missing"
					});
				}
			}

			const after = await this.options.channels.listByTunerId(tunerId);
			const result: TunerSyncResponse = {
				added,
				updated,
				removed,
				unavailable,
				missing: after.filter((channel) => channel.sourceStatus === "missing")
					.length,
				total: after.length
			};
			await this.options.tuners.recordLineupSync(tunerId, {
				status: "success"
			});
			this.options.bus?.publish({
				topic: "tuners",
				event: "lineup.synced",
				data: { tunerId, result, syncedAt: this.now().toISOString() }
			});
			try {
				await this.options.onSyncComplete?.(tunerId);
			} catch (error) {
				// A guide failure should not turn a successful channel import into a retry.
				this.options.bus?.publish({
					topic: "tuners",
					event: "lineup.match-failed",
					data: {
						tunerId,
						message: sanitizeLineupError(error),
						attemptedAt: this.now().toISOString()
					}
				});
			}
			return result;
		} catch (error) {
			const message = sanitizeLineupError(error);
			await this.options.tuners
				.recordLineupSync(tunerId, {
					status: "error",
					error: message.slice(0, 1000)
				})
				.catch(() => undefined);
			this.options.bus?.publish({
				topic: "tuners",
				event: "lineup.failed",
				data: { tunerId, message, attemptedAt: this.now().toISOString() }
			});
			throw error;
		}
	}
}

/**
 * Matches provider entries without letting a new positional channel steal a
 * legacy row that has a stronger identity match later in the lineup.
 */
function matchLineupChannels(
	lineup: readonly TunerLineupChannel[],
	existing: readonly ChannelRecord[]
): Map<number, ChannelRecord> {
	const matches = new Map<number, ChannelRecord>();
	const usedExistingIds = new Set<string>();

	matchUniqueIdentity(
		lineup,
		existing,
		matches,
		usedExistingIds,
		(incoming) => incoming.channelId,
		(stored) => stored.providerChannelId
	);
	matchUniqueIdentity(
		lineup,
		existing,
		matches,
		usedExistingIds,
		(incoming) => incoming.tvgId?.trim() || null,
		(stored) => stored.tvgId?.trim() || null
	);
	matchUniqueIdentity(
		lineup,
		existing,
		matches,
		usedExistingIds,
		(incoming) => incoming.name.trim() || null,
		(stored) => (stored.providerChannelId ? null : stored.name.trim() || null)
	);
	matchUniqueIdentity(
		lineup,
		existing,
		matches,
		usedExistingIds,
		(incoming) => incoming.number,
		(stored) => (stored.providerChannelId ? null : stored.number)
	);

	return matches;
}

/** Match only unambiguous identities so duplicate names cannot merge rows. */
function matchUniqueIdentity(
	lineup: readonly TunerLineupChannel[],
	existing: readonly ChannelRecord[],
	matches: Map<number, ChannelRecord>,
	usedExistingIds: Set<string>,
	incomingKey: (channel: TunerLineupChannel) => string | null | undefined,
	storedKey: (channel: ChannelRecord) => string | null | undefined
): void {
	const incomingByKey = new Map<string, number[]>();
	const existingByKey = new Map<string, ChannelRecord[]>();

	for (let index = 0; index < lineup.length; index += 1) {
		if (matches.has(index)) continue;
		const key = incomingKey(lineup[index]!);
		if (!key) continue;
		const indexes = incomingByKey.get(key) ?? [];
		indexes.push(index);
		incomingByKey.set(key, indexes);
	}
	for (const stored of existing) {
		if (usedExistingIds.has(stored.id)) continue;
		const key = storedKey(stored);
		if (!key) continue;
		const rows = existingByKey.get(key) ?? [];
		rows.push(stored);
		existingByKey.set(key, rows);
	}

	for (const [key, indexes] of incomingByKey) {
		const rows = existingByKey.get(key);
		if (indexes.length !== 1 || rows?.length !== 1) continue;
		matches.set(indexes[0]!, rows[0]!);
		usedExistingIds.add(rows[0]!.id);
	}
}

/** Keep persisted/user-facing sync diagnostics free of URLs and credentials. */
function sanitizeLineupError(error: unknown): string {
	const message = error instanceof Error ? error.message : "Lineup sync failed";
	return message
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<redacted URL>")
		.replace(
			/\b(token|key|secret|password|passphrase|auth|deviceauth)\s*[=:]\s*[^\s,;]+/gi,
			"$1=<redacted>"
		)
		.slice(0, 1000);
}
