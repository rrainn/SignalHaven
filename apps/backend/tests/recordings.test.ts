import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventBus, type PublishedEvent } from "../src/events/event-bus";
import {
	RecordingsService,
	RECORDING_EVENT,
	toPublicRecording,
	type RecordingsConfigResolver
} from "../src/recordings/recordings.service";
import {
	type CreateRecordingInput,
	type CreateScheduledRecordingInput,
	type CreateScheduledRecordingResult,
	type RecordingRecord,
	type UpdateRecordingInput
} from "../src/repositories/recordings.repository";
import { Scheduler } from "../src/scheduler/scheduler";
import type { ResolvedStreamSource } from "../src/streaming/streaming.service";
import { TunerAllocator } from "../src/tuners/tuner-allocator";

/** Records published events for assertion. */
function captureEvents(bus: EventBus): PublishedEvent[] {
	const events: PublishedEvent[] = [];
	bus.subscribe("recordings", (event) => {
		events.push(event);
	});
	return events;
}

/**
 * In-memory stand-in for `RecordingsRepository`. Mirrors the subset of
 * the API the service touches.
 */
class FakeRecordingsRepo {
	readonly rows = new Map<string, RecordingRecord>();

	constructor(private readonly jobsRepository: InMemoryJobsRepo) {}

	async createScheduledWithJob(
		input: CreateScheduledRecordingInput
	): Promise<CreateScheduledRecordingResult> {
		if (input.programId) {
			// The in-memory check and row insertion stay in one synchronous turn to
			// model the database's unique-index arbitration for concurrent calls.
			const existing = [...this.rows.values()].find(
				(row) =>
					row.programId === input.programId &&
					(row.status === "scheduled" || row.status === "recording")
			);
			if (existing) {
				return { recording: existing, created: false };
			}
		}

		const jobId = randomUUID();
		const row = await this.create({
			channelId: input.channelId,
			...(input.programId ? { programId: input.programId } : {}),
			title: input.title,
			status: "scheduled",
			scheduledStart: input.scheduledStart,
			scheduledEnd: input.scheduledEnd,
			schedulerJobId: jobId,
			...(input.seriesRuleId ? { seriesRuleId: input.seriesRuleId } : {}),
			...(input.manuallyProtected !== undefined
				? { manuallyProtected: input.manuallyProtected }
				: {})
		});
		try {
			await this.jobsRepository.create({
				id: jobId,
				kind: input.jobKind,
				runAt: input.runAt,
				payload: { recordingId: row.id },
				...(input.maxAttempts !== undefined
					? { maxAttempts: input.maxAttempts }
					: {})
			});
		} catch (error) {
			this.rows.delete(row.id);
			throw error;
		}
		return { recording: row, created: true };
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

	async list(): Promise<RecordingRecord[]> {
		return [...this.rows.values()];
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
		const row = this.rows.get(id);
		if (!row || row.status !== "scheduled") {
			return null;
		}
		Object.assign(row, patch, { updatedAt: new Date() });
		return row;
	}

	async transitionStatus(
		id: string,
		expected: string,
		patch: UpdateRecordingInput & { status: string }
	): Promise<RecordingRecord | null> {
		const row = this.rows.get(id);
		if (!row || row.status !== expected) {
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
			await this.jobsRepository.cancel(row.schedulerJobId);
		}
		return row;
	}

	async recoverInProgress(reason: string): Promise<string[]> {
		const ids: string[] = [];
		for (const row of this.rows.values()) {
			if (row.status === "recording") {
				row.status = "failed";
				row.errorMessage = reason;
				row.actualEnd = new Date();
				ids.push(row.id);
			}
		}
		return ids;
	}

	async listByStatuses(statuses: string[]): Promise<RecordingRecord[]> {
		return [...this.rows.values()].filter((r) => statuses.includes(r.status));
	}

	async listScheduledWithProgram(): Promise<RecordingRecord[]> {
		return [...this.rows.values()].filter(
			(r) => r.status === "scheduled" && r.programId !== null
		);
	}

	async findActiveByProgramId(
		programId: string
	): Promise<RecordingRecord | null> {
		return (
			[...this.rows.values()].find(
				(row) =>
					row.programId === programId &&
					(row.status === "scheduled" || row.status === "recording")
			) ?? null
		);
	}
}

/** Static config resolver pointing at a tmp dir. */
function staticConfig(
	recordingsDir: string,
	paddingBeforeSec = 0,
	paddingAfterSec = 0
): RecordingsConfigResolver {
	return {
		resolve: async () => ({
			recordingsDir,
			paddingBeforeSec,
			paddingAfterSec
		})
	};
}

const ffmpegAvailable = (() => {
	try {
		const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
		return result.status === 0;
	} catch {
		return false;
	}
})();

function ffmpegHasMatroska(): boolean {
	try {
		const result = spawnSync("ffmpeg", ["-hide_banner", "-formats"], {
			encoding: "utf8"
		});
		return /matroska/.test(result.stdout ?? "");
	} catch {
		return false;
	}
}

test("schedule(): persists row, arms scheduler, emits scheduled event", async () => {
	const bus = new EventBus();
	const events = captureEvents(bus);
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const allocator = new TunerAllocator({ capacity: async () => 1 });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-cfg-"));

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator,
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 5, 0),
		bus
	});

	const start = new Date(Date.now() + 60_000);
	const end = new Date(start.getTime() + 5_000);
	const row = await service.schedule({
		channelId: randomUUID(),
		title: "My Show",
		start,
		end
	});

	assert.equal(row.status, "scheduled");
	assert.equal(jobsRepo.rows.size, 1);
	const [job] = [...jobsRepo.rows.values()];
	assert.equal(job?.kind, "recording");
	// Padding shifts the scheduled run-at five seconds before `start`.
	assert.equal(job?.runAt.getTime(), start.getTime() - 5_000);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, RECORDING_EVENT.scheduled);

	await rm(tmp, { recursive: true, force: true });
});

