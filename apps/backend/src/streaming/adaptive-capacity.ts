import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HwaccelKind } from "@signalhaven/shared";

import { buildAdaptiveFfmpegArgs } from "./transcoder";

const CAPACITY_MEDIA_SECONDS = 6;
const CAPACITY_TIMEOUT_MS = 15_000;
const cachedChecks = new Map<string, Promise<AdaptiveCapacityResult>>();

export interface AdaptiveCapacityResult {
	passed: boolean;
	speed: number;
}

/** Benchmark the complete configured ladder once per encoder backend. */
export function checkAdaptiveCapacity(
	hwaccel: HwaccelKind | null
): Promise<AdaptiveCapacityResult> {
	const key = hwaccel ?? "software";
	const existing = cachedChecks.get(key);
	if (existing) return existing;
	const pending = runCapacityCheck(hwaccel).catch(() => ({
		passed: false,
		speed: 0
	}));
	cachedChecks.set(key, pending);
	return pending;
}

async function runCapacityCheck(
	hwaccel: HwaccelKind | null
): Promise<AdaptiveCapacityResult> {
	const root = await mkdtemp(join(tmpdir(), "signalhaven-capacity-"));
	try {
		for (const rendition of ["1080p", "720p", "480p"]) {
			await mkdir(join(root, rendition), { recursive: true });
		}
		const input =
			"testsrc2=size=1920x1080:rate=30[out0];sine=frequency=1000:sample_rate=48000[out1]";
		const args = buildAdaptiveFfmpegArgs({
			input,
			outDir: root,
			hwaccel,
			input_codecs: { width: 1920, height: 1080 },
			outputMode: "vod"
		});
		const inputIndex = args.indexOf("-i");
		args.splice(inputIndex, 0, "-f", "lavfi");
		const outputIndex = args.indexOf("-f", inputIndex + 3);
		args.splice(outputIndex, 0, "-t", String(CAPACITY_MEDIA_SECONDS));

		const startedAt = performance.now();
		const passedProcess = await runFfmpeg(args);
		const elapsedSeconds = (performance.now() - startedAt) / 1_000;
		const speed = passedProcess ? CAPACITY_MEDIA_SECONDS / elapsedSeconds : 0;
		return { passed: passedProcess && speed >= 1.25, speed };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Run the bounded synthetic graph without inheriting terminal handles. */
function runFfmpeg(args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("ffmpeg", args, { stdio: "ignore" });
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(false);
		}, CAPACITY_TIMEOUT_MS);
		timeout.unref?.();
		child.once("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolve(code === 0);
		});
	});
}
