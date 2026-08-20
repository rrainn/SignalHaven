import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import {
	recordingConflictListSchema,
	SERIES_RULE_EVENT,
	type Recording,
	type RecordingConflict,
	type EpisodePolicy
} from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import type { ChannelEpgMapRepository } from "../repositories/channel-epg-map.repository";
import type { ChannelsRepository } from "../repositories/channels.repository";
import type {
	EpgProgramRecord,
	EpgProgramsRepository
} from "../repositories/epg-programs.repository";
import type {
	RecordingRecord,
	RecordingsRepository
} from "../repositories/recordings.repository";
import type {
	SeriesRuleRecord,
	SeriesRulesRepository
} from "../repositories/series-rules.repository";
import type { SeriesEpisodeClaims } from "../repositories/series-episode-claims.repository";
import { recordingPlaybackCachePath } from "../recordings/recording-playback-session";
import { RECORDING_EVENT } from "../recordings/recordings.service";

/**
 * Tuner capacity lookup. Returns `null` if the provider isn't known so
 * the conflict resolver can degrade gracefully (treat unknown capacity
 * as unlimited).
 */
export type SeriesTunerCapacityResolver = (
	providerId: string
) => Promise<number | null>;

/**
 * Channel → tuner-provider mapping for the conflict resolver. Defaults
 * to a direct DB lookup of `channels.tuner_id` when not supplied.
 */
export type ChannelProviderResolver = (
	channelId: string
) => Promise<string | null>;

/** Structured decision log used to explain why each candidate was handled. */
export interface SeriesRulesLogger {
	debug(context: Record<string, unknown>, message: string): void;
	warn(context: Record<string, unknown>, message: string): void;
}

const noopLogger: SeriesRulesLogger = {
	debug: () => {},
	warn: () => {}
};

export interface SeriesRulesServiceOptions {
	rules: SeriesRulesRepository;
	recordings: RecordingsRepository;
	epgPrograms: EpgProgramsRepository;
	channels: ChannelsRepository;
	channelEpgMap: Pick<
		ChannelEpgMapRepository,
		"getByChannelId" | "getByEpgChannelId"
	>;
	episodeClaims: SeriesEpisodeClaims;
	/**
	 * Hook that schedules a recording. In production this is the
	 * existing {@link RecordingsService.schedule} method; tests inject a
	 * stub so this service stays decoupled from ffmpeg / the scheduler.
	 */
	schedule: (input: {
		userId?: string;
		channelId: string;
		title: string;
		start: Date;
		end: Date;
		programId: string;
		seriesRuleId: string;
	}) => Promise<RecordingRecord>;
	/**
	 * Hook that deletes a recording row. The default implementation
	 * unlinks the on-disk file (best-effort) and removes the DB row.
	 */
	deleteRecording?: (id: string) => Promise<boolean | void>;
	/** Share deletion ordering with quota and retention maintenance. */
	runLibraryMaintenance?: <T>(operation: () => Promise<T>) => Promise<T>;
	capacity?: SeriesTunerCapacityResolver;
	channelProvider?: ChannelProviderResolver;
	bus?: EventBus | undefined;
	now?: () => Date;
	/** Maximum number of conflicts to retain in the in-memory ring. */
	conflictLimit?: number;
	idFactory?: () => string;
	logger?: SeriesRulesLogger;
}

/**
 * Result of a single evaluation pass.
 */
export interface SeriesRuleEvaluationResult {
	scheduled: number;
	skippedDuplicate: number;
	skippedNotNew: number;
	skippedUnknown: number;
	conflicts: RecordingConflict[];
}

interface CandidateProgram {
	rule: SeriesRuleRecord;
	program: EpgProgramRecord;
	channelId: string;
	providerId: string | null;
}

interface ResolvedScheduling {
	granted: CandidateProgram[];
	conflicts: RecordingConflict[];
}

const DEFAULT_CONFLICT_LIMIT = 100;

