import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { EventBus } from "../src/events/event-bus";
import {
	RECORDING_JOB_KIND,
	RecordingStorageNotConfiguredError,
	RecordingsService,
	type RecordingsConfigResolver,
	type RecordingsLogger
} from "../src/recordings/recordings.service";
import type { RecordingRunner } from "../src/recordings/recording-session";
import type {
	CreateRecordingInput,
	CreateScheduledRecordingInput,
	CreateScheduledRecordingResult,
	RecordingRecord,
	UpdateRecordingInput
} from "../src/repositories/recordings.repository";
import type {
	CreateScheduledJobInput,
	ScheduledJobRecord
} from "../src/repositories/scheduled-jobs.repository";
import type {
	JobContext,
	JobHandler,
	ScheduleOneOffInput
} from "../src/scheduler/scheduler";
import type { ResolvedStreamSource } from "../src/streaming/streaming.service";
import { TunerAllocator } from "../src/tuners/tuner-allocator";

/** In-memory scheduler rows keep recovery tests independent of PostgreSQL. */
class RecoveryJobsRepository {
	readonly rows = new Map<string, ScheduledJobRecord>();

	async create(
		input: CreateScheduledJobInput & { id?: string }
	): Promise<ScheduledJobRecord> {
		const now = new Date();
		const row: ScheduledJobRecord = {
			id: input.id ?? randomUUID(),
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

	async cancel(id: string): Promise<boolean> {
		const row = this.rows.get(id);
		if (!row || (row.status !== "pending" && row.status !== "running")) {
			return false;
		}
		row.status = "cancelled";
		row.lockedAt = null;
		row.updatedAt = new Date();
		return true;
	}
}

/** Recording rows mirror the conditional transitions used by the real DB. */
class RecoveryRecordingsRepository {
	readonly rows = new Map<string, RecordingRecord>();
	beforeUpdateScheduled: (() => Promise<void>) | undefined;

	constructor(private readonly jobs: RecoveryJobsRepository) {}

	async createScheduledWithJob(
		input: CreateScheduledRecordingInput
	): Promise<CreateScheduledRecordingResult> {
		const jobId = randomUUID();
		const recording = await this.create({
			channelId: input.channelId,
			...(input.programId ? { programId: input.programId } : {}),
			title: input.title,
			status: "scheduled",
			scheduledStart: input.scheduledStart,
			scheduledEnd: input.scheduledEnd,
			schedulerJobId: jobId
		});
		await this.jobs.create({
			id: jobId,
			kind: input.jobKind,
			payload: { recordingId: recording.id },
			runAt: input.runAt,
			...(input.maxAttempts !== undefined
				? { maxAttempts: input.maxAttempts }
				: {})
		});
		return { recording, created: true };
	}

	async create(input: CreateRecordingInput): Promise<RecordingRecord> {
		const now = new Date();
		const row: RecordingRecord = {
			id: randomUUID(),
			channelId: input.channelId,
			programId: input.programId ?? null,
			title: input.title,
			status: input.status,
			scheduledStart: input.scheduledStart,
			scheduledEnd: input.scheduledEnd,
			actualStart: null,
			actualEnd: null,
			startReason: null,
			filePath: null,
			fileSize: null,
			durationSeconds: null,
			errorMessage: null,
			schedulerJobId: input.schedulerJobId ?? null,
			seriesRuleId: input.seriesRuleId ?? null,
			manuallyProtected: input.manuallyProtected ?? false,
			watchedAt: null,
			resumePositionSeconds: null,
			createdAt: now,
			updatedAt: now
		};
		this.rows.set(row.id, row);
		return row;
	}

	async getById(id: string): Promise<RecordingRecord | null> {
		return this.rows.get(id) ?? null;
	}

	async update(
		id: string,
		patch: UpdateRecordingInput
	): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row) {
			return null;
		}
		Object.assign(row, patch, { updatedAt: new Date() });
		return row;
	}

	async updateScheduled(
		id: string,
		patch: UpdateRecordingInput
	): Promise<RecordingRecord | null> {
		await this.beforeUpdateScheduled?.();
		this.beforeUpdateScheduled = undefined;
		const row = this.rows.get(id);
		if (!row || row.status !== "scheduled") {
			return null;
		}
		Object.assign(row, patch, { updatedAt: new Date() });
		return row;
	}

