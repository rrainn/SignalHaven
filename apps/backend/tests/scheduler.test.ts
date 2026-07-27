import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { EventBus, type PublishedEvent } from "../src/events/event-bus";
import {
	type ScheduledJobRecord,
	type ScheduledJobsRepository
} from "../src/repositories/scheduled-jobs.repository";
import { Scheduler, type SchedulerClock } from "../src/scheduler/scheduler";

/**
 * Deterministic fake clock. Pending timers are stored in an array and fire
 * when `advance()` walks past their scheduled time. Multiple timers due at
 * the same instant fire in insertion order.
 */
class FakeClock implements SchedulerClock {
	private current: number;
	private nextHandle = 1;
	private readonly timers = new Map<
		number,
		{ fireAt: number; handler: () => void }
	>();

	constructor(start = 0) {
		this.current = start;
	}

	now(): number {
		return this.current;
	}

	setTimeout(handler: () => void, ms: number): unknown {
		const handle = this.nextHandle++;
		this.timers.set(handle, { fireAt: this.current + ms, handler });
		return handle;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") {
			this.timers.delete(handle);
		}
	}

	/**
	 * Advance simulated time by `ms`. Between firings we yield to the
	 * microtask queue so awaited Promises in handlers can resolve and request
	 * follow-up ticks before more timers fire.
	 */
	async advance(ms: number): Promise<void> {
		const target = this.current + ms;
		while (this.timers.size > 0 || this.current < target) {
			let nextHandle: number | undefined;
			let nextFireAt = Number.POSITIVE_INFINITY;
			for (const [handle, timer] of this.timers) {
				if (timer.fireAt <= target && timer.fireAt < nextFireAt) {
					nextFireAt = timer.fireAt;
					nextHandle = handle;
				}
			}
			if (nextHandle === undefined) {
				this.current = target;
				await flushMicrotasks();
				return;
			}
			const timer = this.timers.get(nextHandle);
			if (!timer) {
				continue;
			}
			this.timers.delete(nextHandle);
			this.current = timer.fireAt;
			timer.handler();
			await flushMicrotasks();
		}
	}
}

function flushMicrotasks(): Promise<void> {
	// A handful of awaits is enough to drain the typical chain of `then` calls
	// the scheduler builds while dispatching a job.
	return new Promise((resolve) => {
		let pending = 10;
		const drain = (): void => {
			if (pending-- <= 0) {
				resolve();
			} else {
				Promise.resolve().then(drain);
			}
		};
		drain();
	});
}

/** In-memory ScheduledJobsRepository stand-in. */
class FakeJobsRepo {
	readonly rows = new Map<string, ScheduledJobRecord>();

	async create(input: {
		kind: string;
		runAt: Date;
		payload?: Record<string, unknown>;
		maxAttempts?: number;
	}): Promise<ScheduledJobRecord> {
		const now = new Date();
		const row: ScheduledJobRecord = {
			id: randomUUID(),
			kind: input.kind,
			payload: input.payload ?? {},
			runAt: input.runAt,
			status: "pending",
			attempts: 0,
			maxAttempts: input.maxAttempts ?? 1,
			lastError: null,
			lockedAt: null,
			createdAt: now,
			updatedAt: now
		};
		this.rows.set(row.id, row);
		return row;
	}

	async getById(id: string): Promise<ScheduledJobRecord | null> {
		return this.rows.get(id) ?? null;
	}

	async listDue(now: Date): Promise<ScheduledJobRecord[]> {
		return [...this.rows.values()]
			.filter(
				(r) => r.status === "pending" && r.runAt.getTime() <= now.getTime()
			)
			.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
	}

	async findNextPendingRunAt(): Promise<Date | null> {
		let earliest: Date | null = null;
		for (const r of this.rows.values()) {
			if (r.status !== "pending") {
				continue;
			}
			if (!earliest || r.runAt.getTime() < earliest.getTime()) {
				earliest = r.runAt;
			}
		}
		return earliest;
	}

	async claim(id: string, now: Date): Promise<ScheduledJobRecord | null> {
		const row = this.rows.get(id);
		if (!row || row.status !== "pending") {
			return null;
		}
		row.status = "running";
		row.lockedAt = now;
		row.updatedAt = now;
		return { ...row };
	}

	async markCompleted(id: string): Promise<boolean> {
		const row = this.rows.get(id);
		if (!row || row.status !== "running") {
			return false;
		}
		row.status = "completed";
		row.lockedAt = null;
		row.updatedAt = new Date();
		return true;
	}

	async markFailed(
		id: string,
		error: string,
		attempts: number
	): Promise<boolean> {
		const row = this.rows.get(id);
		if (!row || row.status !== "running") {
			return false;
		}
		row.status = "failed";
		row.lastError = error;
		row.attempts = attempts;
		row.lockedAt = null;
		row.updatedAt = new Date();
		return true;
	}