/**
 * Implements the rrainn/SignalHaven#R3-series acceptance criteria:
 *
 *   * `evaluate()` walks every series rule, finds matching upcoming
 *     EPG programs, applies the (series-id, season, episode) dedupe +
 *     provider-backed episode-policy filters, and hands the survivors to the conflict
 *     resolver before scheduling.
 *   * Conflict resolver: groups candidates by tuner-provider, and at
 *     each overlap window beyond capacity drops the lowest-priority
 *     candidate. Drops are surfaced via the WS `recordings` topic
 *     (`recording.conflict`) and the `getConflicts()` API.
 *   * `enforceKeepCount(ruleId)` deletes the oldest extra completed
 *     recordings produced by a rule, leaving `manuallyProtected` rows
 *     alone. Triggered automatically when a recording transitions to
 *     `completed` (via the bus subscription wired in `attachBus()`).
 */
export class SeriesRulesService {
	private readonly options: SeriesRulesServiceOptions;
	private readonly conflicts: RecordingConflict[] = [];
	private readonly conflictOwners = new Map<string, string>();
	private readonly now: () => Date;
	private readonly conflictLimit: number;
	private readonly idFactory: () => string;
	private readonly logger: SeriesRulesLogger;
	private busUnsubscribe: (() => void) | undefined;
	/** Serialise `evaluate()` calls; concurrent evaluations would race. */
	private evaluationQueue: Promise<unknown> = Promise.resolve();
	/** Standalone services still serialize keep-count work when no shared queue exists. */
	private maintenanceQueue: Promise<unknown> = Promise.resolve();

	constructor(options: SeriesRulesServiceOptions) {
		this.options = options;
		this.now = options.now ?? (() => new Date());
		this.conflictLimit = Math.max(
			1,
			options.conflictLimit ?? DEFAULT_CONFLICT_LIMIT
		);
		this.idFactory = options.idFactory ?? (() => randomUUID());
		this.logger = options.logger ?? noopLogger;
	}

	// ---------- CRUD passthrough ----------

	async list(userId?: string): Promise<SeriesRuleRecord[]> {
		return userId
			? this.options.rules.listForUser(userId)
			: this.options.rules.list();
	}

	async getById(id: string, userId?: string): Promise<SeriesRuleRecord | null> {
		return userId
			? this.options.rules.getByIdForUser(id, userId)
			: this.options.rules.getById(id);
	}

	async create(input: {
		userId?: string;
		title: string;
		channelId?: string | null;
		epgChannelId?: string | null;
		keepCount: number;
		episodePolicy?: EpisodePolicy;
		newOnly?: boolean;
		priority: number;
		retentionDays?: number | null;
	}): Promise<SeriesRuleRecord> {
		const created = await this.options.rules.create(input);
		// Evaluate before returning so matching programs appear in Upcoming
		// immediately instead of waiting for the recurring background job.
		await this.evaluate();
		return created;
	}

	async update(
		id: string,
		patch: {
			title?: string;
			channelId?: string | null;
			epgChannelId?: string | null;
			keepCount?: number;
			episodePolicy?: EpisodePolicy;
			newOnly?: boolean;
			priority?: number;
			retentionDays?: number | null;
		},
		userId?: string
	): Promise<SeriesRuleRecord | null> {
		const updated = userId
			? await this.options.rules.updateForUser(id, userId, patch)
			: await this.options.rules.update(id, patch);
		if (!updated) return null;
		// Rule changes can make additional EPG programs eligible immediately.
		await this.evaluate();
		return updated;
	}

	async delete(id: string, userId?: string): Promise<boolean> {
		return userId
			? this.options.rules.deleteForUser(id, userId)
			: this.options.rules.delete(id);
	}

	// ---------- public API ----------

	/** Snapshot of recent conflicts surfaced by the evaluator. */
	getConflicts(userId?: string): RecordingConflict[] {
		return recordingConflictListSchema.parse({
			items: userId
				? this.conflicts.filter(
						(conflict) => this.conflictOwners.get(conflict.id) === userId
					)
				: [...this.conflicts]
		}).items;
	}