	async transitionStatus(
		id: string,
		expectedStatus: string,
		patch: UpdateRecordingInput & { status: string }
	): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row || row.status !== expectedStatus) {
			return null;
		}
		Object.assign(row, patch, { updatedAt: new Date() });
		return row;
	}

	async cancelScheduled(id: string): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row || row.status !== "scheduled") {
			return null;
		}
		row.status = "cancelled";
		row.updatedAt = new Date();
		if (row.schedulerJobId) {
			await this.jobs.cancel(row.schedulerJobId);
		}
		return row;
	}

	async listByStatuses(statuses: string[]): Promise<RecordingRecord[]> {
		return [...this.rows.values()].filter((row) =>
			statuses.includes(row.status)
		);
	}
}

/** Captures the registered recording handler so each attempt is clock-driven. */
class RecoveryScheduler {
	private handler: JobHandler | undefined;

	constructor(private readonly jobs: RecoveryJobsRepository) {}

	registerOneOffHandler(kind: string, handler: JobHandler): void {
		assert.equal(kind, RECORDING_JOB_KIND);
		this.handler = handler;
	}

	async schedulePersistedOneOff<T>(persist: () => Promise<T>): Promise<T> {
		return persist();
	}

	async scheduleOneOff(input: ScheduleOneOffInput): Promise<string> {
		const row = await this.jobs.create(input);
		return row.id;
	}

	async ensureOneOffScheduled(
		input: ScheduleOneOffInput,
		existingJobId?: string | null
	): Promise<string> {
		const existing = existingJobId
			? await this.jobs.getById(existingJobId)
			: null;
		if (
			existing &&
			(existing.status === "pending" || existing.status === "running") &&
			existing.maxAttempts === (input.maxAttempts ?? 1)
		) {
			return existing.id;
		}
		if (existing) {
			await this.jobs.cancel(existing.id);
		}
		return this.scheduleOneOff(input);
	}

	async cancelOneOff(id: string): Promise<boolean> {
		return this.jobs.cancel(id);
	}

	/** Invoke one deterministic scheduler attempt without wall-clock timers. */
	async runAttempt(input: {
		jobId: string;
		recordingId: string;
		attempt: number;
		maxAttempts?: number;
		nextRetryAt?: Date | null;
		signal?: AbortSignal;
	}): Promise<void> {
		assert.ok(this.handler, "recording handler should be registered");
		const context: JobContext = {
			id: input.jobId,
			kind: RECORDING_JOB_KIND,
			attempt: input.attempt,
			maxAttempts: input.maxAttempts ?? 3,
			nextRetryAt: input.nextRetryAt ?? null,
			payload: { recordingId: input.recordingId },
			signal: input.signal ?? new AbortController().signal
		};
		await this.handler(context);
	}
}

/** Controllable child process used to hold and release tuner leases in tests. */
class ControlledProcess extends EventEmitter {
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	complete(
		code: number | null = 0,
		signal: NodeJS.Signals | null = null
	): void {
		if (this.exitCode !== null || this.signalCode !== null) {
			return;
		}
		this.exitCode = code;
		this.signalCode = signal;
		this.stderr.end();
		this.emit("exit", code, signal);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.complete(null, signal);
		return true;
	}
}

/** Resolve a successful FFmpeg process after listeners have been attached. */
function completingRunner(capturedArgs: string[][]): RecordingRunner {
	return {
		spawn: (args) => {
			capturedArgs.push(args);
			const child = new ControlledProcess();
			queueMicrotask(() => child.complete());
			return child as unknown as ChildProcess;
		}
	};
}

/** Build a static recording configuration for a controlled time window. */
function staticConfig(
	recordingsDir: string,
	paddingBeforeSec = 30,
	paddingAfterSec = 30
): RecordingsConfigResolver {
	return {
		resolve: async () => ({
			recordingsDir,
			paddingBeforeSec,
			paddingAfterSec
		})
	};
}