	async reschedule(
		id: string,
		runAt: Date,
		error: string,
		attempts: number
	): Promise<boolean> {
		const row = this.rows.get(id);
		if (!row || row.status !== "running") {
			return false;
		}
		row.status = "pending";
		row.runAt = runAt;
		row.lastError = error;
		row.attempts = attempts;
		row.lockedAt = null;
		row.updatedAt = new Date();
		return true;
	}

	async cancel(id: string): Promise<boolean> {
		const row = this.rows.get(id);
		if (!row || (row.status !== "pending" && row.status !== "running")) {
			return false;
		}
		row.status = "cancelled";
		row.updatedAt = new Date();
		return true;
	}

	async recoverStuckRunning(): Promise<number> {
		let count = 0;
		for (const row of this.rows.values()) {
			if (row.status === "running") {
				row.status = "pending";
				row.lockedAt = null;
				row.updatedAt = new Date();
				count += 1;
			}
		}
		return count;
	}
}

interface Harness {
	scheduler: Scheduler;
	bus: EventBus;
	repo: FakeJobsRepo;
	clock: FakeClock;
	events: PublishedEvent[];
}

function makeHarness(
	options: {
		maxConcurrencyByKind?: Record<string, number>;
		defaultMaxConcurrency?: number;
		retry?: { baseDelayMs?: number; factor?: number; maxDelayMs?: number };
	} = {}
): Harness {
	const bus = new EventBus();
	const repo = new FakeJobsRepo();
	const clock = new FakeClock(1_700_000_000_000);
	const events: PublishedEvent[] = [];
	bus.subscribe("jobs", (e) => {
		events.push(e);
	});
	const opts: ConstructorParameters<typeof Scheduler>[0] = {
		bus,
		jobsRepository: repo as unknown as ScheduledJobsRepository,
		clock,
		minTimerMs: 1,
		maxTimerMs: 60_000
	};
	if (options.maxConcurrencyByKind) {
		opts.maxConcurrencyByKind = options.maxConcurrencyByKind;
	}
	if (options.defaultMaxConcurrency !== undefined) {
		opts.defaultMaxConcurrency = options.defaultMaxConcurrency;
	}
	if (options.retry) {
		opts.retry = options.retry;
	}
	const scheduler = new Scheduler(opts);
	return { scheduler, bus, repo, clock, events };
}

test("recurring job fires according to cron and emits started+completed", async () => {
	const h = makeHarness();
	let runs = 0;
	h.scheduler.registerRecurring({
		name: "epg-refresh",
		kind: "epg-refresh",
		// every minute
		cron: "* * * * *",
		handler: () => {
			runs += 1;
		}
	});
	await h.scheduler.start();

	// Advance ~3 minutes; should have fired three times.
	await h.clock.advance(3 * 60_000);

	assert.equal(runs, 3, "expected 3 runs in 3 minutes");
	const started = h.events.filter((e) => e.event === "job.started").length;
	const completed = h.events.filter((e) => e.event === "job.completed").length;
	assert.equal(started, 3);
	assert.equal(completed, 3);

	await h.scheduler.shutdown(1000);
});

test("one-off job persists, runs at runAt and is marked completed", async () => {
	const h = makeHarness();
	let observed: { id: string; payload: Record<string, unknown> } | null = null;
	h.scheduler.registerOneOffHandler("recording.start", (ctx) => {
		observed = { id: ctx.id, payload: ctx.payload };
	});
	await h.scheduler.start();

	const runAt = new Date(h.clock.now() + 5_000);
	const id = await h.scheduler.scheduleOneOff({
		kind: "recording.start",
		runAt,
		payload: { recordingId: "rec-42" }
	});

	// Before runAt — nothing happens.
	await h.clock.advance(2_000);
	assert.equal(observed, null);
	assert.equal((await h.repo.getById(id))?.status, "pending");

	// Cross runAt.
	await h.clock.advance(4_000);
	assert.ok(observed, "handler should have run");
	const obs = observed as unknown as {
		id: string;
		payload: Record<string, unknown>;
	};
	assert.equal(obs.id, id);
	assert.deepEqual(obs.payload, { recordingId: "rec-42" });
	assert.equal((await h.repo.getById(id))?.status, "completed");

	await h.scheduler.shutdown(1000);
});

