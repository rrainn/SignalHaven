import { CronExpressionParser } from "cron-parser";

import { EventBus } from "../events/event-bus";
import type { ScheduledJobsRepository } from "../repositories/scheduled-jobs.repository";

/**
 * Logger surface required by the scheduler. We intentionally avoid taking a
 * hard dependency on pino here so tests can pass `console` (or a spy) and the
 * module stays portable.
 */
export interface SchedulerLogger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

/** Minimal slice of the global timer API so tests can swap in fake timers. */
export interface SchedulerClock {
	now(): number;
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: SchedulerClock = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => {
		if (handle !== undefined) {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		}
	}
};

/** Backoff configuration applied between failed attempts of a single job. */
export interface RetryPolicy {
	/** Initial delay, in milliseconds, before the first retry. */
	baseDelayMs: number;
	/** Multiplier applied per attempt: delay = base * factor ^ (attempt - 1). */
	factor: number;
	/** Upper bound for the computed delay. */
	maxDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = {
	baseDelayMs: 1_000,
	factor: 2,
	maxDelayMs: 5 * 60 * 1_000
};

export interface JobContext {
	/** Stable id: the DB row id for one-off jobs, or the recurring job name. */
	id: string;
	kind: string;
	attempt: number;
	/** Maximum attempts configured for this logical run. */
	maxAttempts: number;
	/**
	 * Absolute time of the next retry, or `null` when this is the last attempt.
	 * Handlers with their own cutoff can use this to avoid queuing stale work.
	 */
	nextRetryAt: Date | null;
	payload: Record<string, unknown>;
	/** Aborted when the scheduler is shutting down past its timeout. */
	signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void;

/**
 * Signals that retrying a failed handler cannot succeed. The scheduler keeps
 * the original message for diagnostics but moves the job directly to failed.
 */
export class NonRetryableJobError extends Error {
	readonly originalCause: unknown;

