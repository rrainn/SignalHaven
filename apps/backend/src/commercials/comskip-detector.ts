import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { basename, extname, join } from "node:path";

import type { CommercialMarker } from "@signalhaven/shared";

/** Pluggable detector input kept independent from persistence and the player. */
export interface CommercialDetectorInput {
	recordingPath: string;
	durationSeconds: number;
	workingDirectory: string;
	signal: AbortSignal;
}

/** Detector boundary lets tests and future engines return the same markers. */
export interface CommercialDetector {
	detect(input: CommercialDetectorInput): Promise<CommercialMarker[]>;
}

export type CommercialDetectorRunner = (
	executable: string,
	args: readonly string[],
	options: { signal: AbortSignal }
) => Promise<void>;

/** Execute Comskip and parse the generated EDL without retaining raw output. */
export class ComskipDetector implements CommercialDetector {
	constructor(
		private readonly executable: string,
		private readonly runner: CommercialDetectorRunner = runProcess
	) {}

	async detect(input: CommercialDetectorInput): Promise<CommercialMarker[]> {
		const outputName = basename(
			input.recordingPath,
			extname(input.recordingPath)
		);
		await this.runner(
			this.executable,
			[
				`--output=${input.workingDirectory}`,
				`--output-filename=${outputName}`,
				input.recordingPath
			],
			{ signal: input.signal }
		);
		const files = await readdir(input.workingDirectory);
		const edlName = files.find((file) => file.toLowerCase().endsWith(".edl"));
		if (!edlName) {
			throw new Error(
				"Comskip did not produce an EDL file; enable output_edl in comskip.ini"
			);
		}
		const output = await readFile(
			join(input.workingDirectory, edlName),
			"utf8"
		);
		return parseComskipEdl(output, input.durationSeconds);
	}
}

/**
 * Convert Comskip EDL seconds into validated integer milliseconds. Invalid
 * lines are ignored, boundaries are clamped, and touching/overlapping output
 * is merged so the player never receives ambiguous regions.
 */
export function parseComskipEdl(
	output: string,
	durationSeconds: number
): CommercialMarker[] {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
	const candidates: CommercialMarker[] = [];
	for (const line of output.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 2) continue;
		const startSeconds = Number(fields[0]);
		const endSeconds = Number(fields[1]);
		if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
			continue;
		}
		candidates.push({
			startMs: Math.round(startSeconds * 1_000),
			endMs: Math.round(endSeconds * 1_000)
		});
	}
	return normalizeCommercialMarkers(candidates, durationSeconds);
}

/** Enforce the common marker contract for every current or future detector. */
export function normalizeCommercialMarkers(
	markers: readonly CommercialMarker[],
	durationSeconds: number
): CommercialMarker[] {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
	const durationMs = Math.round(durationSeconds * 1_000);
	const candidates = markers.flatMap((marker) => {
		if (!Number.isFinite(marker.startMs) || !Number.isFinite(marker.endMs)) {
			return [];
		}
		const startMs = Math.max(
			0,
			Math.min(durationMs, Math.round(marker.startMs))
		);
		const endMs = Math.max(0, Math.min(durationMs, Math.round(marker.endMs)));
		return endMs > startMs ? [{ startMs, endMs }] : [];
	});
	candidates.sort(
		(left, right) => left.startMs - right.startMs || left.endMs - right.endMs
	);

	const normalized: CommercialMarker[] = [];
	for (const marker of candidates) {
		const previous = normalized[normalized.length - 1];
		if (previous && marker.startMs <= previous.endMs) {
			previous.endMs = Math.max(previous.endMs, marker.endMs);
			continue;
		}
		normalized.push({ ...marker });
	}
	return normalized;
}

/** Spawn a detector process with bounded captured diagnostics. */
async function runProcess(
	executable: string,
	args: readonly string[],
	options: { signal: AbortSignal }
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, [...args], {
			stdio: ["ignore", "ignore", "pipe"]
		});
		// A positive niceness keeps live recording/transcoding responsive while
		// this optional CPU-heavy background process is running.
		if (child.pid !== undefined) {
			try {
				setPriority(child.pid, 10);
			} catch {
				// Some platforms or containers disallow reprioritization; concurrency
				// remains capped by the scheduler in that case.
			}
		}
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
		});
		const abort = () => child.kill("SIGTERM");
		options.signal.addEventListener("abort", abort, { once: true });
		child.once("error", reject);
		child.once("close", (code, signal) => {
			options.signal.removeEventListener("abort", abort);
			if (options.signal.aborted) {
				reject(new Error("Commercial analysis was cancelled"));
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`Comskip exited ${code ?? signal ?? "unexpectedly"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
				)
			);
		});
	});
}
