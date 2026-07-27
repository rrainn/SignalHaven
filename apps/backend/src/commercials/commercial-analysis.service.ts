import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommercialAnalysis } from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import type {
	RecordingRecord,
	RecordingsRepository
} from "../repositories/recordings.repository";
import type {
	CommercialAnalysisDetail,
	CommercialAnalysisRecord,
	CommercialsRepository
} from "../repositories/commercials.repository";
import type { JobContext, Scheduler } from "../scheduler/scheduler";
import {
	ComskipDetector,
	normalizeCommercialMarkers,
	type CommercialDetector
} from "./comskip-detector";

/** Commercial detector work is serialized separately from recording jobs. */
export const COMMERCIAL_ANALYSIS_JOB_KIND = "commercial-analysis";

export interface CommercialAnalysisConfig {
	enabled: boolean;
	detectorPath: string | null;
	detectorVersion: string;
}

export interface CommercialAnalysisServiceOptions {
	repository: Pick<
		CommercialsRepository,
		| "get"
		| "enqueue"
		| "markRunning"
		| "complete"
		| "fail"
		| "listCompletedRecordingIds"
	>;
	recordings: Pick<RecordingsRepository, "getById">;
	scheduler: Pick<
		Scheduler,
		"registerOneOffHandler" | "schedulePersistedOneOff" | "cancelOneOff"
	>;
	resolveConfig: () => Promise<CommercialAnalysisConfig>;
	bus?: EventBus;
	/** Test seam for a hermetic detector implementation. */
	createDetector?: (executable: string) => CommercialDetector;
}

export class CommercialAnalysisNotAvailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommercialAnalysisNotAvailableError";
	}
}

/** Coordinates idempotent scheduling, detector execution, and cleanup. */
export class CommercialAnalysisService {
	private readonly repository: CommercialAnalysisServiceOptions["repository"];
	private readonly recordings: CommercialAnalysisServiceOptions["recordings"];
	private readonly scheduler: CommercialAnalysisServiceOptions["scheduler"];
	private readonly resolveConfig: () => Promise<CommercialAnalysisConfig>;
	private readonly bus: EventBus | undefined;
	private readonly createDetector: (executable: string) => CommercialDetector;

	constructor(options: CommercialAnalysisServiceOptions) {
		this.repository = options.repository;
		this.recordings = options.recordings;
		this.scheduler = options.scheduler;
		this.resolveConfig = options.resolveConfig;
		this.bus = options.bus;
		this.createDetector =
			options.createDetector ?? ((path) => new ComskipDetector(path));
		this.scheduler.registerOneOffHandler(
			COMMERCIAL_ANALYSIS_JOB_KIND,
			(context) => this.run(context)
		);
	}

	/** Return the stable API shape even when analysis was never requested. */
	async get(recordingId: string): Promise<CommercialAnalysis> {
		return toPublicAnalysis(await this.repository.get(recordingId));
	}

	/** Queue completed media once unless settings or detector version changed. */
	async enqueueCompleted(
		recording: RecordingRecord,
		force = false
	): Promise<boolean> {
		if (recording.status !== "completed") return false;
		const config = await this.resolveConfig();
		if (!config.enabled || !config.detectorPath) {
			if (force) {
				throw new CommercialAnalysisNotAvailableError(
					"Commercial detection is disabled or its executable path is not configured"
				);
			}
			return false;
		}
		if (!recording.filePath || !recording.durationSeconds) {
			if (force) {
				throw new CommercialAnalysisNotAvailableError(
					"The recording has no playable file or known duration"
				);
			}
			return false;
		}
		const versionKey = configurationVersion(config);
		const result = await this.scheduler.schedulePersistedOneOff(() =>
			this.repository.enqueue(
				recording.id,
				versionKey,
				COMMERCIAL_ANALYSIS_JOB_KIND,
				force
			)
		);
		if (result.created)
			this.publish("commercial.analysis.queued", recording.id);
		return result.created;
	}

	/** Explicit user retry; active work remains idempotently owned. */
	async retry(recordingId: string): Promise<CommercialAnalysis> {
		const recording = await this.recordings.getById(recordingId);
		if (!recording)
			throw new CommercialAnalysisNotAvailableError("Recording not found");
		await this.enqueueCompleted(recording, true);
		return this.get(recordingId);
	}