test("cancel(): scheduled row transitions to cancelled", async () => {
	const bus = new EventBus();
	const events = captureEvents(bus);
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-cfg-"));

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp),
		bus
	});

	const created = await service.schedule({
		channelId: randomUUID(),
		title: "Cancel Me",
		start: new Date(Date.now() + 60_000),
		end: new Date(Date.now() + 120_000)
	});

	await service.cancel(created.id);
	const after = await service.getById(created.id);
	assert.equal(after.status, "cancelled");
	assert.equal(jobsRepo.rows.get(created.schedulerJobId!)?.status, "cancelled");
	assert.ok(events.some((e) => e.event === RECORDING_EVENT.cancelled));

	await rm(tmp, { recursive: true, force: true });
});

test("resumeScheduledOnStartup(): reuses the persisted pending job", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-resume-"));

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp),
		bus
	});
	const created = await service.schedule({
		channelId: randomUUID(),
		title: "Survives Restart",
		start: new Date(Date.now() + 60_000),
		end: new Date(Date.now() + 120_000)
	});

	await service.resumeScheduledOnStartup();

	assert.equal(jobsRepo.rows.size, 1);
	assert.equal(
		(await repo.getById(created.id))?.schedulerJobId,
		created.schedulerJobId
	);

	await rm(tmp, { recursive: true, force: true });
});

test("recoverOnStartup(): in-progress rows are flipped to failed", async () => {
	const bus = new EventBus();
	const events = captureEvents(bus);
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-cfg-"));

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp),
		bus
	});

	// Manually seed an orphan in-progress row.
	const orphan = await repo.create({
		channelId: randomUUID(),
		title: "Orphan",
		status: "recording",
		scheduledStart: new Date(),
		scheduledEnd: new Date(Date.now() + 1000)
	});
	orphan.status = "recording";

	await service.recoverOnStartup();

	const after = await repo.getById(orphan.id);
	assert.equal(after?.status, "failed");
	assert.equal(after?.errorMessage, "process_terminated");
	assert.ok(events.some((e) => e.event === RECORDING_EVENT.failed));

	await rm(tmp, { recursive: true, force: true });
});