/** Standard source used once recovery has established capture is meaningful. */
function staticSource(providerId = randomUUID()): ResolvedStreamSource {
	return {
		providerId,
		providerChannelId: "7.1",
		upstreamUrl: "http://tuner.test/stream"
	};
}

/** Create a service and its deterministic persistence/scheduler seams. */
function createHarness(input: {
	now: () => Date;
	config: RecordingsConfigResolver;
	resolver?: { resolve(channelId: string): Promise<ResolvedStreamSource> };
	allocator?: TunerAllocator;
	runner?: RecordingRunner;
	directoryProbe?: (directory: string) => Promise<void>;
	logger?: RecordingsLogger;
}) {
	const jobs = new RecoveryJobsRepository();
	const recordings = new RecoveryRecordingsRepository(jobs);
	const scheduler = new RecoveryScheduler(jobs);
	const service = new RecordingsService({
		repository: recordings as never,
		scheduler: scheduler as never,
		allocator:
			input.allocator ?? new TunerAllocator({ capacity: async () => 1 }),
		resolver: input.resolver ?? { resolve: async () => staticSource() },
		config: input.config,
		now: input.now,
		...(input.logger ? { logger: input.logger } : {}),
		...(input.runner ? { runner: input.runner } : {}),
		...(input.directoryProbe ? { directoryProbe: input.directoryProbe } : {}),
		bus: new EventBus()
	});
	return { jobs, recordings, scheduler, service };
}

/** Schedule a row and return its linked job id for manual dispatch. */
async function scheduleRecording(
	harness: ReturnType<typeof createHarness>,
	start: Date,
	end: Date,
	title = "Recovery Test"
): Promise<{ recording: RecordingRecord; jobId: string }> {
	const recording = await harness.service.schedule({
		channelId: randomUUID(),
		title,
		start,
		end
	});
	assert.ok(recording.schedulerJobId);
	return { recording, jobId: recording.schedulerJobId };
}

test("startup before the window keeps recovery scheduled at pre-padding", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-future-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T11:00:00.000Z");
	let resolverCalls = 0;
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp),
		resolver: {
			resolve: async () => {
				resolverCalls += 1;
				return staticSource();
			}
		}
	});
	const recording = await harness.recordings.create({
		channelId: randomUUID(),
		title: "Future Recovery",
		status: "scheduled",
		scheduledStart: new Date("2026-07-18T12:00:00.000Z"),
		scheduledEnd: new Date("2026-07-18T13:00:00.000Z")
	});

	await harness.service.resumeScheduledOnStartup();

	assert.equal(resolverCalls, 0);
	assert.equal(harness.jobs.rows.size, 1);
	const [job] = harness.jobs.rows.values();
	assert.equal(
		job?.runAt.getTime(),
		new Date("2026-07-18T11:59:30.000Z").getTime()
	);
	assert.equal(job?.maxAttempts, 3);
	assert.equal(
		(await harness.recordings.getById(recording.id))?.schedulerJobId,
		job?.id
	);
});

test("cancellation wins while startup recovery links a replacement job", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-recovery-startup-race-")
	);
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const harness = createHarness({
		now: () => new Date("2026-07-18T11:00:00.000Z"),
		config: staticConfig(tmp)
	});
	const recording = await harness.recordings.create({
		channelId: randomUUID(),
		title: "Startup Race",
		status: "scheduled",
		scheduledStart: new Date("2026-07-18T12:00:00.000Z"),
		scheduledEnd: new Date("2026-07-18T13:00:00.000Z")
	});
	harness.recordings.beforeUpdateScheduled = async () => {
		await harness.service.cancel(recording.id);
	};

	await harness.service.resumeScheduledOnStartup();

	assert.equal(
		(await harness.recordings.getById(recording.id))?.status,
		"cancelled"
	);
	assert.equal(harness.jobs.rows.size, 1);
	assert.ok(
		[...harness.jobs.rows.values()].every((job) => job.status === "cancelled")
	);
});