	constructor(message: string, originalCause?: unknown) {
		super(message);
		this.name = "NonRetryableJobError";
		this.originalCause = originalCause;
	}
}

interface RecurringRegistration {
	name: string;
	kind: string;
	cron: string;
	timezone?: string | undefined;
	handler: JobHandler;
	/** Next absolute time (epoch ms) at which the job should fire. */
	nextRunMs: number;
	retry: RetryPolicy;
	maxAttempts: number;
	attemptsForCurrentRun: number;
}

export interface RegisterRecurringInput {
	name: string;
	kind: string;
	cron: string;
	handler: JobHandler;
	timezone?: string;
	retry?: Partial<RetryPolicy>;
	maxAttempts?: number;
}

export interface ScheduleOneOffInput {
	kind: string;
	runAt: Date;
	payload?: Record<string, unknown>;
	maxAttempts?: number;
}

export interface SchedulerOptions {
	bus: EventBus;
	jobsRepository: ScheduledJobsRepository;
	/** Per-kind cap. Falls back to `defaultMaxConcurrency` for unlisted kinds. */
	maxConcurrencyByKind?: Readonly<Record<string, number>>;
	/** Default cap applied to any kind not listed in `maxConcurrencyByKind`. */
	defaultMaxConcurrency?: number;
	/** Default retry policy applied to recurring jobs that don't set their own. */
	retry?: Partial<RetryPolicy>;
	logger?: SchedulerLogger;
	/** Override clock for deterministic unit tests. */
	clock?: SchedulerClock;
	/** Smallest possible timer delay, used to coalesce wakeups. */
	minTimerMs?: number;
	/** Cap how far in the future a single timer may sleep (default 1 minute). */
	maxTimerMs?: number;
}

interface InFlight {
	kind: string;
	promise: Promise<void>;
	abort: AbortController;
}

const noopLogger: SchedulerLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {}
};

function mergeRetry(
	base: RetryPolicy,
	override?: Partial<RetryPolicy>
): RetryPolicy {
	if (!override) {
		return base;
	}
	return {
		baseDelayMs: override.baseDelayMs ?? base.baseDelayMs,
		factor: override.factor ?? base.factor,
		maxDelayMs: override.maxDelayMs ?? base.maxDelayMs
	};
}

function computeBackoff(policy: RetryPolicy, attempt: number): number {
	const raw = policy.baseDelayMs * Math.pow(policy.factor, attempt - 1);
	if (!Number.isFinite(raw) || raw <= 0) {
		return policy.baseDelayMs;
	}
	return Math.min(raw, policy.maxDelayMs);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * In-process scheduler: cron-style recurring jobs plus absolute-time one-off
 * jobs persisted in the DB. Uses a single self-rescheduling timer (compute the
 * next fire time, set one timer) instead of one timer per job.
 */
export class Scheduler {
	private readonly bus: EventBus;
	private readonly repository: ScheduledJobsRepository;
	private readonly maxConcurrencyByKind: Map<string, number>;
	private readonly defaultMaxConcurrency: number;
	private readonly defaultRetry: RetryPolicy;
	private readonly logger: SchedulerLogger;
	private readonly clock: SchedulerClock;
	private readonly minTimerMs: number;
	private readonly maxTimerMs: number;

	private readonly recurring = new Map<string, RecurringRegistration>();
	private readonly inFlight = new Map<string, InFlight>();
	private readonly runningByKind = new Map<string, number>();
	private readonly oneOffHandlers = new Map<string, JobHandler>();

	private running = false;
	private shuttingDown = false;
	private timer: unknown;
	/** Ensures only one tick body executes at a time. */
	private tickInProgress = false;
	private tickRequested = false;

	constructor(options: SchedulerOptions) {
		this.bus = options.bus;
		this.repository = options.jobsRepository;
		this.maxConcurrencyByKind = new Map(
			Object.entries(options.maxConcurrencyByKind ?? {})
		);
		this.defaultMaxConcurrency = options.defaultMaxConcurrency ?? 1;
		this.defaultRetry = mergeRetry(DEFAULT_RETRY, options.retry);
		this.logger = options.logger ?? noopLogger;
		this.clock = options.clock ?? realClock;
		this.minTimerMs = Math.max(1, options.minTimerMs ?? 1);
		this.maxTimerMs = Math.max(this.minTimerMs, options.maxTimerMs ?? 60_000);
	}

	/**
	 * Register a recurring job. Recurring jobs are code-defined and live only in
	 * memory — restarting the process re-registers them.
	 */
	registerRecurring(input: RegisterRecurringInput): void {
		if (this.recurring.has(input.name)) {
			throw new Error(`Recurring job already registered: ${input.name}`);
		}
		const next = this.computeNextCron(input.cron, input.timezone);
		const registration: RecurringRegistration = {
			name: input.name,
			kind: input.kind,
			cron: input.cron,
			timezone: input.timezone,
			handler: input.handler,
			nextRunMs: next,
			retry: mergeRetry(this.defaultRetry, input.retry),
			maxAttempts: Math.max(1, input.maxAttempts ?? 1),
			attemptsForCurrentRun: 0
		};
		this.recurring.set(input.name, registration);
		if (this.running) {
			this.requestTick();
		}
	}

	/**
	 * Register a handler for one-off jobs of the given `kind`. One-off jobs
	 * persisted in the DB (including those recovered after a restart) are
	 * dispatched to this handler.
	 */
	registerOneOffHandler(kind: string, handler: JobHandler): void {
		if (this.oneOffHandlers.has(kind)) {
			throw new Error(`One-off handler already registered for kind: ${kind}`);
		}
		this.oneOffHandlers.set(kind, handler);
	}

	/**
	 * Schedule a one-off job to run at an absolute time. Persisted in the DB so
	 * it survives a process restart.
	 */
	async scheduleOneOff(input: ScheduleOneOffInput): Promise<string> {
		return this.schedulePersistedOneOff(async () => {
			const created = await this.repository.create({
				kind: input.kind,
				runAt: input.runAt,
				payload: input.payload ?? {},
				maxAttempts: input.maxAttempts ?? 1
			});
			return created.id;
		});
	}

	/**
	 * Run an owner-provided transaction that persists a one-off job together
	 * with its domain row, then wake the scheduler after the commit succeeds.
	 */
	async schedulePersistedOneOff<T>(persist: () => Promise<T>): Promise<T> {
		if (this.shuttingDown) {
			throw new Error("Scheduler is shutting down; not accepting new jobs");
		}
		const result = await persist();
		if (this.running) {
			this.requestTick();
		}
		return result;
	}

	/**
	 * Reuse a still-active persisted job during startup, or create a replacement
	 * when the linked job is missing or terminal.
	 */
	async ensureOneOffScheduled(
		input: ScheduleOneOffInput,
		existingJobId?: string | null
	): Promise<string> {
		if (existingJobId) {
			const existing = await this.repository.getById(existingJobId);
			if (
				existing?.kind === input.kind &&
				(existing.status === "pending" || existing.status === "running") &&
				(input.maxAttempts === undefined ||
					existing.maxAttempts === input.maxAttempts)
			) {
				return existing.id;
			}
			if (
				existing &&
				(existing.status === "pending" || existing.status === "running")
			) {
				await this.repository.cancel(existing.id);
			}
		}
		return this.scheduleOneOff(input);
	}

	async cancelOneOff(id: string): Promise<boolean> {
		const cancelled = await this.repository.cancel(id);
		if (cancelled) {
			// Handlers should observe the signal at their next safe boundary.
			this.inFlight.get(id)?.abort.abort();
		}
		return cancelled;
	}

	/** Begin processing. Recovers any `running` rows left by a previous crash. */
	async start(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		this.shuttingDown = false;
		const recovered = await this.repository.recoverStuckRunning();
		if (recovered > 0) {
			this.logger.info(
				`Recovered ${recovered} stuck running job(s) back to pending`
			);
		}
		this.requestTick();
	}

	/**
	 * Stop accepting new jobs, wait for in-flight handlers to finish (up to
	 * `timeoutMs`), then abort any stragglers via their AbortSignal.
	 */
	async shutdown(timeoutMs = 30_000): Promise<void> {
		if (!this.running) {
			return;
		}
		this.shuttingDown = true;
		this.cancelTimer();

		const inFlight = [...this.inFlight.values()];
		if (inFlight.length === 0) {
			this.running = false;
			return;
		}

		const allDone = Promise.allSettled(inFlight.map((entry) => entry.promise));

		let timer: unknown;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = this.clock.setTimeout(() => resolve("timeout"), timeoutMs);
		});

		const result = await Promise.race([
			allDone.then(() => "done" as const),
			timedOut
		]);

		if (result === "timeout") {
			this.logger.warn(
				`Scheduler shutdown timed out after ${timeoutMs}ms; aborting ${this.inFlight.size} in-flight job(s)`
			);
			for (const entry of this.inFlight.values()) {
				entry.abort.abort();
			}
			// Wait for the aborted handlers to actually settle so callers can rely
			// on shutdown() resolving only when nothing is still touching the DB.
			await allDone;
		} else {
			this.clock.clearTimeout(timer);
		}

		this.running = false;
	}