test("toPublicRecording(): serialises Date fields as ISO strings", () => {
	const start = new Date("2026-01-01T00:00:00.000Z");
	const end = new Date("2026-01-01T00:05:00.000Z");
	const public_ = toPublicRecording({
		id: "00000000-0000-0000-0000-000000000001",
		channelId: "00000000-0000-0000-0000-000000000002",
		programId: null,
		title: "x",
		status: "scheduled",
		scheduledStart: start,
		scheduledEnd: end,
		actualStart: null,
		actualEnd: null,
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: null,
		errorMessage: null,
		schedulerJobId: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		createdAt: start,
		updatedAt: start
	});
	assert.equal(public_.scheduledStart, start.toISOString());
	assert.equal(public_.scheduledEnd, end.toISOString());
});

test("toPublicRecording(): hides legacy late-start flags within startup grace", () => {
	const scheduledStart = new Date("2026-01-01T00:00:00.000Z");
	const row = {
		id: "00000000-0000-0000-0000-000000000001",
		channelId: "00000000-0000-0000-0000-000000000002",
		programId: null,
		title: "x",
		status: "completed",
		scheduledStart,
		scheduledEnd: new Date("2026-01-01T00:05:00.000Z"),
		actualStart: new Date("2026-01-01T00:00:30.000Z"),
		actualEnd: new Date("2026-01-01T00:05:00.000Z"),
		startReason: "late_start",
		filePath: "/recordings/x.mkv",
		fileSize: 1,
		durationSeconds: 270,
		errorMessage: null,
		schedulerJobId: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		createdAt: scheduledStart,
		updatedAt: scheduledStart
	} satisfies RecordingRecord;

	assert.equal(toPublicRecording(row).startReason, null);
	assert.equal(
		toPublicRecording({
			...row,
			actualStart: new Date("2026-01-01T00:00:31.000Z")
		}).startReason,
		"late_start"
	);
});

/** Minimal in-memory EpgProgramsRepository surrogate for the by-program tests. */
class FakeEpgProgramsRepo {
	readonly rows = new Map<
		string,
		{
			id: string;
			epgChannelId: string;
			start: Date;
			stop: Date;
			title: string;
		}
	>();

	put(row: {
		id: string;
		epgChannelId: string;
		start: Date;
		stop: Date;
		title: string;
	}) {
		this.rows.set(row.id, { ...row });
	}

	async getById(id: string) {
		const row = this.rows.get(id);
		return row ? { ...row } : null;
	}
}

/** Minimal in-memory ChannelEpgMapRepository surrogate. */
class FakeChannelEpgMapRepo {
	readonly rows: { channelId: string; epgChannelId: string }[] = [];

	put(channelId: string, epgChannelId: string) {
		this.rows.push({ channelId, epgChannelId });
	}

	async getByEpgChannelId(epgChannelId: string) {
		return this.rows.find((r) => r.epgChannelId === epgChannelId) ?? null;
	}

	async getByChannelId(channelId: string) {
		return this.rows.find((row) => row.channelId === channelId) ?? null;
	}
}