test("late recovery uses the absolute padded cutoff for FFmpeg duration", async (t) => {
	const start = new Date("2026-07-18T12:00:00.000Z");
	const end = new Date("2026-07-18T13:00:00.000Z");
	const cases = [
		{
			name: "during pre-padding",
			now: new Date("2026-07-18T11:59:45.000Z"),
			duration: 3_645,
			startReason: null
		},
		{
			name: "within normal startup latency",
			now: new Date("2026-07-18T12:00:30.000Z"),
			duration: 3_600,
			startReason: null
		},
		{
			name: "beyond normal startup latency",
			now: new Date("2026-07-18T12:00:31.000Z"),
			duration: 3_599,
			startReason: "late_start"
		},
		{
			name: "midway through the program",
			now: new Date("2026-07-18T12:30:00.000Z"),
			duration: 1_830,
			startReason: "late_start"
		},
		{
			name: "during post-padding",
			now: new Date("2026-07-18T13:00:15.000Z"),
			duration: 15,
			startReason: "late_start"
		}
	] as const;

	for (const scenario of cases) {
		await t.test(scenario.name, async (t) => {
			const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-window-"));
			t.after(() => rm(tmp, { recursive: true, force: true }));
			const args: string[][] = [];
			const harness = createHarness({
				now: () => scenario.now,
				config: staticConfig(tmp),
				runner: completingRunner(args)
			});
			const { recording, jobId } = await scheduleRecording(harness, start, end);

			await harness.scheduler.runAttempt({
				jobId,
				recordingId: recording.id,
				attempt: 1,
				nextRetryAt: new Date(scenario.now.getTime() + 1_000)
			});

			const updated = await harness.recordings.getById(recording.id);
			assert.equal(updated?.status, "completed");
			assert.equal(updated?.actualStart?.getTime(), scenario.now.getTime());
			assert.equal(updated?.startReason, scenario.startReason);
			assert.equal(args.length, 1);
			const durationIndex = args[0]!.indexOf("-t");
			assert.equal(Number(args[0]![durationIndex + 1]), scenario.duration);
		});
	}
});

test("startup after the padded cutoff is missed without touching source, tuner, or FFmpeg", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-missed-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T13:00:30.000Z");
	let resolverCalls = 0;
	let capacityCalls = 0;
	let spawnCalls = 0;
	const logEntries: Record<string, unknown>[] = [];
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp),
		resolver: {
			resolve: async () => {
				resolverCalls += 1;
				return staticSource();
			}
		},
		allocator: new TunerAllocator({
			capacity: async () => {
				capacityCalls += 1;
				return 1;
			}
		}),
		runner: {
			spawn: () => {
				spawnCalls += 1;
				return new ControlledProcess() as unknown as ChildProcess;
			}
		},
		logger: {
			debug: () => {},
			info: (context) => logEntries.push(context),
			warn: (context) => logEntries.push(context),
			error: (context) => logEntries.push(context)
		}
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	);

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId,
			recordingId: recording.id,
			attempt: 1
		}),
		(error: unknown) =>
			(error as { name?: string }).name === "NonRetryableJobError"
	);

	const updated = await harness.recordings.getById(recording.id);
	assert.equal(updated?.status, "failed");
	assert.equal(updated?.errorMessage, "missed_window");
	assert.equal(updated?.actualStart, null);
	assert.equal(resolverCalls, 0);
	assert.equal(capacityCalls, 0);
	assert.equal(spawnCalls, 0);
	assert.ok(
		logEntries.some(
			(entry) =>
				entry["recordingId"] === recording.id &&
				entry["attempt"] === 1 &&
				entry["remainingDurationSeconds"] === 0 &&
				entry["terminalReason"] === "missed_window"
		)
	);
});

