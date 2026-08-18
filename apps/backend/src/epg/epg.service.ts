import type { Tuner } from "@signalhaven/shared";
import { iptvConfigSchema } from "@signalhaven/shared";
import type { Pool } from "pg";

import type { EventBus } from "../events/event-bus";
import type {
	CreateEpgSourceInput,
	EpgSourceRecord,
	EpgSourcesRepository,
	UpdateEpgSourceInput
} from "../repositories/epg-sources.repository";
import type { Scheduler } from "../scheduler/scheduler";

import type { EpgMatcherService } from "./epg-matcher.service";
import { importXmltv, type ImportResult } from "./xmltv-importer";

export class EpgSourceNotFoundError extends Error {
	constructor(id: string) {
		super(`EPG source ${id} not found`);
		this.name = "EpgSourceNotFoundError";
	}
}

export class UnsupportedEpgKindError extends Error {
	constructor(kind: string) {
		super(`Unsupported EPG source kind "${kind}"`);
		this.name = "UnsupportedEpgKindError";
	}
}

export class EpgRefreshFailedError extends Error {
	readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "EpgRefreshFailedError";
		this.cause = cause;
	}
}

export interface EpgServiceOptions {
	repository: EpgSourcesRepository;
	pool: Pool;
	bus?: EventBus;
	scheduler?: Scheduler;
	/**
	 * Optional matcher; when provided, `refresh()` runs
	 * `autoMatchUnmapped()` after a successful import so newly imported
	 * EPG channels can be picked up by previously unmapped tuner channels.
	 * Manual mappings are always preserved.
	 */
	matcher?: EpgMatcherService;
	/**
	 * Hook for tests / non-HTTP environments to swap in a fixture loader
	 * instead of `fetch`. Receives the resolved URL (or `file://` path)
	 * and must return a readable stream of bytes.
	 */
	openInput?: (url: string) => Promise<NodeJS.ReadableStream>;
	/**
	 * Resolves a managed HDHomeRun source to a fresh cloud guide URL. Production
	 * delegates to the linked tuner provider so DeviceAuth never reaches disk.
	 */
	resolveHdhomerunGuideUrl?: (tunerId: string) => Promise<string>;
	/** Override for tests; defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Optional hook fired after every successful refresh — used in
	 * production to let `RecordingsService` reconcile scheduled
	 * recordings whose linked EPG programs may have shifted. Errors are
	 * swallowed (and surfaced on the bus as `match-failed` style
	 * events) so a reconcile failure never poisons the refresh result.
	 */
	onRefreshComplete?: (sourceId: string) => Promise<void> | void;
	/** Invalidates cached Guide mappings after a source cascade removes them. */
	onMappingsChanged?: () => void;
}

export const EPG_REFRESH_JOB_KIND = "epg.refresh";

/**
 * High-level facade for EPG sources: persistence, manual refresh
 * orchestration, scheduler integration and progress publishing.
 */
export class EpgService {
	private readonly repository: EpgSourcesRepository;
	private readonly pool: Pool;
	private readonly bus: EventBus | undefined;
	private readonly scheduler: Scheduler | undefined;
	private readonly matcher: EpgMatcherService | undefined;
	private readonly openInput: (url: string) => Promise<NodeJS.ReadableStream>;
	private readonly resolveHdhomerunGuideUrl:
		| ((tunerId: string) => Promise<string>)
		| undefined;
	private readonly now: () => number;
	private readonly onRefreshComplete:
		| ((sourceId: string) => Promise<void> | void)
		| undefined;
	private readonly onMappingsChanged: (() => void) | undefined;
	private oneOffHandlerRegistered = false;

	constructor(options: EpgServiceOptions) {
		this.repository = options.repository;
		this.pool = options.pool;
		this.bus = options.bus;
		this.scheduler = options.scheduler;
		this.matcher = options.matcher;
		this.openInput = options.openInput ?? defaultOpenInput;
		this.resolveHdhomerunGuideUrl = options.resolveHdhomerunGuideUrl;
		this.now = options.now ?? (() => Date.now());
		this.onRefreshComplete = options.onRefreshComplete;
		this.onMappingsChanged = options.onMappingsChanged;
	}

	async list(): Promise<EpgSourceRecord[]> {
		return this.repository.list();
	}

	async getById(id: string): Promise<EpgSourceRecord> {
		const row = await this.repository.getById(id);
		if (!row) {
			throw new EpgSourceNotFoundError(id);
		}
		return row;
	}