test("scheduleByProgram(): resolves channel via mapping, links to program, copies times", async () => {
	const bus = new EventBus();
	const events = captureEvents(bus);
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-bp-"));

	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	const start = new Date(Date.now() + 60_000);
	const stop = new Date(start.getTime() + 30 * 60_000);
	programs.put({ id: programId, epgChannelId, start, stop, title: "Movie" });
	map.put(channelId, epgChannelId);

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 5, 0),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		bus
	});

	const result = await service.scheduleByProgram({ programId });
	const created = result.recording;

	assert.equal(result.created, true);
	assert.equal(created.channelId, channelId);
	assert.equal(created.programId, programId);
	assert.equal(created.title, "Movie");
	assert.equal(created.scheduledStart.getTime(), start.getTime());
	assert.equal(created.scheduledEnd.getTime(), stop.getTime());
	assert.ok(created.schedulerJobId, "scheduler job id should be linked");
	assert.equal(jobsRepo.rows.size, 1);
	const [job] = [...jobsRepo.rows.values()];
	assert.equal(job?.runAt.getTime(), start.getTime() - 5_000);
	assert.equal(events[0]?.event, RECORDING_EVENT.scheduled);

	const retry = await service.scheduleByProgram({ programId });
	assert.equal(retry.created, false);
	assert.equal(retry.recording.id, created.id);
	assert.equal(jobsRepo.rows.size, 1);
	assert.equal(events.length, 1);

	await rm(tmp, { recursive: true, force: true });
});

test("scheduleByProgram(): honors the requested tuner variant for a shared EPG channel", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-variant-"));
	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const defaultChannelId = randomUUID();
	const requestedChannelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	const start = new Date(Date.now() + 60_000);
	const stop = new Date(start.getTime() + 30 * 60_000);
	programs.put({ id: programId, epgChannelId, start, stop, title: "Movie" });
	map.put(defaultChannelId, epgChannelId);
	map.put(requestedChannelId, epgChannelId);
	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 5, 0),
		epgPrograms: programs as never,
		channelEpgMap: map as never
	});

	const result = await service.scheduleByProgram({
		programId,
		channelId: requestedChannelId
	});

	assert.equal(result.recording.channelId, requestedChannelId);
	await rm(tmp, { recursive: true, force: true });
});

test("scheduleByProgram(): concurrent retries share one recording and scheduler job", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-bp-race-"));

	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	const start = new Date(Date.now() + 60_000);
	programs.put({
		id: programId,
		epgChannelId,
		start,
		stop: new Date(start.getTime() + 30 * 60_000),
		title: "Retry-safe Show"
	});
	map.put(channelId, epgChannelId);

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		bus
	});

	const results = await Promise.all([
		service.scheduleByProgram({ programId }),
		service.scheduleByProgram({ programId })
	]);

	assert.deepEqual(results.map((result) => result.created).sort(), [
		false,
		true
	]);
	assert.equal(results[0]?.recording.id, results[1]?.recording.id);
	assert.equal(repo.rows.size, 1);
	assert.equal(jobsRepo.rows.size, 1);

	await rm(tmp, { recursive: true, force: true });
});

test("scheduleByProgram(): cancellation and failure allow a deliberate retry", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-bp-retry-"));

	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	const start = new Date(Date.now() + 60_000);
	programs.put({
		id: programId,
		epgChannelId,
		start,
		stop: new Date(start.getTime() + 30 * 60_000),
		title: "Retryable Show"
	});
	map.put(channelId, epgChannelId);

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		bus
	});

	const first = await service.scheduleByProgram({ programId });
	await service.cancel(first.recording.id);
	const afterCancellation = await service.scheduleByProgram({ programId });
	assert.equal(afterCancellation.created, true);
	assert.notEqual(afterCancellation.recording.id, first.recording.id);

	await repo.update(afterCancellation.recording.id, { status: "failed" });
	const afterFailure = await service.scheduleByProgram({ programId });
	assert.equal(afterFailure.created, true);
	assert.notEqual(afterFailure.recording.id, afterCancellation.recording.id);

	await rm(tmp, { recursive: true, force: true });
});