	/** Test/diagnostic helper: number of currently executing handlers. */
	get inFlightCount(): number {
		return this.inFlight.size;
	}

	// -- internals -----------------------------------------------------------

	private computeNextCron(cron: string, timezone?: string): number {
		const baseMs = this.clock.now();
		const parseOptions: { currentDate: Date; tz?: string } = {
			currentDate: new Date(baseMs)
		};
		if (timezone !== undefined) {
			parseOptions.tz = timezone;
		}
		const expr = CronExpressionParser.parse(cron, parseOptions);
		return expr.next().toDate().getTime();
	}

	private requestTick(): void {
		if (!this.running || this.shuttingDown) {
			return;
		}
		this.scheduleTimer(this.minTimerMs);
	}

	private cancelTimer(): void {
		if (this.timer !== undefined) {
			this.clock.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private scheduleTimer(delayMs: number): void {
		this.cancelTimer();
		const clamped = Math.max(
			this.minTimerMs,
			Math.min(delayMs, this.maxTimerMs)
		);
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined;
			void this.runTick();
		}, clamped);
	}

	private async runTick(): Promise<void> {
		if (this.tickInProgress) {
			this.tickRequested = true;
			return;
		}
		if (!this.running || this.shuttingDown) {
			return;
		}
		this.tickInProgress = true;
		try {
			do {
				this.tickRequested = false;
				await this.tickOnce();
			} while (this.tickRequested && this.running && !this.shuttingDown);
		} catch (error) {
			this.logger.error("Scheduler tick failed", error);
		} finally {
			this.tickInProgress = false;
		}

		if (this.running && !this.shuttingDown) {
			const nextMs = await this.computeNextWakeup();
			const delay = Math.max(this.minTimerMs, nextMs - this.clock.now());
			this.scheduleTimer(delay);
		}
	}

