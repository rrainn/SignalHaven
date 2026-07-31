import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ComskipDetector,
	DEFAULT_COMSKIP_CONFIG_PATH,
	DEFAULT_COMSKIP_PATH,
	parseComskipEdl,
	resolveComskipPath
} from "../src/commercials/comskip-detector";
import {
	CommercialAnalysisService,
	COMMERCIAL_ANALYSIS_JOB_KIND
} from "../src/commercials/commercial-analysis.service";
import type { CommercialAnalysisRecord } from "../src/repositories/commercials.repository";
import type { RecordingRecord } from "../src/repositories/recordings.repository";
import type { JobContext, JobHandler } from "../src/scheduler/scheduler";

test("parseComskipEdl normalizes ordered, bounded, non-overlapping intervals", () => {
	const markers = parseComskipEdl(
		[
			"90.25 110.5 0",
			"-5 4 0",
			"3.5 10 0",
			"9 15 0",
			"70 75 0",
			"74.5 80 0",
			"119 140 0"
		].join("\n"),
		120
	);

	assert.deepEqual(markers, [
		{ startMs: 0, endMs: 15_000 },
		{ startMs: 70_000, endMs: 80_000 },
		{ startMs: 90_250, endMs: 110_500 },
		{ startMs: 119_000, endMs: 120_000 }
	]);
});

test("parseComskipEdl ignores empty, malformed, and zero-length output", () => {
	const markers = parseComskipEdl(
		["", "garbage", "10 nope 0", "20 20 0", "30 25 0", "Infinity 40 0"].join(
			"\n"
		),
		60
	);

	assert.deepEqual(markers, []);
});

test("parseComskipEdl treats adjacent intervals as one commercial", () => {
	assert.deepEqual(parseComskipEdl("1 2 0\n2 3 0\n3.001 4 0", 10), [
		{ startMs: 1_000, endMs: 3_000 },
		{ startMs: 3_001, endMs: 4_000 }
	]);
});

test("resolveComskipPath uses the bundled executable unless the environment overrides it", () => {
	assert.equal(resolveComskipPath({}), DEFAULT_COMSKIP_PATH);
	assert.equal(
		resolveComskipPath({
			SIGNALHAVEN_COMSKIP_PATH: "/opt/comskip/bin/comskip"
		}),
		"/opt/comskip/bin/comskip"
	);
	assert.equal(
		resolveComskipPath({ SIGNALHAVEN_COMSKIP_PATH: "   " }),
		DEFAULT_COMSKIP_PATH
	);
});

test("ComskipDetector explicitly uses the bundled EDL configuration", async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), "signalhaven-test-"));
	try {
		const detector = new ComskipDetector(
			"/custom/comskip",
			async (executable, args) => {
				assert.equal(executable, "/custom/comskip");
				assert.equal(args[0], `--ini=${DEFAULT_COMSKIP_CONFIG_PATH}`);
				await writeFile(join(workingDirectory, "show.edl"), "1 2 0", "utf8");
			}
		);

		const markers = await detector.detect({
			recordingPath: "/recordings/show.ts",
			durationSeconds: 60,
			workingDirectory,
			signal: new AbortController().signal
		});

		assert.deepEqual(markers, [{ startMs: 1_000, endMs: 2_000 }]);
	} finally {
		await rm(workingDirectory, { recursive: true, force: true });
	}
});

test("detector failure is persisted without changing a completed recording", async () => {
	const recording = completedRecording();
	const repository = new FakeCommercialsRepository();
	const scheduler = new FakeScheduler();
	const service = new CommercialAnalysisService({
		repository,
		recordings: { getById: async () => recording },
		scheduler,
		resolveConfig: async () => ({
			enabled: true,
			executablePath: "/usr/bin/comskip",
			detectorVersion: "test-v1"
		}),
		createDetector: () => ({
			detect: async () => {
				throw new Error(`${recording.filePath} produced malformed output`);
			}
		})
	});

	assert.equal(await service.enqueueCompleted(recording), true);
	await scheduler.run(recording.id);

	assert.equal(recording.status, "completed");
	assert.equal(repository.analysis?.status, "failed");
	assert.doesNotMatch(
		repository.analysis?.diagnosticMessage ?? "",
		/recordings\/show/
	);
});

test("concurrent manual retries create only one active detector job", async () => {
	const recording = completedRecording();
	const repository = new FakeCommercialsRepository();
	repository.analysis = analysisRecord(recording.id, "failed");
	const scheduler = new FakeScheduler();
	const service = new CommercialAnalysisService({
		repository,
		recordings: { getById: async () => recording },
		scheduler,
		resolveConfig: async () => ({
			enabled: true,
			executablePath: "/usr/bin/comskip",
			detectorVersion: "test-v1"
		})
	});

	await Promise.all([service.retry(recording.id), service.retry(recording.id)]);

	assert.equal(repository.jobsCreated, 1);
	assert.equal(repository.analysis?.status, "queued");
});