	/** Reconsider completed rows after restart or a detector configuration change. */
	async reconcileCompleted(): Promise<void> {
		const config = await this.resolveConfig();
		if (!config.enabled || !config.detectorPath) return;
		for (const recordingId of await this.repository.listCompletedRecordingIds()) {
			const recording = await this.recordings.getById(recordingId);
			if (recording) await this.enqueueCompleted(recording);
		}
	}

	/** Stop pending/running detector ownership before the recording is deleted. */
	async cancel(recordingId: string): Promise<void> {
		const { analysis } = await this.repository.get(recordingId);
		if (analysis?.scheduledJobId) {
			await this.scheduler.cancelOneOff(analysis.scheduledJobId);
		}
	}

	private async run(context: JobContext): Promise<void> {
		const recordingId = String(context.payload["recordingId"] ?? "");
		if (!recordingId) return;
		const analysis = await this.repository.markRunning(recordingId);
		if (!analysis) return;
		this.publish("commercial.analysis.running", recordingId);

		const recording = await this.recordings.getById(recordingId);
		if (
			!recording ||
			recording.status !== "completed" ||
			!recording.filePath ||
			!recording.durationSeconds
		) {
			await this.fail(
				recordingId,
				"The completed recording file is no longer available"
			);
			return;
		}
		const config = await this.resolveConfig();
		if (!config.enabled || !config.detectorPath) {
			await this.fail(
				recordingId,
				"Commercial detection was disabled before analysis began"
			);
			return;
		}

		const workingDirectory = await mkdtemp(
			join(tmpdir(), "signalhaven-commercials-")
		);
		try {
			const detector = this.createDetector(config.detectorPath);
			const detectorMarkers = await detector.detect({
				recordingPath: recording.filePath,
				durationSeconds: recording.durationSeconds,
				workingDirectory,
				signal: context.signal
			});
			const markers = normalizeCommercialMarkers(
				detectorMarkers,
				recording.durationSeconds
			);
			await this.repository.complete(recordingId, markers);
			this.publish("commercial.analysis.completed", recordingId);
		} catch (error) {
			await this.fail(
				recordingId,
				publicDiagnostic(error, recording.filePath, config.detectorPath)
			);
		} finally {
			// Raw Comskip files are disposable; normalized DB markers are authoritative.
			await rm(workingDirectory, { recursive: true, force: true }).catch(
				() => undefined
			);
		}
	}

	private async fail(recordingId: string, message: string): Promise<void> {
		await this.repository.fail(recordingId, message);
		this.publish("commercial.analysis.failed", recordingId);
	}

	private publish(event: string, recordingId: string): void {
		this.bus?.publish({ topic: "recordings", event, data: { recordingId } });
	}
}

/** Include the configured version and executable so either change regenerates markers. */
function configurationVersion(config: CommercialAnalysisConfig): string {
	const executableHash = createHash("sha256")
		.update(config.detectorPath ?? "")
		.digest("hex")
		.slice(0, 12);
	return `${config.detectorVersion}:${executableHash}`;
}

/** Keep diagnostics useful without exposing a recording's filesystem path. */
function publicDiagnostic(
	error: unknown,
	recordingPath: string,
	detectorPath: string
): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.split(recordingPath)
		.join("the recording file")
		.split(detectorPath)
		.join("the detector executable")
		.slice(0, 500);
}

/** Map nullable persistence into the explicit not-requested API state. */
function toPublicAnalysis(
	detail: CommercialAnalysisDetail
): CommercialAnalysis {
	const analysis: CommercialAnalysisRecord | null = detail.analysis;
	if (!analysis) {
		return {
			status: "not_requested",
			queuedAt: null,
			startedAt: null,
			completedAt: null,
			failedAt: null,
			diagnosticMessage: null,
			detectorVersion: null,
			markers: []
		};
	}
	return {
		status: analysis.status,
		queuedAt: analysis.queuedAt?.toISOString() ?? null,
		startedAt: analysis.startedAt?.toISOString() ?? null,
		completedAt: analysis.completedAt?.toISOString() ?? null,
		failedAt: analysis.failedAt?.toISOString() ?? null,
		diagnosticMessage: analysis.diagnosticMessage,
		detectorVersion: analysis.detectorVersion,
		markers: detail.markers
	};
}