test("a transient source failure retries while capture time remains", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-recovery-source-retry-")
	);
	t.after(() => rm(tmp, { recursive: true, force: true }));
	let now = new Date("2026-07-18T12:10:00.000Z");
	let resolverCalls = 0;
	const args: string[][] = [];
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp, 0, 0),
		resolver: {
			resolve: async () => {
				resolverCalls += 1;
				if (resolverCalls === 1) {
					throw new Error("temporary source outage");
				}
				return staticSource();
			}
		},
		runner: completingRunner(args)
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	);

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId,
			recordingId: recording.id,
			attempt: 1,
			nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
		}),
		/temporary source outage/
	);
	assert.equal(
		(await harness.recordings.getById(recording.id))?.status,
		"scheduled"
	);

	now = new Date("2026-07-18T12:10:01.000Z");
	await harness.scheduler.runAttempt({
		jobId,
		recordingId: recording.id,
		attempt: 2,
		nextRetryAt: new Date("2026-07-18T12:10:03.000Z")
	});

	assert.equal(
		(await harness.recordings.getById(recording.id))?.status,
		"completed"
	);
	assert.equal(resolverCalls, 2);
	assert.equal(args.length, 1);
});

test("a retry that cannot leave meaningful capture time becomes terminal", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-recovery-window-expired-")
	);
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T12:59:59.500Z");
	let spawnCalls = 0;
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp, 0, 0),
		allocator: new TunerAllocator({ capacity: async () => 0 }),
		runner: {
			spawn: () => {
				spawnCalls += 1;
				return new ControlledProcess() as unknown as ChildProcess;
			}
		}
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	);

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId,
			recordingId: recording.id,
			attempt: 1,
			nextRetryAt: new Date("2026-07-18T13:00:00.000Z")
		}),
		(error: unknown) =>
			(error as { name?: string }).name === "NonRetryableJobError"
	);

	const updated = await harness.recordings.getById(recording.id);
	assert.equal(updated?.status, "failed");
	assert.equal(updated?.errorMessage, "retry_window_exhausted");
	assert.equal(spawnCalls, 0);
});

test("permanent configuration failures do not enter retry backoff", async () => {
	const now = new Date("2026-07-18T12:10:00.000Z");
	let resolverCalls = 0;
	const harness = createHarness({
		now: () => now,
		config: {
			resolve: async () => {
				throw new RecordingStorageNotConfiguredError();
			}
		},
		resolver: {
			resolve: async () => {
				resolverCalls += 1;
				return staticSource();
			}
		}
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	).catch(async () => {
		// Scheduling also resolves configuration, so seed the row directly.
		const seeded = await harness.recordings.create({
			channelId: randomUUID(),
			title: "Bad Config",
			status: "scheduled",
			scheduledStart: new Date("2026-07-18T12:00:00.000Z"),
			scheduledEnd: new Date("2026-07-18T13:00:00.000Z"),
			schedulerJobId: randomUUID()
		});
		return { recording: seeded, jobId: seeded.schedulerJobId! };
	});

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId,
			recordingId: recording.id,
			attempt: 1,
			nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
		}),
		(error: unknown) =>
			(error as { name?: string }).name === "NonRetryableJobError"
	);

	const updated = await harness.recordings.getById(recording.id);
	assert.equal(updated?.status, "failed");
	assert.equal(updated?.errorMessage, "configuration_error");
	assert.equal(resolverCalls, 0);
});

test("an unwritable recording directory fails before source or FFmpeg work", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-readonly-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T12:10:00.000Z");
	let resolverCalls = 0;
	let spawnCalls = 0;
	let probedDirectory: string | undefined;
	const runner = completingRunner([]);
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp, 0, 0),
		directoryProbe: async (directory) => {
			probedDirectory = directory;
			const error = new Error("Permission denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		},
		resolver: {
			resolve: async () => {
				resolverCalls += 1;
				return staticSource();
			}
		},
		runner: {
			spawn: (args) => {
				spawnCalls += 1;
				return runner.spawn(args);
			}
		}
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	);

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId,
			recordingId: recording.id,
			attempt: 1,
			nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
		}),
		(error: unknown) =>
			(error as { name?: string }).name === "NonRetryableJobError"
	);

	const updated = await harness.recordings.getById(recording.id);
	assert.equal(updated?.status, "failed");
	assert.equal(updated?.errorMessage, "configuration_error");
	assert.equal(updated?.actualStart, null);
	assert.equal(probedDirectory, tmp);
	assert.equal(resolverCalls, 0);
	assert.equal(spawnCalls, 0);
});