test("cancelled one-off jobs are not executed", async () => {
	const h = makeHarness();
	let ran = false;
	h.scheduler.registerOneOffHandler("cleanup", () => {
		ran = true;
	});
	await h.scheduler.start();

	const id = await h.scheduler.scheduleOneOff({
		kind: "cleanup",
		runAt: new Date(h.clock.now() + 1_000)
	});

	const cancelled = await h.scheduler.cancelOneOff(id);
	assert.equal(cancelled, true);

	await h.clock.advance(5_000);
	assert.equal(ran, false);
	assert.equal((await h.repo.getById(id))?.status, "cancelled");

	await h.scheduler.shutdown(1000);
});

test("cancelling a running one-off prevents a queued retry", async () => {
	const h = makeHarness({
		retry: { baseDelayMs: 100, factor: 1, maxDelayMs: 100 }
	});
	let rejectAttempt: ((error: Error) => void) | undefined;
	let attempts = 0;
	h.scheduler.registerOneOffHandler("cancel-race", () => {
		attempts += 1;
		return new Promise<void>((_resolve, reject) => {
			rejectAttempt = reject;
		});
	});
	await h.scheduler.start();

	const id = await h.scheduler.scheduleOneOff({
		kind: "cancel-race",
		runAt: new Date(h.clock.now()),
		maxAttempts: 3
	});
	await h.clock.advance(10);
	assert.equal((await h.repo.getById(id))?.status, "running");

	assert.equal(await h.scheduler.cancelOneOff(id), true);
	rejectAttempt?.(new Error("transient failure after cancellation"));
	await flushMicrotasks();
	await h.clock.advance(1_000);

	assert.equal(attempts, 1);
	assert.equal((await h.repo.getById(id))?.status, "cancelled");
	assert.equal(
		h.events.some(
			(event) => event.event === "job.completed" || event.event === "job.failed"
		),
		false
	);

	await h.scheduler.shutdown(1000);
});

test("one-off job retries with exponential backoff then succeeds", async () => {
	const h = makeHarness({
		retry: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 30_000 }
	});
	let attempts = 0;
	h.scheduler.registerOneOffHandler("flaky", () => {
		attempts += 1;
		if (attempts < 3) {
			throw new Error(`boom ${attempts}`);
		}
	});
	await h.scheduler.start();

	const id = await h.scheduler.scheduleOneOff({
		kind: "flaky",
		runAt: new Date(h.clock.now()),
		maxAttempts: 5
	});

	// Attempt 1 (immediate).
	await h.clock.advance(10);
	assert.equal(attempts, 1);
	assert.equal((await h.repo.getById(id))?.status, "pending");

	// Backoff for attempt 2 = 1s.
	await h.clock.advance(1_000);
	assert.equal(attempts, 2);

	// Backoff for attempt 3 = 2s.
	await h.clock.advance(2_000);
	assert.equal(attempts, 3);
	assert.equal((await h.repo.getById(id))?.status, "completed");

	const failed = h.events.filter((e) => e.event === "job.failed");
	assert.equal(failed.length, 2, "two retryable failures should be emitted");
	for (const evt of failed) {
		assert.equal(
			(evt.data as { willRetry: boolean }).willRetry,
			true,
			"first two failures should be marked willRetry"
		);
	}
	const completed = h.events.filter((e) => e.event === "job.completed");
	assert.equal(completed.length, 1);

	await h.scheduler.shutdown(1000);
});

test("one-off job marked failed after maxAttempts exhausted", async () => {
	const h = makeHarness({
		retry: { baseDelayMs: 100, factor: 1, maxDelayMs: 100 }
	});
	let attempts = 0;
	h.scheduler.registerOneOffHandler("always-fails", () => {
		attempts += 1;
		throw new Error("nope");
	});
	await h.scheduler.start();

	const id = await h.scheduler.scheduleOneOff({
		kind: "always-fails",
		runAt: new Date(h.clock.now()),
		maxAttempts: 3
	});

	await h.clock.advance(1_000);

	assert.equal(attempts, 3);
	const row = await h.repo.getById(id);
	assert.equal(row?.status, "failed");
	assert.equal(row?.attempts, 3);
	assert.equal(row?.lastError, "nope");

	const failedEvents = h.events.filter((e) => e.event === "job.failed");
	assert.equal(failedEvents.length, 3);
	assert.equal(
		(failedEvents[failedEvents.length - 1]!.data as { willRetry: boolean })
			.willRetry,
		false
	);

	await h.scheduler.shutdown(1000);
});