test("scheduleByProgram(): rejects a program that has already ended", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-bp-ended-"));

	const now = new Date("2026-06-01T12:00:00.000Z");
	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	programs.put({
		id: programId,
		epgChannelId,
		start: new Date("2026-06-01T11:00:00.000Z"),
		stop: now,
		title: "Ended Show"
	});
	map.put(channelId, epgChannelId);

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		now: () => now,
		bus
	});

	await assert.rejects(
		service.scheduleByProgram({ programId }),
		(error: unknown) =>
			(error as { name?: string }).name === "ProgramNotRecordableError"
	);
	assert.equal(repo.rows.size, 0);
	assert.equal(jobsRepo.rows.size, 0);

	await rm(tmp, { recursive: true, force: true });
});

test("scheduleByProgram(): throws ChannelNotMappedError when EPG channel is unmapped", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-bp-"));

	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const programId = randomUUID();
	const epgChannelId = randomUUID();
	programs.put({
		id: programId,
		epgChannelId,
		start: new Date(Date.now() + 60_000),
		stop: new Date(Date.now() + 120_000),
		title: "Unmapped Show"
	});
	// Note: `map` intentionally has no entry for `epgChannelId`.

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 0, 0),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		bus
	});

	await assert.rejects(
		service.scheduleByProgram({ programId }),
		(error: unknown) => {
			const e = error as { name?: string; epgChannelId?: string };
			return (
				e.name === "ChannelNotMappedError" && e.epgChannelId === epgChannelId
			);
		}
	);
	// No row was persisted and no job was armed.
	assert.equal(repo.rows.size, 0);
	assert.equal(jobsRepo.rows.size, 0);

	await rm(tmp, { recursive: true, force: true });
});

test("scheduleByProgram(): throws EpgProgramNotFoundError for unknown programId", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-bp-"));

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 0, 0),
		epgPrograms: new FakeEpgProgramsRepo() as never,
		channelEpgMap: new FakeChannelEpgMapRepo() as never,
		bus
	});

	await assert.rejects(
		service.scheduleByProgram({ programId: randomUUID() }),
		(error: unknown) =>
			(error as { name?: string }).name === "EpgProgramNotFoundError"
	);

	await rm(tmp, { recursive: true, force: true });
});

test("reconcileProgramSchedules(): re-arms recording when program start shifts later", async () => {
	const bus = new EventBus();
	const events = captureEvents(bus);
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-rs-"));

	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	const originalStart = new Date(Date.now() + 60_000);
	const originalStop = new Date(originalStart.getTime() + 30 * 60_000);
	programs.put({
		id: programId,
		epgChannelId,
		start: originalStart,
		stop: originalStop,
		title: "Show"
	});
	map.put(channelId, epgChannelId);

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 5, 0),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		bus
	});

	const { recording: created } = await service.scheduleByProgram({ programId });
	const originalJobId = created.schedulerJobId;
	assert.ok(originalJobId);

	// Program shifts ten minutes later (e.g. an EPG correction). The
	// duration stays the same.
	const newStart = new Date(originalStart.getTime() + 10 * 60_000);
	const newStop = new Date(originalStop.getTime() + 10 * 60_000);
	programs.put({
		id: programId,
		epgChannelId,
		start: newStart,
		stop: newStop,
		title: "Show"
	});

	const result = await service.reconcileProgramSchedules();

	assert.equal(result.rescheduled, 1);
	const updated = await repo.getById(created.id);
	assert.equal(updated?.scheduledStart.getTime(), newStart.getTime());
	assert.equal(updated?.scheduledEnd.getTime(), newStop.getTime());

	// Old scheduler job was cancelled, new one is pending at the new
	// run-at minus padding.
	const oldJob = jobsRepo.rows.get(originalJobId as string);
	assert.equal(oldJob?.status, "cancelled");
	const newJobId = updated?.schedulerJobId;
	assert.ok(newJobId);
	assert.notEqual(newJobId, originalJobId);
	const newJob = jobsRepo.rows.get(newJobId as string);
	assert.equal(newJob?.status, "pending");
	assert.equal(newJob?.runAt.getTime(), newStart.getTime() - 5_000);
	assert.ok(events.some((e) => e.event === RECORDING_EVENT.rescheduled));

	await rm(tmp, { recursive: true, force: true });
});