	async create(input: CreateEpgSourceInput): Promise<EpgSourceRecord> {
		if (input.kind !== "xmltv" && input.kind !== "hdhomerun_guide") {
			throw new UnsupportedEpgKindError(input.kind);
		}
		if (input.kind === "hdhomerun_guide" && !input.url && !input.tunerId) {
			throw new Error("hdhomerun_guide source requires a tuner or legacy URL");
		}
		const created = await this.repository.create(input);
		if (this.scheduler) {
			this.registerRecurringFor(created);
		}
		if (this.bus) {
			this.bus.publish({
				topic: "epg",
				event: "source.created",
				data: { source: serialize(created) }
			});
		}
		return created;
	}

	/**
	 * Ensures a configured HDHomeRun has exactly one managed guide source.
	 * Network access is deliberately deferred until refresh time so adding an
	 * offline tuner still succeeds and reports its guide error independently.
	 */
	async ensureHdhomerunSource(
		tuner: Pick<Tuner, "id" | "kind" | "name">
	): Promise<EpgSourceRecord | null> {
		if (tuner.kind !== "hdhomerun") {
			return null;
		}
		const source = await this.repository.ensureHdhomerunForTuner({
			tunerId: tuner.id,
			name: `${tuner.name} guide`
		});
		if (this.scheduler) {
			this.registerRecurringFor(source);
		}
		if (this.bus) {
			this.bus.publish({
				topic: "epg",
				event: "source.created",
				data: { source: serialize(source) }
			});
		}
		return source;
	}

	/** Ensures a tuner-owned guide exists for every tuner kind that supplies one. */
	async ensureTunerSource(
		tuner: Pick<Tuner, "id" | "kind" | "name" | "config">
	): Promise<EpgSourceRecord | null> {
		if (tuner.kind === "hdhomerun") {
			return this.ensureHdhomerunSource(tuner);
		}
		if (tuner.kind !== "iptv") return null;

		const config = iptvConfigSchema.parse(tuner.config);
		if (!config.epgUrl) return null;
		const source = await this.repository.ensureXmltvForTuner({
			tunerId: tuner.id,
			name: `${tuner.name} guide`,
			url: config.epgUrl
		});
		if (this.scheduler) this.registerRecurringFor(source);
		if (this.bus) {
			this.bus.publish({
				topic: "epg",
				event: "source.created",
				data: { source: serialize(source) }
			});
		}
		return source;
	}

	/** Reconciles managed HDHomeRun guides and IPTV XMLTV URLs at startup. */
	async reconcileTunerSources(tuners: Tuner[]): Promise<void> {
		await this.reconcileHdhomerunSources(tuners);
		await Promise.all(
			tuners
				.filter((tuner) => tuner.kind === "iptv")
				.map((tuner) => this.ensureTunerSource(tuner))
		);
	}

	/**
	 * Backfills managed guide sources at startup. A single legacy token-bearing
	 * source is adopted when there is exactly one HDHomeRun tuner; ambiguous
	 * configurations are preserved and receive separate managed sources.
	 */
	async reconcileHdhomerunSources(tuners: Tuner[]): Promise<void> {
		const hdhomerunTuners = tuners.filter(
			(tuner) => tuner.kind === "hdhomerun"
		);
		if (hdhomerunTuners.length === 0) {
			return;
		}

		const sources = await this.repository.list();
		const linkedTunerIds = new Set(
			sources
				.filter((source) => source.kind === "hdhomerun_guide")
				.map((source) => source.tunerId)
				.filter((tunerId): tunerId is string => tunerId !== null)
		);
		const legacySources = sources.filter(
			(source) => source.kind === "hdhomerun_guide" && source.tunerId === null
		);

		if (
			hdhomerunTuners.length === 1 &&
			legacySources.length === 1 &&
			!linkedTunerIds.has(hdhomerunTuners[0]!.id)
		) {
			await this.repository.adoptHdhomerunSource(
				legacySources[0]!.id,
				hdhomerunTuners[0]!.id
			);
			linkedTunerIds.add(hdhomerunTuners[0]!.id);
		}

		await Promise.all(
			hdhomerunTuners
				.filter((tuner) => !linkedTunerIds.has(tuner.id))
				.map((tuner) => this.ensureHdhomerunSource(tuner))
		);
	}

	async update(
		id: string,
		input: UpdateEpgSourceInput
	): Promise<EpgSourceRecord> {
		const existing = await this.getById(id);
		const updated = await this.repository.update(id, input);
		if (!updated) {
			throw new EpgSourceNotFoundError(id);
		}
		void existing;
		if (this.bus) {
			this.bus.publish({
				topic: "epg",
				event: "source.updated",
				data: { source: serialize(updated) }
			});
		}
		return updated;
	}