test("per-kind concurrency cap prevents oversubscription", async () => {
	const h = makeHarness({ maxConcurrencyByKind: { heavy: 2 } });
	let active = 0;
	let peak = 0;
	const completers: Array<() => void> = [];
	h.scheduler.registerOneOffHandler("heavy", () => {
		active += 1;
		peak = Math.max(peak, active);
		return new Promise<void>((resolve) => {
			completers.push(() => {
				active -= 1;
				resolve();
			});
		});
	});
	await h.scheduler.start();

	for (let i = 0; i < 5; i++) {
		await h.scheduler.scheduleOneOff({
			kind: "heavy",
			runAt: new Date(h.clock.now())
		});
	}

	// Tick: only 2 should start.
	await h.clock.advance(10);
	assert.equal(active, 2, "concurrency cap of 2 should be respected");
	assert.equal(peak, 2);

	// Complete one, expect another to start.
	completers.shift()!();
	await flushMicrotasks();
	await h.clock.advance(10);
	assert.equal(active, 2);

	// Drain everything.
	while (completers.length > 0) {
		completers.shift()!();
		await flushMicrotasks();
		await h.clock.advance(10);
	}

	assert.equal(peak, 2, "peak concurrency must never exceed cap");

	await h.scheduler.shutdown(1000);
});

test("graceful shutdown waits for in-flight jobs to complete", async () => {
	const h = makeHarness();
	let resolveJob: (() => void) | null = null;
	let completed = false;
	h.scheduler.registerOneOffHandler("slow", () => {
		return new Promise<void>((resolve) => {
			resolveJob = () => {
				completed = true;
				resolve();
			};
		});
	});
	await h.scheduler.start();
	await h.scheduler.scheduleOneOff({
		kind: "slow",
		runAt: new Date(h.clock.now())
	});
	await h.clock.advance(10);
	assert.equal(h.scheduler.inFlightCount, 1);

	let shutdownDone = false;
	const shutdownPromise = h.scheduler.shutdown(60_000).then(() => {
		shutdownDone = true;
	});

	// Give the event loop a turn; shutdown must NOT resolve while job runs.
	await flushMicrotasks();
	assert.equal(shutdownDone, false);
	assert.equal(completed, false);

	// Completing the job lets shutdown finish.
	resolveJob!();
	await shutdownPromise;
	assert.equal(completed, true);
	assert.equal(shutdownDone, true);

	// No new jobs may be scheduled after shutdown.
	await assert.rejects(
		() =>
			h.scheduler.scheduleOneOff({
				kind: "slow",
				runAt: new Date(h.clock.now())
			}),
		/shutting down/
	);
});

test("graceful shutdown aborts in-flight jobs that exceed the timeout", async () => {
	const h = makeHarness();
	let aborted = false;
	h.scheduler.registerOneOffHandler("hang", (ctx) => {
		return new Promise<void>((resolve, reject) => {
			ctx.signal.addEventListener("abort", () => {
				aborted = true;
				reject(new Error("aborted"));
			});
		});
	});
	await h.scheduler.start();
	await h.scheduler.scheduleOneOff({
		kind: "hang",
		runAt: new Date(h.clock.now())
	});
	await h.clock.advance(10);
	assert.equal(h.scheduler.inFlightCount, 1);

	const shutdown = h.scheduler.shutdown(2_000);

	// Cross the shutdown timeout so the scheduler aborts the handler.
	await h.clock.advance(2_000);
	await shutdown;

	assert.equal(aborted, true, "abort signal should fire on timeout");
	assert.equal(h.scheduler.inFlightCount, 0);
});

test("recovers crashed `running` rows back to pending on start", async () => {
	const h = makeHarness();
	// Pre-seed a row in the running state, simulating a crash mid-execution.
	await h.repo.create({
		kind: "post-crash",
		runAt: new Date(h.clock.now())
	});
	const [row] = [...h.repo.rows.values()];
	row!.status = "running";
	row!.lockedAt = new Date(h.clock.now());

	let observed = false;
	h.scheduler.registerOneOffHandler("post-crash", () => {
		observed = true;
	});
	await h.scheduler.start();
	await h.clock.advance(10);

	assert.equal(observed, true, "recovered job should execute after start");

	await h.scheduler.shutdown(1000);
});

test("uses a single self-rescheduling timer (no per-job intervals)", async () => {
	const h = makeHarness();
	h.scheduler.registerRecurring({
		name: "a",
		kind: "k",
		cron: "* * * * *",
		handler: () => {}
	});
	h.scheduler.registerRecurring({
		name: "b",
		kind: "k2",
		cron: "* * * * *",
		handler: () => {}
	});
	await h.scheduler.start();

	// Pump the scheduler a few times; the FakeClock's internal timer map should
	// hold at most one pending timer at any given moment of quiescence.
	await h.clock.advance(60_000);
	// Inspect via reflection: only one pending timer should remain.
	const timers = (h.clock as unknown as { timers: Map<unknown, unknown> })
		.timers;
	assert.ok(
		timers.size <= 1,
		`expected single-timer wakeup model, got ${timers.size}`
	);

	await h.scheduler.shutdown(1000);
});