test("reconcileProgramSchedules(): no-op when program times unchanged", async () => {
	const bus = new EventBus();
	const jobsRepo = new InMemoryJobsRepo();
	const repo = new FakeRecordingsRepo(jobsRepo);
	const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-rs-noop-"));

	const programs = new FakeEpgProgramsRepo();
	const map = new FakeChannelEpgMapRepo();
	const channelId = randomUUID();
	const epgChannelId = randomUUID();
	const programId = randomUUID();
	const start = new Date(Date.now() + 60_000);
	const stop = new Date(start.getTime() + 30 * 60_000);
	programs.put({ id: programId, epgChannelId, start, stop, title: "Show" });
	map.put(channelId, epgChannelId);

	const service = new RecordingsService({
		repository: repo as never,
		scheduler,
		allocator: new TunerAllocator({ capacity: async () => 1 }),
		resolver: { resolve: async () => never() },
		config: staticConfig(tmp, 0, 0),
		epgPrograms: programs as never,
		channelEpgMap: map as never,
		bus
	});

	const { recording: created } = await service.scheduleByProgram({ programId });
	const originalJobId = created.schedulerJobId;

	const result = await service.reconcileProgramSchedules();
	assert.equal(result.rescheduled, 0);

	// The job and times remain untouched.
	const after = await repo.getById(created.id);
	assert.equal(after?.schedulerJobId, originalJobId);
	assert.equal(after?.scheduledStart.getTime(), start.getTime());

	await rm(tmp, { recursive: true, force: true });
});

test(
	"Integration: short recording against a synthetic source completes and writes a playable file",
	{ skip: !ffmpegAvailable && "ffmpeg not installed" },
	async (t) => {
		if (!ffmpegHasMatroska()) {
			t.skip("ffmpeg lacks matroska support");
			return;
		}
		const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-int-"));
		t.after(async () => {
			await rm(tmp, { recursive: true, force: true });
		});

		const bus = new EventBus();
		const events = captureEvents(bus);
		const jobsRepo = new InMemoryJobsRepo();
		const repo = new FakeRecordingsRepo(jobsRepo);
		const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();

		const resolver = {
			resolve: async (): Promise<ResolvedStreamSource> => ({
				providerId,
				providerChannelId: "synthetic",
				upstreamUrl: "testsrc2=size=160x120:rate=10"
			})
		};

		const service = new RecordingsService({
			repository: repo as never,
			scheduler,
			allocator,
			resolver,
			config: staticConfig(tmp),
			bus,
			// testsrc2 is a lavfi filtergraph, not a file URL — inject `-f
			// lavfi` before `-i` so ffmpeg parses it as a graph. The generated
			// raw frames also can't be `-c copy`'d into matroska, so we swap
			// to libx264 + AAC for this test.
			runner: {
				spawn: (args: string[]) => {
					const inputIdx = args.indexOf("-i");
					const enriched = [
						...args.slice(0, inputIdx),
						"-f",
						"lavfi",
						...args.slice(inputIdx)
					];
					const cIdx = enriched.indexOf("-c");
					if (cIdx !== -1 && enriched[cIdx + 1] === "copy") {
						enriched.splice(
							cIdx,
							2,
							"-c:v",
							"libx264",
							"-preset",
							"ultrafast",
							"-pix_fmt",
							"yuv420p"
						);
					}

					return nodeSpawn("ffmpeg", enriched, {
						stdio: ["ignore", "ignore", "pipe"]
					});
				}
			}
		});

		await scheduler.start();
		t.after(async () => {
			await scheduler.shutdown(2_000);
		});

		const now = Date.now();
		const created = await service.schedule({
			channelId: randomUUID(),
			title: "Integration Test/Show", // intentionally with a `/` to test sanitization
			start: new Date(now + 100), // fire almost immediately
			end: new Date(now + 3_100) // 3 seconds long
		});

		// Wait for terminal status (with a generous cap so flaky CI doesn't
		// hang forever).
		const final = await waitForStatus(
			() => repo.getById(created.id),
			["completed", "failed", "cancelled"],
			15_000
		);
		assert.equal(final.status, "completed", final.errorMessage ?? "");
		assert.ok(final.filePath, "file path should be set");
		assert.ok((final.fileSize ?? 0) > 0, "file should not be empty");

		const stats = await stat(final.filePath as string);
		assert.ok(stats.size > 0);

		// File must start with the matroska EBML header (0x1a 0x45 0xdf 0xa3).
		const head = await readFile(final.filePath as string, {
			encoding: null
		});
		assert.equal(head[0], 0x1a);
		assert.equal(head[1], 0x45);
		assert.equal(head[2], 0xdf);
		assert.equal(head[3], 0xa3);

		// Filename uses the safe-title and ISO start (no ':' on disk).
		assert.match(final.filePath as string, /Integration Test_Show-/);
		assert.doesNotMatch(final.filePath as string, /:/);

		// Tuner lease was released.
		assert.equal(allocator.getActivity().length, 0);

		// We saw scheduled -> started -> completed events in that order.
		const order = events
			.map((e) => e.event)
			.filter((e) =>
				[
					RECORDING_EVENT.scheduled,
					RECORDING_EVENT.started,
					RECORDING_EVENT.completed
				].includes(
					e as
						| typeof RECORDING_EVENT.scheduled
						| typeof RECORDING_EVENT.started
						| typeof RECORDING_EVENT.completed
				)
			);
		assert.deepEqual(order, [
			RECORDING_EVENT.scheduled,
			RECORDING_EVENT.started,
			RECORDING_EVENT.completed
		]);
	}
);