	private async tickOnce(): Promise<void> {
		const nowMs = this.clock.now();
		const now = new Date(nowMs);

		// Recurring jobs first: small in-memory list, cheap to iterate.
		for (const reg of this.recurring.values()) {
			if (this.shuttingDown) {
				return;
			}
			if (reg.nextRunMs > nowMs) {
				continue;
			}
			if (!this.canStartKind(reg.kind)) {
				continue;
			}
			this.dispatchRecurring(reg);
		}

		if (this.shuttingDown) {
			return;
		}

		// One-off jobs from the DB.
		const due = await this.repository.listDue(now);
		for (const job of due) {
			if (this.shuttingDown) {
				return;
			}
			if (!this.canStartKind(job.kind)) {
				continue;
			}
			const claimed = await this.repository.claim(
				job.id,
				new Date(this.clock.now())
			);
			if (!claimed) {
				// Another worker (or a previous tick) raced us; skip silently.
				continue;
			}
			this.dispatchOneOff(claimed);
		}
	}

	private async computeNextWakeup(): Promise<number> {
		const nowMs = this.clock.now();
		let earliest = nowMs + this.maxTimerMs;

		for (const reg of this.recurring.values()) {
			if (reg.nextRunMs < earliest) {
				earliest = reg.nextRunMs;
			}
		}

		const dbNext = await this.repository.findNextPendingRunAt();
		if (dbNext) {
			const dbMs = dbNext.getTime();
			if (dbMs < earliest) {
				earliest = dbMs;
			}
		}

		return earliest;
	}

	private canStartKind(kind: string): boolean {
		const limit =
			this.maxConcurrencyByKind.get(kind) ?? this.defaultMaxConcurrency;
		const current = this.runningByKind.get(kind) ?? 0;
		return current < limit;
	}

	private incrementKind(kind: string): void {
		this.runningByKind.set(kind, (this.runningByKind.get(kind) ?? 0) + 1);
	}

	private decrementKind(kind: string): void {
		const current = this.runningByKind.get(kind) ?? 0;
		if (current <= 1) {
			this.runningByKind.delete(kind);
		} else {
			this.runningByKind.set(kind, current - 1);
		}
	}