test("cancellation during backoff prevents the queued retry from doing work", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-cancel-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T12:10:00.000Z");
	let resolverCalls = 0;
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp, 0, 0),
		resolver: {
			resolve: async () => {
				resolverCalls += 1;
				throw new Error("temporary source outage");
			}
		}
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	);

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId,
			recordingId: recording.id,
			attempt: 1,
			nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
		}),
		/temporary source outage/
	);
	const cancelled = await harness.service.cancel(recording.id);
	assert.equal(cancelled.status, "cancelled");

	await harness.scheduler.runAttempt({
		jobId,
		recordingId: recording.id,
		attempt: 2,
		nextRetryAt: new Date("2026-07-18T12:10:03.000Z")
	});

	assert.equal(resolverCalls, 1);
	assert.equal(
		(await harness.recordings.getById(recording.id))?.status,
		"cancelled"
	);
	assert.equal(harness.jobs.rows.get(jobId)?.status, "cancelled");
});

test("concurrent overdue jobs share a limited tuner through bounded retry", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-contention-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T12:10:00.000Z");
	const providerId = randomUUID();
	const allocator = new TunerAllocator({ capacity: async () => 1 });
	const children: ControlledProcess[] = [];
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp, 0, 0),
		resolver: { resolve: async () => staticSource(providerId) },
		allocator,
		runner: {
			spawn: () => {
				const child = new ControlledProcess();
				children.push(child);
				return child as unknown as ChildProcess;
			}
		}
	});
	const first = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z"),
		"First"
	);
	const second = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z"),
		"Second"
	);

	const firstAttempt = harness.scheduler.runAttempt({
		jobId: first.jobId,
		recordingId: first.recording.id,
		attempt: 1,
		nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
	});
	await waitFor(() => children.length === 1);

	await assert.rejects(
		harness.scheduler.runAttempt({
			jobId: second.jobId,
			recordingId: second.recording.id,
			attempt: 1,
			nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
		}),
		/No tuner capacity/
	);
	assert.equal(
		(await harness.recordings.getById(second.recording.id))?.status,
		"scheduled"
	);
	assert.equal(children.length, 1);

	children[0]!.complete();
	await firstAttempt;
	const secondAttempt = harness.scheduler.runAttempt({
		jobId: second.jobId,
		recordingId: second.recording.id,
		attempt: 2,
		nextRetryAt: new Date("2026-07-18T12:10:03.000Z")
	});
	await waitFor(() => children.length === 2);
	children[1]!.complete();
	await secondAttempt;

	assert.equal(
		(await harness.recordings.getById(first.recording.id))?.status,
		"completed"
	);
	assert.equal(
		(await harness.recordings.getById(second.recording.id))?.status,
		"completed"
	);
	assert.equal(allocator.getActivity().length, 0);
});

test("duplicate attempts for one recording never overlap", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-recovery-overlap-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const now = new Date("2026-07-18T12:10:00.000Z");
	const children: ControlledProcess[] = [];
	const harness = createHarness({
		now: () => now,
		config: staticConfig(tmp, 0, 0),
		runner: {
			spawn: () => {
				const child = new ControlledProcess();
				children.push(child);
				return child as unknown as ChildProcess;
			}
		}
	});
	const { recording, jobId } = await scheduleRecording(
		harness,
		new Date("2026-07-18T12:00:00.000Z"),
		new Date("2026-07-18T13:00:00.000Z")
	);

	const first = harness.scheduler.runAttempt({
		jobId,
		recordingId: recording.id,
		attempt: 1,
		nextRetryAt: new Date("2026-07-18T12:10:01.000Z")
	});
	await waitFor(() => children.length === 1);
	await harness.scheduler.runAttempt({
		jobId,
		recordingId: recording.id,
		attempt: 2,
		nextRetryAt: new Date("2026-07-18T12:10:03.000Z")
	});

	assert.equal(children.length, 1);
	children[0]!.complete();
	await first;
	assert.equal(
		(await harness.recordings.getById(recording.id))?.status,
		"completed"
	);
});

/**
 * Wait for observable behavior without relying on a fixed number of event-loop
 * turns, which can finish before delayed I/O under parallel coverage runs.
 */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});
	}
	throw new Error("Timed out waiting for recovery test condition");
}