	/**
	 * Subscribe to the `recordings` topic so `recording.completed`
	 * automatically triggers `keepCount` enforcement for the originating
	 * rule. Idempotent. Detach via the returned function.
	 */
	attachBus(): () => void {
		if (!this.options.bus) {
			return () => undefined;
		}
		if (this.busUnsubscribe) {
			return this.busUnsubscribe;
		}
		const detach = this.options.bus.subscribe("recordings", (event) => {
			const recording = event.data as Recording | undefined;
			if (!recording) return;
			if (event.event === RECORDING_EVENT.completed) {
				void this.options.episodeClaims
					.markCompleted(recording.id)
					.catch(() => {
						/* A later lifecycle event or evaluator pass can reconcile history. */
					});
				if (!recording.seriesRuleId) return;
				void this.enforceKeepCount(recording.seriesRuleId).catch(() => {
					/* swallowed; surfaced via subsequent enforcement attempts */
				});
				return;
			}
			if (
				event.event === RECORDING_EVENT.failed ||
				event.event === RECORDING_EVENT.cancelled
			) {
				void this.options.episodeClaims
					.releaseByRecordingId(recording.id)
					.catch(() => {
						/* Failed/cancelled rows remain retryable on the next reconciliation. */
					});
			}
		});
		this.busUnsubscribe = detach;
		return () => {
			if (this.busUnsubscribe === detach) {
				this.busUnsubscribe = undefined;
			}
			detach();
		};
	}

	/**
	 * Walk every rule and schedule recordings for matching upcoming EPG
	 * programs. Calls are serialised so two ticks (e.g. EPG refresh +
	 * recurring job firing simultaneously) don't double-schedule.
	 */
	evaluate(): Promise<SeriesRuleEvaluationResult> {
		const next = this.evaluationQueue.then(() => this.evaluateOnce());
		this.evaluationQueue = next.catch(() => undefined);
		return next;
	}

	/**
	 * Delete completed recordings beyond the rule's `keepCount`. The
	 * oldest rows are evicted first; rows flagged `manuallyProtected`
	 * are skipped (and don't count against the cap, matching standard
	 * DVR semantics: "kept" episodes are the user's responsibility).
	 */
	async enforceKeepCount(ruleId: string): Promise<{ deleted: number }> {
		if (this.options.runLibraryMaintenance) {
			return this.options.runLibraryMaintenance(() =>
				this.enforceKeepCountUnlocked(ruleId)
			);
		}
		const run = this.maintenanceQueue.then(() =>
			this.enforceKeepCountUnlocked(ruleId)
		);
		this.maintenanceQueue = run.catch(() => undefined);
		return run;
	}

	/** Keep-count implementation invoked inside the shared deletion queue. */
	private async enforceKeepCountUnlocked(
		ruleId: string
	): Promise<{ deleted: number }> {
		const rule = await this.options.rules.getById(ruleId);
		if (!rule) {
			return { deleted: 0 };
		}
		const completed =
			await this.options.recordings.listCompletedBySeriesRule(ruleId);
		const evictable = completed.filter((row) => !row.manuallyProtected);
		if (evictable.length <= rule.keepCount) {
			return { deleted: 0 };
		}
		const evictCount = evictable.length - rule.keepCount;
		let deleted = 0;
		for (let i = 0; i < evictCount; i++) {
			const victim = evictable[i];
			if (!victim) break;
			if (!(await this.deleteRecording(victim))) continue;
			this.publishEvicted(victim, rule);
			deleted += 1;
		}
		return { deleted };
	}

	// ---------- internals ----------