	private dispatchRecurring(reg: RecurringRegistration): void {
		const attempt = reg.attemptsForCurrentRun + 1;
		reg.attemptsForCurrentRun = attempt;
		const nextRetryAt =
			attempt < reg.maxAttempts
				? new Date(this.clock.now() + computeBackoff(reg.retry, attempt))
				: null;
		const handle = `recurring:${reg.name}:${reg.nextRunMs}:${attempt}`;
		const abort = new AbortController();
		const ctx: JobContext = {
			id: reg.name,
			kind: reg.kind,
			attempt,
			maxAttempts: reg.maxAttempts,
			nextRetryAt,
			payload: {},
			signal: abort.signal
		};

		this.incrementKind(reg.kind);
		this.publish("started", reg.kind, {
			id: reg.name,
			attempt,
			source: "recurring"
		});

		const settled = Promise.resolve()
			.then(() => reg.handler(ctx))
			.then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error })
			);

		const wrapped = settled.then((result) => {
			this.inFlight.delete(handle);
			this.decrementKind(reg.kind);

			if (result.ok) {
				reg.attemptsForCurrentRun = 0;
				reg.nextRunMs = this.computeNextCron(reg.cron, reg.timezone);
				this.publish("completed", reg.kind, {
					id: reg.name,
					attempt,
					source: "recurring"
				});
			} else {
				const message = errorMessage(result.error);
				this.logger.error(
					`Recurring job ${reg.name} failed on attempt ${attempt}: ${message}`
				);
				if (attempt < reg.maxAttempts) {
					reg.nextRunMs =
						nextRetryAt?.getTime() ??
						this.clock.now() + computeBackoff(reg.retry, attempt);
					this.publish("failed", reg.kind, {
						id: reg.name,
						attempt,
						error: message,
						willRetry: true,
						source: "recurring"
					});
				} else {
					reg.attemptsForCurrentRun = 0;
					reg.nextRunMs = this.computeNextCron(reg.cron, reg.timezone);
					this.publish("failed", reg.kind, {
						id: reg.name,
						attempt,
						error: message,
						willRetry: false,
						source: "recurring"
					});
				}
			}

			this.requestTick();
		});

		this.inFlight.set(handle, {
			kind: reg.kind,
			promise: wrapped,
			abort
		});
	}

	private dispatchOneOff(job: {
		id: string;
		kind: string;
		payload: Record<string, unknown>;
		attempts: number;
		maxAttempts: number;
	}): void {
		const attempt = job.attempts + 1;
		const nextRetryAt =
			attempt < job.maxAttempts
				? new Date(
						this.clock.now() + computeBackoff(this.defaultRetry, attempt)
					)
				: null;
		const abort = new AbortController();
		const ctx: JobContext = {
			id: job.id,
			kind: job.kind,
			attempt,
			maxAttempts: job.maxAttempts,
			nextRetryAt,
			payload: job.payload,
			signal: abort.signal
		};

		const handler = this.oneOffHandlers.get(job.kind);

		this.incrementKind(job.kind);
		this.publish("started", job.kind, {
			id: job.id,
			attempt,
			source: "one-off"
		});

		const settled = Promise.resolve().then(() => {
			if (!handler) {
				throw new Error(
					`No handler registered for one-off job kind: ${job.kind}`
				);
			}
			return handler(ctx);
		});

		const promise = settled
			.then(async () => {
				const completed = await this.repository.markCompleted(job.id);
				if (completed) {
					this.publish("completed", job.kind, {
						id: job.id,
						attempt,
						source: "one-off"
					});
				}
			})
			.catch(async (error: unknown) => {
				const message = errorMessage(error);
				this.logger.error(
					`One-off job ${job.id} (${job.kind}) failed on attempt ${attempt}: ${message}`
				);
				if (!(error instanceof NonRetryableJobError) && nextRetryAt !== null) {
					const rescheduled = await this.repository.reschedule(
						job.id,
						nextRetryAt,
						message,
						attempt
					);
					if (rescheduled) {
						this.publish("failed", job.kind, {
							id: job.id,
							attempt,
							error: message,
							willRetry: true,
							source: "one-off"
						});
					}
				} else {
					const failed = await this.repository.markFailed(
						job.id,
						message,
						attempt
					);
					if (failed) {
						this.publish("failed", job.kind, {
							id: job.id,
							attempt,
							error: message,
							willRetry: false,
							source: "one-off"
						});
					}
				}
			})
			.finally(() => {
				this.inFlight.delete(job.id);
				this.decrementKind(job.kind);
				this.requestTick();
			});

		this.inFlight.set(job.id, {
			kind: job.kind,
			promise,
			abort
		});
	}

	private publish(
		event: "started" | "completed" | "failed",
		kind: string,
		data: Record<string, unknown>
	): void {
		this.bus.publish({
			topic: "jobs",
			event: `job.${event}`,
			data: { ...data, kind }
		});
	}
}