	async delete(id: string): Promise<void> {
		await this.getById(id);
		const removed = await this.repository.delete(id);
		if (!removed) {
			throw new EpgSourceNotFoundError(id);
		}
		// Source deletion cascades through EPG channels into channel mappings.
		this.onMappingsChanged?.();
		if (this.bus) {
			this.bus.publish({
				topic: "epg",
				event: "source.deleted",
				data: { id }
			});
		}
	}

	/**
	 * Manually trigger a refresh. Loads the source's URL/file, streams it
	 * through the appropriate importer for the source's `kind`, prunes
	 * stale programs and records the outcome on the source row. Publishes
	 * start/progress/completed (or failed) events on the WS bus under the
	 * `epg` topic.
	 */
	async refresh(id: string): Promise<ImportResult> {
		const source = await this.getById(id);
		if (source.kind !== "xmltv" && source.kind !== "hdhomerun_guide") {
			throw new UnsupportedEpgKindError(source.kind);
		}

		this.publishRefresh("started", source.id, {
			sourceId: source.id,
			name: source.name
		});

		try {
			const target = await this.resolveRefreshTarget(source);
			const result =
				source.kind === "hdhomerun_guide"
					? await this.refreshHdhomerunGuide(source, target)
					: await this.refreshXmltv(source, target);
			await this.repository.recordRefresh(
				source.id,
				new Date(this.now()),
				"ok",
				null
			);
			if (this.matcher) {
				try {
					await this.matcher.autoMatchUnmapped();
				} catch (matchError) {
					// Auto-match is best-effort: a failure here must not turn a
					// successful refresh into a failed one. Surface it on the bus
					// for observability and continue.
					this.publishRefresh("match-failed", source.id, {
						sourceId: source.id,
						error:
							matchError instanceof Error
								? matchError.message
								: String(matchError)
					});
				}
			}
			if (this.onRefreshComplete) {
				try {
					await this.onRefreshComplete(source.id);
				} catch (hookError) {
					// Same best-effort contract as the matcher hook above, but
					// surfaced under its own phase so observers can distinguish a
					// post-refresh hook failure (e.g. the recordings reconciler)
					// from an EPG-matching failure.
					this.publishRefresh("hook-failed", source.id, {
						sourceId: source.id,
						error:
							hookError instanceof Error ? hookError.message : String(hookError)
					});
				}
			}
			this.publishRefresh("completed", source.id, {
				sourceId: source.id,
				...result
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.repository.recordRefresh(
				source.id,
				new Date(this.now()),
				"error",
				message
			);
			this.publishRefresh("failed", source.id, {
				sourceId: source.id,
				error: message
			});
			throw new EpgRefreshFailedError(message, error);
		}
	}

	/** Resolves a source target without exposing managed tuner credentials. */
	private async resolveRefreshTarget(source: EpgSourceRecord): Promise<string> {
		if (source.kind === "hdhomerun_guide" && source.tunerId) {
			if (!this.resolveHdhomerunGuideUrl) {
				throw new Error(
					`HDHomeRun guide source ${source.id} has no tuner resolver configured`
				);
			}
			return this.resolveHdhomerunGuideUrl(source.tunerId);
		}
		const target = source.url ?? source.filePath;
		if (!target) {
			throw new Error(
				`EPG source ${source.id} has no URL, file path, or tuner configured`
			);
		}
		return target;
	}

	private async refreshXmltv(
		source: EpgSourceRecord,
		target: string
	): Promise<ImportResult> {
		const input = await this.openInput(target);
		return importXmltv({
			sourceId: source.id,
			pool: this.pool,
			input,
			...(source.timezone ? { defaultTimezone: source.timezone } : {}),
			onProgress: (progress) => {
				this.publishRefresh("progress", source.id, {
					sourceId: source.id,
					...progress
				});
			}
		});
	}

	private async refreshHdhomerunGuide(
		source: EpgSourceRecord,
		target: string
	): Promise<ImportResult> {
		return this.refreshXmltv(source, normalizeHdhomerunGuideUrl(target));
	}

	/**
	 * Register a one-off `epg.refresh` handler with the scheduler and a
	 * recurring trigger per enabled source. Idempotent — safe to call on
	 * boot and after creating new sources.
	 */
	async bootstrapScheduling(): Promise<void> {
		if (!this.scheduler) return;
		if (!this.oneOffHandlerRegistered) {
			this.scheduler.registerOneOffHandler(
				EPG_REFRESH_JOB_KIND,
				async (ctx) => {
					const id = (ctx.payload as { sourceId?: unknown }).sourceId;
					if (typeof id !== "string") {
						throw new Error("epg.refresh job missing sourceId");
					}
					await this.refresh(id);
				}
			);
			this.oneOffHandlerRegistered = true;
		}
		const sources = await this.repository.listEnabled();
		for (const source of sources) {
			this.registerRecurringFor(source);
		}
	}

	private registerRecurringFor(source: EpgSourceRecord): void {
		if (!this.scheduler || !source.enabled) return;
		const intervalMinutes = Math.max(5, source.refreshIntervalMinutes);
		const cadenceMinutes = greatestCommonDivisor(intervalMinutes, 60);
		const cron =
			cadenceMinutes === 60 ? "0 * * * *" : `*/${cadenceMinutes} * * * *`;
		try {
			this.scheduler.registerRecurring({
				name: `epg.refresh:${source.id}`,
				kind: EPG_REFRESH_JOB_KIND,
				cron,
				handler: async () => {
					const current = await this.getById(source.id);
					const lastRefreshMs = current.lastRefreshAt?.getTime();
					const due =
						lastRefreshMs === undefined ||
						this.now() - lastRefreshMs >= intervalMinutes * 60_000;
					if (due) {
						await this.refresh(source.id);
					}
				}
			});
		} catch {
			// Already registered; ignore so bootstrapScheduling stays idempotent.
		}
	}

	private publishRefresh(
		phase:
			| "started"
			| "progress"
			| "completed"
			| "failed"
			| "match-failed"
			| "hook-failed",
		sourceId: string,
		data: Record<string, unknown>
	): void {
		if (!this.bus) return;
		this.bus.publish({
			topic: "epg",
			event: "epg.refresh",
			data: { phase, sourceId, ...data }
		});
		if (phase === "completed") {
			// Guide consumers need only affected bounds; source identity and
			// diagnostics remain in the unscoped administrator event above.
			this.bus.publish({
				topic: "epg",
				event: "epg.refresh",
				data: {
					phase,
					...(typeof data["affectedFrom"] === "string"
						? { affectedFrom: data["affectedFrom"] }
						: {}),
					...(typeof data["affectedTo"] === "string"
						? { affectedTo: data["affectedTo"] }
						: {})
				},
				audience: { role: "user" }
			});
		}
	}
}

/**
 * Upgrades token-bearing URLs saved before managed tuner sources existed.
 * The old JSON endpoint requires per-channel parameters and rejects the
 * all-channel request, while the supported XMLTV endpoint accepts DeviceAuth.
 */
function normalizeHdhomerunGuideUrl(target: string): string {
	const url = new URL(target);
	if (!url.pathname.endsWith("/guide.php")) {
		return target;
	}
	const deviceAuth = url.searchParams.get("DeviceAuth");
	if (!deviceAuth) {
		throw new Error("Legacy HDHomeRun guide URL is missing DeviceAuth");
	}
	const xmltvUrl = new URL("https://api.hdhomerun.com/api/xmltv");
	xmltvUrl.searchParams.set("DeviceAuth", deviceAuth);
	return xmltvUrl.toString();
}

/** Finds a cron cadence that lands exactly on the configured minute interval. */
function greatestCommonDivisor(left: number, right: number): number {
	let a = Math.abs(Math.trunc(left));
	let b = Math.abs(Math.trunc(right));
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return Math.max(1, a);
}

function serialize(row: EpgSourceRecord): Record<string, unknown> {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		// Legacy HDHomeRun rows may still contain DeviceAuth until reconciliation.
		url: row.kind === "hdhomerun_guide" ? null : row.url,
		filePath: row.filePath,
		tunerId: row.tunerId,
		refreshIntervalMinutes: row.refreshIntervalMinutes,
		timezone: row.timezone,
		enabled: row.enabled,
		lastRefreshAt: row.lastRefreshAt ? row.lastRefreshAt.toISOString() : null,
		lastRefreshStatus: row.lastRefreshStatus,
		lastRefreshError: row.lastRefreshError,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}

/** Default loader: HTTP(S) via global fetch, otherwise local file. */
async function defaultOpenInput(
	target: string
): Promise<NodeJS.ReadableStream> {
	if (/^https?:\/\//i.test(target)) {
		const response = await fetch(target);
		if (!response.ok || !response.body) {
			throw new Error(
				`Failed to fetch EPG source: ${response.status} ${response.statusText}`
			);
		}
		// Convert WHATWG ReadableStream to a Node stream.
		const { Readable } = await import("node:stream");
		return Readable.fromWeb(response.body as never);
	}
	const fsModule = await import("node:fs");
	const filePath = target.startsWith("file://")
		? new URL(target).pathname
		: target;
	return fsModule.createReadStream(filePath);
}

export type { ImportProgress, ImportResult } from "./xmltv-importer";
export type { EpgSourceRecord } from "../repositories/epg-sources.repository";