	private async evaluateOnce(): Promise<SeriesRuleEvaluationResult> {
		const result: SeriesRuleEvaluationResult = {
			scheduled: 0,
			skippedDuplicate: 0,
			skippedNotNew: 0,
			skippedUnknown: 0,
			conflicts: []
		};
		const rules = await this.options.rules.list();
		if (rules.length === 0) {
			this.publishEvaluated(result);
			return result;
		}

		const now = this.now();
		const candidates: CandidateProgram[] = [];

		for (const rule of rules) {
			const epgChannelId = await this.resolveRuleEpgChannelId(rule);
			const programs = await this.options.epgPrograms.findUpcomingByTitle({
				title: rule.title,
				...(epgChannelId ? { epgChannelId } : {}),
				after: now
			});
			for (const program of programs) {
				// Only consider exact title matches (case-insensitive). The
				// ilike at the repository layer is a literal compare; this
				// double-check defends against future fuzzy backends.
				if (program.title.toLowerCase() !== rule.title.toLowerCase()) {
					continue;
				}

				const channelId = await this.resolveTunerChannel(rule, program);
				if (!channelId) {
					// No tuner channel mapped — drop, but don't even try to
					// schedule. We don't surface this as a conflict (it's a
					// configuration issue, not a scheduling one).
					this.logDecision(rule, program, "skipped_no_channel");
					continue;
				}

				// Dedupe by exact program id and by (series, season, episode).
				const existingByProgram =
					await this.options.recordings.findActiveByProgramId(
						program.id,
						rule.userId
					);
				if (existingByProgram) {
					result.skippedDuplicate += 1;
					this.logDecision(rule, program, "skipped_duplicate_program");
					continue;
				}
				const existingByEpisode = program.episodeIdentityKey
					? await this.options.recordings.findExistingForEpisodeIdentity(
							program.episodeIdentityKey,
							rule.userId
						)
					: null;
				if (existingByEpisode) {
					result.skippedDuplicate += 1;
					this.logDecision(rule, program, "skipped_duplicate_episode");
					continue;
				}

				const episodePolicy = rule.episodePolicy;
				if (!allowsBroadcast(episodePolicy, program.broadcastNewness)) {
					if (program.broadcastNewness === "unknown") {
						result.skippedUnknown += 1;
						this.logDecision(rule, program, "skipped_unknown_newness");
					} else {
						result.skippedNotNew += 1;
						this.logDecision(rule, program, "skipped_provider_rerun");
					}
					continue;
				}

				const providerId = await this.resolveProviderId(channelId);
				candidates.push({ rule, program, channelId, providerId });
			}
		}

		const resolved = await this.resolveConflicts(candidates);
		result.conflicts = resolved.conflicts;

		for (const candidate of resolved.granted) {
			const identityKey = candidate.program.episodeIdentityKey;
			let claimed = false;
			try {
				if (identityKey) {
					claimed = await this.options.episodeClaims.claim(
						candidate.rule.id,
						identityKey
					);
					if (!claimed) {
						result.skippedDuplicate += 1;
						this.logDecision(
							candidate.rule,
							candidate.program,
							"skipped_atomic_claim"
						);
						continue;
					}
				}
				const recording = await this.options.schedule({
					...(candidate.rule.userId ? { userId: candidate.rule.userId } : {}),
					channelId: candidate.channelId,
					title: candidate.program.title,
					start: candidate.program.start,
					end: candidate.program.stop,
					programId: candidate.program.id,
					seriesRuleId: candidate.rule.id
				});
				if (identityKey) {
					await this.options.episodeClaims.attachRecording(
						candidate.rule.id,
						identityKey,
						recording.id
					);
				}
				result.scheduled += 1;
				this.logDecision(candidate.rule, candidate.program, "scheduled");
			} catch (error) {
				if (claimed && identityKey) {
					await this.options.episodeClaims
						.release(candidate.rule.id, identityKey)
						.catch(() => undefined);
				}
				this.logger.warn(
					{
						seriesRuleId: candidate.rule.id,
						programId: candidate.program.id,
						episodeIdentityKey: identityKey,
						reason: "schedule_failed",
						error: error instanceof Error ? error.message : String(error)
					},
					"Series recording candidate was not scheduled"
				);
				// A schedule failure (e.g. storage not configured) shouldn't
				// poison the rest of the batch; the user will see the
				// unscheduled program on the next pass.
			}
		}

		for (const conflict of resolved.conflicts) {
			this.recordConflict(conflict);
		}

		this.publishEvaluated(result);
		return result;
	}