test(
	"Integration: cancel mid-recording transitions to cancelled and stops ffmpeg",
	{ skip: !ffmpegAvailable && "ffmpeg not installed" },
	async (t) => {
		if (!ffmpegHasMatroska()) {
			t.skip("ffmpeg lacks matroska support");
			return;
		}
		const tmp = await mkdtemp(join(tmpdir(), "signalhaven-rec-cancel-"));
		t.after(async () => {
			await rm(tmp, { recursive: true, force: true });
		});

		const bus = new EventBus();
		const events = captureEvents(bus);
		const jobsRepo = new InMemoryJobsRepo();
		const repo = new FakeRecordingsRepo(jobsRepo);
		const scheduler = new Scheduler({ bus, jobsRepository: jobsRepo as never });
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();

		const service = new RecordingsService({
			repository: repo as never,
			scheduler,
			allocator,
			resolver: {
				resolve: async (): Promise<ResolvedStreamSource> => ({
					providerId,
					providerChannelId: "synthetic",
					upstreamUrl: "testsrc2=size=160x120:rate=10"
				})
			},
			config: staticConfig(tmp),
			bus,
			runner: {
				spawn: (args: string[]) => {
					const inputIdx = args.indexOf("-i");
					const enriched = [
						...args.slice(0, inputIdx),
						"-f",
						"lavfi",
						...args.slice(inputIdx)
					];
					const cIdx = enriched.indexOf("-c");
					if (cIdx !== -1 && enriched[cIdx + 1] === "copy") {
						enriched.splice(
							cIdx,
							2,
							"-c:v",
							"libx264",
							"-preset",
							"ultrafast",
							"-pix_fmt",
							"yuv420p"
						);
					}

					return nodeSpawn("ffmpeg", enriched, {
						stdio: ["ignore", "ignore", "pipe"]
					});
				}
			}
		});

		await scheduler.start();
		t.after(async () => {
			await scheduler.shutdown(2_000);
		});

		const created = await service.schedule({
			channelId: randomUUID(),
			title: "Long Recording",
			start: new Date(Date.now() + 50),
			end: new Date(Date.now() + 60_000) // a full minute
		});

		// Wait until the row has actually flipped to `recording` so we know
		// ffmpeg is alive.
		await waitForStatus(() => repo.getById(created.id), ["recording"], 10_000);

		await service.cancel(created.id);

		const final = await waitForStatus(
			() => repo.getById(created.id),
			["cancelled", "failed", "completed"],
			10_000
		);
		assert.equal(final.status, "cancelled");
		assert.equal(allocator.getActivity().length, 0);
		assert.ok(events.some((e) => e.event === RECORDING_EVENT.cancelled));
	}
);