test("active work is visible only while Comskip is running", async () => {
	const recording = completedRecording();
	const repository = new FakeCommercialsRepository();
	const scheduler = new FakeScheduler();
	let finishDetection: (() => void) | undefined;
	const detectionFinished = new Promise<void>((resolve) => {
		finishDetection = resolve;
	});
	let detectionStarted: (() => void) | undefined;
	const detectorStarted = new Promise<void>((resolve) => {
		detectionStarted = resolve;
	});
	const service = new CommercialAnalysisService({
		repository,
		recordings: { getById: async () => recording },
		scheduler,
		resolveConfig: async () => ({
			enabled: true,
			executablePath: "/usr/bin/comskip",
			detectorVersion: "test-v1"
		}),
		createDetector: () => ({
			detect: async () => {
				detectionStarted?.();
				await detectionFinished;
				return [];
			}
		})
	});

	await service.enqueueCompleted(recording);
	const running = scheduler.run(recording.id);
	await detectorStarted;

	assert.deepEqual(service.getActiveWork(), [
		{
			recordingId: recording.id,
			label: recording.title,
			state: "running",
			startedAt: new Date(0).toISOString()
		}
	]);

	finishDetection?.();
	await running;
	assert.deepEqual(service.getActiveWork(), []);
});

class FakeScheduler {
	handler: JobHandler | null = null;

	registerOneOffHandler(kind: string, handler: JobHandler): void {
		assert.equal(kind, COMMERCIAL_ANALYSIS_JOB_KIND);
		this.handler = handler;
	}

	async schedulePersistedOneOff<T>(persist: () => Promise<T>): Promise<T> {
		return persist();
	}

	async cancelOneOff(): Promise<boolean> {
		return true;
	}

	async run(recordingId: string): Promise<void> {
		assert.ok(this.handler);
		const context: JobContext = {
			id: "job-1",
			kind: COMMERCIAL_ANALYSIS_JOB_KIND,
			attempt: 1,
			maxAttempts: 1,
			nextRetryAt: null,
			payload: { recordingId },
			signal: new AbortController().signal
		};
		await this.handler(context);
	}
}

class FakeCommercialsRepository {
	analysis: CommercialAnalysisRecord | null = null;
	jobsCreated = 0;

	async get() {
		return { analysis: this.analysis, markers: [] };
	}

	async enqueue(recordingId: string, detectorVersion: string) {
		if (
			this.analysis?.status === "queued" ||
			this.analysis?.status === "running"
		) {
			return { analysis: this.analysis, created: false };
		}
		this.jobsCreated += 1;
		this.analysis = {
			...analysisRecord(recordingId, "queued"),
			detectorVersion
		};
		return { analysis: this.analysis, created: true };
	}

	async markRunning(recordingId: string) {
		if (!this.analysis) return null;
		this.analysis = {
			...analysisRecord(recordingId, "running"),
			startedAt: new Date(0)
		};
		return this.analysis;
	}

	async complete(): Promise<void> {
		if (this.analysis) this.analysis.status = "completed";
	}

	async fail(_recordingId: string, diagnosticMessage: string): Promise<void> {
		if (!this.analysis) return;
		this.analysis.status = "failed";
		this.analysis.diagnosticMessage = diagnosticMessage;
	}

	async listCompletedRecordingIds(): Promise<string[]> {
		return [];
	}
}

function analysisRecord(
	recordingId: string,
	status: CommercialAnalysisRecord["status"]
): CommercialAnalysisRecord {
	return {
		recordingId,
		status,
		scheduledJobId: "job-1",
		detectorVersion: "test-v1:/usr/bin/comskip",
		queuedAt: new Date(),
		startedAt: null,
		completedAt: null,
		failedAt: null,
		diagnosticMessage: null
	};
}

function completedRecording(): RecordingRecord {
	const now = new Date("2026-01-01T00:00:00Z");
	return {
		id: "11111111-1111-4111-8111-111111111111",
		channelId: "22222222-2222-4222-8222-222222222222",
		programId: null,
		title: "Show",
		status: "completed",
		scheduledStart: now,
		scheduledEnd: new Date(now.getTime() + 120_000),
		actualStart: now,
		actualEnd: new Date(now.getTime() + 120_000),
		startReason: null,
		filePath: "/recordings/show.ts",
		fileSize: 1_000,
		durationSeconds: 120,
		errorMessage: null,
		schedulerJobId: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		createdAt: now,
		updatedAt: now
	};
}