	/**
	 * Group candidates by tuner-provider and, at each overlap window
	 * beyond capacity, drop the lowest-priority candidate(s). Returns
	 * the granted candidates plus the dropped-conflict descriptors.
	 *
	 * Algorithm:
	 *   1. Bucket candidates by `providerId`. Candidates whose provider
	 *      is unknown or whose capacity returns null are passed through
	 *      as granted (we can't reason about them).
	 *   2. For each bucket, also factor in already-scheduled recordings
	 *      on the same provider — they consume capacity but cannot be
	 *      evicted by the resolver.
	 *   3. Sweep candidate start boundaries: at each point count active
	 *      intervals; when the count exceeds capacity, evict the
	 *      lowest-priority *new* candidate and record a conflict.
	 */
	private async resolveConflicts(
		candidates: CandidateProgram[]
	): Promise<ResolvedScheduling> {
		if (candidates.length === 0) {
			return { granted: [], conflicts: [] };
		}
		const byProvider = new Map<string, CandidateProgram[]>();
		const granted: CandidateProgram[] = [];
		for (const candidate of candidates) {
			if (!candidate.providerId) {
				granted.push(candidate);
				continue;
			}
			const list = byProvider.get(candidate.providerId);
			if (list) list.push(candidate);
			else byProvider.set(candidate.providerId, [candidate]);
		}

		const conflicts: RecordingConflict[] = [];
		const now = this.now();

		for (const [providerId, candList] of byProvider) {
			const capacity = await this.lookupCapacity(providerId);
			if (capacity === null || capacity <= 0) {
				for (const c of candList) granted.push(c);
				continue;
			}
			const existing = await this.collectExistingSchedules(providerId, now);

			type Interval = {
				start: number;
				end: number;
				priority: number;
				immune: boolean;
				candidate?: CandidateProgram;
				id: string;
			};
			const intervals: Interval[] = [];
			for (const c of candList) {
				intervals.push({
					start: c.program.start.getTime(),
					end: c.program.stop.getTime(),
					priority: c.rule.priority,
					immune: false,
					candidate: c,
					id: `cand:${c.rule.id}:${c.program.id}`
				});
			}
			for (const e of existing) {
				intervals.push({
					start: e.scheduledStart.getTime(),
					end: e.scheduledEnd.getTime(),
					priority: Number.POSITIVE_INFINITY,
					immune: true,
					id: `existing:${e.id}`
				});
			}

			const dropped = new Set<string>();
			const points = new Set<number>();
			for (const i of intervals) points.add(i.start);
			const sortedPoints = [...points].sort((a, b) => a - b);

			for (const t of sortedPoints) {
				const active = intervals.filter(
					(i) => !dropped.has(i.id) && i.start <= t && i.end > t
				);
				if (active.length <= capacity) continue;
				// Sort by (immune desc, priority desc, start asc, id asc) so
				// the *first* element is the keeper. Evict from the tail
				// (lowest priority, candidate-only).
				active.sort((a, b) => {
					if (a.immune !== b.immune) return a.immune ? -1 : 1;
					if (a.priority !== b.priority) return b.priority - a.priority;
					if (a.start !== b.start) return a.start - b.start;
					return a.id.localeCompare(b.id);
				});
				let toEvict = active.length - capacity;
				for (let idx = active.length - 1; idx >= 0 && toEvict > 0; idx--) {
					const victim = active[idx];
					if (!victim || victim.immune) continue;
					dropped.add(victim.id);
					toEvict -= 1;
					if (victim.candidate) {
						const conflictId = this.idFactory();
						conflicts.push({
							id: conflictId,
							seriesRuleId: victim.candidate.rule.id,
							programId: victim.candidate.program.id,
							channelId: victim.candidate.channelId,
							title: victim.candidate.program.title,
							scheduledStart: victim.candidate.program.start.toISOString(),
							scheduledEnd: victim.candidate.program.stop.toISOString(),
							reason: "tuner_capacity",
							message:
								"This recording was not scheduled because tuner capacity was already in use at that time.",
							// Peer identifiers can belong to another account, so the public
							// compatibility field intentionally stays empty.
							conflictsWith: [],
							detectedAt: this.now().toISOString()
						});
						this.conflictOwners.set(
							conflictId,
							victim.candidate.rule.userId ??
								"00000000-0000-4000-8000-000000000001"
						);
					}
				}
			}

			for (const c of candList) {
				if (!dropped.has(`cand:${c.rule.id}:${c.program.id}`)) {
					granted.push(c);
				}
			}
		}

		return { granted, conflicts };
	}

	private async collectExistingSchedules(
		providerId: string,
		after: Date
	): Promise<RecordingRecord[]> {
		const rows =
			await this.options.recordings.listScheduledStartingAfter(after);
		const matching: RecordingRecord[] = [];
		for (const row of rows) {
			const rowProvider = await this.resolveProviderId(row.channelId);
			if (rowProvider === providerId) {
				matching.push(row);
			}
		}
		return matching;
	}

	private async lookupCapacity(providerId: string): Promise<number | null> {
		if (!this.options.capacity) return null;
		try {
			return await this.options.capacity(providerId);
		} catch {
			return null;
		}
	}