/** Polls the row until it lands in one of `accepted` or rejects on timeout. */
async function waitForStatus(
	load: () => Promise<RecordingRecord | null>,
	accepted: string[],
	timeoutMs: number
): Promise<RecordingRecord> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const row = await load();
		if (row && accepted.includes(row.status)) {
			return row;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	const row = await load();
	throw new Error(
		`timed out waiting for status in [${accepted.join(",")}]; current=${row?.status}`
	);
}

function never(): never {
	throw new Error("resolver should not be called for this test");
}

/** In-memory implementation of `ScheduledJobsRepository` mimic. */
class InMemoryJobsRepo {
	readonly rows = new Map<
		string,
		{
			id: string;
			kind: string;
			payload: Record<string, unknown>;
			runAt: Date;
			status: string;
			attempts: number;
			maxAttempts: number;
			lastError: string | null;
			lockedAt: Date | null;
			createdAt: Date;
			updatedAt: Date;
		}
	>();

	async create(input: {
		id?: string;
		kind: string;
		runAt: Date;
		payload?: Record<string, unknown>;
		maxAttempts?: number;
	}) {
		const now = new Date();
		const row = {
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
	async getById(id: string) {
		return this.rows.get(id) ?? null;
	}
	async listDue(now: Date) {
		return [...this.rows.values()]
			.filter(
				(r) => r.status === "pending" && r.runAt.getTime() <= now.getTime()
			)
			.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
	}
	async findNextPendingRunAt() {
		let earliest: Date | null = null;
		for (const r of this.rows.values()) {
			if (r.status !== "pending") continue;
			if (!earliest || r.runAt < earliest) earliest = r.runAt;
		}
		return earliest;
	}
	async claim(id: string, now: Date) {
		const row = this.rows.get(id);
		if (!row || row.status !== "pending") return null;
		row.status = "running";
		row.lockedAt = now;
		row.updatedAt = now;
		return { ...row };
	}
	async markCompleted(id: string) {
		const row = this.rows.get(id);
		if (row?.status === "running") {
			row.status = "completed";
			row.lockedAt = null;
			row.updatedAt = new Date();
			return true;
		}
		return false;
	}
	async markFailed(id: string, error: string, attempts: number) {
		const row = this.rows.get(id);
		if (row?.status === "running") {
			row.status = "failed";
			row.lastError = error;
			row.attempts = attempts;
			row.lockedAt = null;
			row.updatedAt = new Date();
			return true;
		}
		return false;
	}
	async reschedule(id: string, runAt: Date, error: string, attempts: number) {
		const row = this.rows.get(id);
		if (row?.status === "running") {
			row.status = "pending";
			row.runAt = runAt;
			row.lastError = error;
			row.attempts = attempts;
			row.lockedAt = null;
			row.updatedAt = new Date();
			return true;
		}
		return false;
	}
	async cancel(id: string) {
		const row = this.rows.get(id);
		if (!row || (row.status !== "pending" && row.status !== "running")) {
			return false;
		}
		row.status = "cancelled";
		row.updatedAt = new Date();
		return true;
	}
	async recoverStuckRunning() {
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