	private async resolveProviderId(channelId: string): Promise<string | null> {
		if (this.options.channelProvider) {
			try {
				return await this.options.channelProvider(channelId);
			} catch {
				return null;
			}
		}
		if (
			typeof this.options.channels.listSourcesByLogicalChannelId === "function"
		) {
			const sources =
				await this.options.channels.listSourcesByLogicalChannelId(channelId);
			return (
				sources.find(
					(source) => source.enabled && source.sourceStatus !== "unavailable"
				)?.tunerId ?? null
			);
		}
		// Legacy test seams still model one physical row per channel.
		const row = await this.options.channels.getById(channelId);
		return row?.tunerId ?? null;
	}

	private async resolveRuleEpgChannelId(
		rule: SeriesRuleRecord
	): Promise<string | null> {
		if (rule.epgChannelId) return rule.epgChannelId;
		if (rule.channelId) {
			const map = await this.options.channelEpgMap.getByChannelId(
				rule.channelId
			);
			return map?.epgChannelId ?? null;
		}
		return null;
	}

	private async resolveTunerChannel(
		rule: SeriesRuleRecord,
		program: EpgProgramRecord
	): Promise<string | null> {
		if (rule.channelId) return rule.channelId;
		const map = await this.options.channelEpgMap.getByEpgChannelId(
			program.epgChannelId
		);
		return map?.channelId ?? null;
	}

	private async deleteRecording(row: RecordingRecord): Promise<boolean> {
		if (this.options.deleteRecording) {
			return (await this.options.deleteRecording(row.id)) !== false;
		}
		const removed = await this.options.recordings.deleteEvictionCandidate(
			row.id
		);
		if (!removed) return false;
		if (removed.filePath) {
			// Best-effort: a missing file shouldn't block DB cleanup.
			await Promise.all([
				rm(removed.filePath, { force: true }).catch(() => undefined),
				rm(recordingPlaybackCachePath(removed.filePath), {
					recursive: true,
					force: true
				}).catch(() => undefined)
			]);
		}
		return true;
	}

	private recordConflict(conflict: RecordingConflict): void {
		this.conflicts.push(conflict);
		while (this.conflicts.length > this.conflictLimit) {
			const removed = this.conflicts.shift();
			if (removed) this.conflictOwners.delete(removed.id);
		}
		this.publish(SERIES_RULE_EVENT.conflict, conflict, {
			userId:
				this.conflictOwners.get(conflict.id) ??
				"00000000-0000-4000-8000-000000000001"
		});
	}

	private publishEvicted(row: RecordingRecord, rule: SeriesRuleRecord): void {
		this.publish(
			SERIES_RULE_EVENT.evicted,
			{
				recordingId: row.id,
				seriesRuleId: rule.id,
				title: row.title,
				keepCount: rule.keepCount
			},
			{
				userId: row.userId ?? "00000000-0000-4000-8000-000000000001"
			}
		);
	}

	private publishEvaluated(result: SeriesRuleEvaluationResult): void {
		this.publish(
			SERIES_RULE_EVENT.evaluated,
			{
				scheduled: result.scheduled,
				skippedDuplicate: result.skippedDuplicate,
				skippedNotNew: result.skippedNotNew,
				skippedUnknown: result.skippedUnknown,
				conflicts: result.conflicts.length
			},
			{ role: "admin" }
		);
	}

	private publish(
		event: string,
		data: unknown,
		audience?: { userId?: string; role?: "admin" | "user" }
	): void {
		if (!this.options.bus) return;
		this.options.bus.publish({
			topic: "recordings",
			event,
			data: data as unknown,
			...(audience ? { audience } : {})
		});
	}

	/** Emit one stable reason per candidate decision for production diagnosis. */
	private logDecision(
		rule: SeriesRuleRecord,
		program: EpgProgramRecord,
		reason: string
	): void {
		this.logger.debug(
			{
				seriesRuleId: rule.id,
				programId: program.id,
				episodeIdentityKey: program.episodeIdentityKey,
				episodePolicy: rule.episodePolicy,
				broadcastNewness: program.broadcastNewness,
				newnessSource: program.newnessSource,
				reason
			},
			"Series recording candidate evaluated"
		);
	}
}

/** Apply explicit unknown handling without consulting transient guide history. */
function allowsBroadcast(
	policy: EpisodePolicy,
	newness: EpgProgramRecord["broadcastNewness"]
): boolean {
	if (policy === "all") return true;
	if (newness === "new" || newness === "premiere") return true;
	return policy === "new_and_unknown" && newness === "unknown";
}
