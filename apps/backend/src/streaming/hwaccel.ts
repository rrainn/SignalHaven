import { spawn } from "node:child_process";

import type { HwaccelKind } from "@signalhaven/shared";

/**
 * Maximum time allowed for any FFmpeg capability subprocess.
 *
 * NVIDIA driver initialization can take roughly ten seconds on an otherwise
 * healthy host, so keep enough headroom to distinguish a slow first context
 * from a genuinely stuck probe.
 */
const PROBE_TIMEOUT_MS = 20_000;

/** Keep failed FFmpeg probes from consuming unbounded process memory. */
const MAX_PROBE_OUTPUT_CHARS = 64 * 1024;

/** Maximum sanitized diagnostic text included in an operator warning. */
const MAX_DIAGNOSTIC_CHARS = 500;

/** Observable result from one bounded FFmpeg capability subprocess. */
export interface HwaccelProbeResult {
	/** Combined stdout and stderr, bounded by the runner. */
	output: string;
	/** FFmpeg's exit status, or null when it was terminated by a signal. */
	exitCode: number | null;
	/** Whether SignalHaven terminated FFmpeg after the capability timeout. */
	timedOut: boolean;
}

/** Inversion-of-control hook for tests; defaults to spawning real FFmpeg. */
export interface HwaccelProbeRunner {
	/**
	 * Run `ffmpeg <args>` with the backend process identity and permissions.
	 *
	 * Return `null` only when the binary cannot be spawned. A non-zero exit
	 * remains a result so detection can surface useful, sanitized context.
	 */
	run(args: readonly string[]): Promise<HwaccelProbeResult | null>;
}

/** Narrow logging boundary used to report excluded hardware candidates. */
export interface HwaccelProbeLogger {
	/** Emit sanitized context suitable for an operator-facing backend log. */
	warn(message: string): void;
}

const DEFAULT_LOGGER: HwaccelProbeLogger = {
	warn: (message) => console.warn(message)
};

const DEFAULT_RUNNER: HwaccelProbeRunner = {
	run: (args) =>
		new Promise<HwaccelProbeResult | null>((resolve) => {
			let child;
			try {
				// Inheriting the current process identity ensures this checks the
				// same effective device permissions used by normal transcodes.
				child = spawn("ffmpeg", args, {
					stdio: ["ignore", "pipe", "pipe"]
				});
			} catch {
				resolve(null);
				return;
			}

			let output = "";
			let timedOut = false;
			let settled = false;
			const appendOutput = (chunk: Buffer | string): void => {
				// Retain the tail because FFmpeg normally prints the root cause last.
				output = (output + chunk.toString()).slice(-MAX_PROBE_OUTPUT_CHARS);
			};
			const finish = (result: HwaccelProbeResult | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// Resolving below still bounds startup when the process already exited.
				}
				finish({ output, exitCode: null, timedOut: true });
			}, PROBE_TIMEOUT_MS);

			child.stdout?.on("data", appendOutput);
			child.stderr?.on("data", appendOutput);
			child.once("error", (error) => {
				appendOutput(error instanceof Error ? error.message : String(error));
				finish(null);
			});
			child.once("close", (exitCode) => {
				finish({ output, exitCode, timedOut });
			});
		})
};

interface Candidate {
	kind: HwaccelKind;
	/** Tokens that must appear in `ffmpeg -hwaccels` output. */
	hwaccelTokens: string[];
	/** Tokens that must appear in `ffmpeg -encoders` output. */
	encoderTokens: string[];
	/** Encode one synthetic frame while initializing this backend's device. */
	probeArgs: string[];
}

const SYNTHETIC_INPUT_ARGS = [
	"-f",
	"lavfi",
	"-i",
	"color=size=128x128:rate=1:color=black"
];
const SYNTHETIC_OUTPUT_ARGS = ["-frames:v", "1", "-an", "-f", "null", "-"];

const CANDIDATES: Candidate[] = [
	{
		kind: "videotoolbox",
		hwaccelTokens: ["videotoolbox"],
		encoderTokens: ["h264_videotoolbox"],
		probeArgs: [
			...SYNTHETIC_INPUT_ARGS,
			"-c:v",
			"h264_videotoolbox",
			...SYNTHETIC_OUTPUT_ARGS
		]
	},
	{
		kind: "vaapi",
		hwaccelTokens: ["vaapi"],
		encoderTokens: ["h264_vaapi"],
		probeArgs: [
			"-vaapi_device",
			"/dev/dri/renderD128",
			...SYNTHETIC_INPUT_ARGS,
			"-vf",
			"format=nv12,hwupload",
			"-c:v",
			"h264_vaapi",
			...SYNTHETIC_OUTPUT_ARGS
		]
	},
	{
		kind: "qsv",
		hwaccelTokens: ["qsv"],
		encoderTokens: ["h264_qsv"],
		probeArgs: [
			"-init_hw_device",
			"qsv=signalhaven_qsv",
			"-filter_hw_device",
			"signalhaven_qsv",
			...SYNTHETIC_INPUT_ARGS,
			"-vf",
			"format=nv12,hwupload",
			"-c:v",
			"h264_qsv",
			...SYNTHETIC_OUTPUT_ARGS
		]
	},
	{
		kind: "nvenc",
		// NVENC encoding goes through CUDA hwaccel; some builds list both.
		hwaccelTokens: ["cuda", "nvenc", "cuvid"],
		encoderTokens: ["h264_nvenc"],
		probeArgs: [
			// Mirror the upload and scaling path used by sized live profiles so
			// detection rejects CUDA installations that can encode but not filter.
			"-init_hw_device",
			"cuda=signalhaven_cuda",
			"-filter_hw_device",
			"signalhaven_cuda",
			...SYNTHETIC_INPUT_ARGS,
			"-vf",
			// Some NVENC generations reject 64x64 frames even though CUDA setup is
			// healthy; 256x256 remains cheap while satisfying encoder minimums.
			"format=nv12,hwupload,scale_cuda=256:256",
			"-c:v",
			"h264_nvenc",
			...SYNTHETIC_OUTPUT_ARGS
		]
	}
];

/**
 * Detect FFmpeg hardware backends that this SignalHaven process can actually use.
 *
 * Compile-time listings first avoid unnecessary device probes. Every listed
 * candidate must then initialize its device and encode a tiny synthetic frame.
 * This rejects missing devices, drivers, permissions, and unusable encoders.
 * Individual failures are logged and skipped so software encoding remains
 * available and hardware detection never makes startup depend on a GPU.
 */
export async function detectHwaccels(
	runner: HwaccelProbeRunner = DEFAULT_RUNNER,
	logger: HwaccelProbeLogger = DEFAULT_LOGGER
): Promise<HwaccelKind[]> {
	const hwaccelsOutput = await runSafely(
		runner,
		["-hide_banner", "-hwaccels"],
		"FFmpeg hwaccel listing",
		logger
	);
	if (hwaccelsOutput == null || !probeSucceeded(hwaccelsOutput)) return [];

	const encodersOutput = await runSafely(
		runner,
		["-hide_banner", "-encoders"],
		"FFmpeg encoder listing",
		logger
	);
	if (encodersOutput == null || !probeSucceeded(encodersOutput)) return [];

	const accels = hwaccelsOutput.output.toLowerCase();
	const encoders = encodersOutput.output.toLowerCase();
	const detected: HwaccelKind[] = [];

	for (const candidate of CANDIDATES) {
		const isCompiled =
			candidate.hwaccelTokens.some((token) => accels.includes(token)) &&
			candidate.encoderTokens.some((token) => encoders.includes(token));
		if (!isCompiled) continue;

		const result = await runSafely(
			runner,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				...candidate.probeArgs
			],
			candidate.kind,
			logger
		);
		if (probeSucceeded(result)) {
			detected.push(candidate.kind);
		}
	}

	return detected;
}

/** Keep runner failures local to one candidate and report why it was skipped. */
async function runSafely(
	runner: HwaccelProbeRunner,
	args: readonly string[],
	label: string,
	logger: HwaccelProbeLogger
): Promise<HwaccelProbeResult | null> {
	let result: HwaccelProbeResult | null;
	try {
		result = await runner.run(args);
	} catch (error) {
		logger.warn(
			`[signalhaven] hwaccel probe excluded ${label}: runner error: ${sanitizeDiagnostic(
				error instanceof Error ? error.message : String(error)
			)}`
		);
		return null;
	}

	if (probeSucceeded(result)) return result;

	const reason =
		result == null
			? "FFmpeg could not be started"
			: result.timedOut
				? `timed out after ${PROBE_TIMEOUT_MS}ms`
				: `FFmpeg exited with code ${result.exitCode ?? "null"}`;
	const diagnostic = result ? sanitizeDiagnostic(result.output) : "";
	logger.warn(
		`[signalhaven] hwaccel probe excluded ${label}: ${reason}${
			diagnostic ? `: ${diagnostic}` : ""
		}`
	);
	return result;
}

/** A probe is usable only when FFmpeg exits normally and successfully. */
function probeSucceeded(result: HwaccelProbeResult | null): boolean {
	return result != null && !result.timedOut && result.exitCode === 0;
}

/** Remove terminal escapes/control whitespace and cap operator log context. */
function sanitizeDiagnostic(output: string): string {
	const escape = String.fromCharCode(27);
	const ansiSequence = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g");
	return output
		.replace(ansiSequence, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_DIAGNOSTIC_CHARS);
}

/** Backend priority used when the operator delegates selection to SignalHaven. */
const AUTO_HWACCEL_PRIORITY: readonly HwaccelKind[] = [
	"nvenc",
	"qsv",
	"vaapi",
	"videotoolbox"
];

/**
 * Resolve the user's hwaccel preference against the runtime-usable list.
 * Returns `null` to use software encoding.
 *
 * `auto` selects the highest-priority usable backend; a forced unavailable
 * backend also falls back to software so stale settings cannot break playback.
 */
export function resolveHwaccel(
	preference: "auto" | "none" | HwaccelKind,
	available: readonly HwaccelKind[]
): HwaccelKind | null {
	if (preference === "none") return null;
	if (preference === "auto") {
		// Detection order describes probe order, not backend preference. Prefer
		// dedicated NVIDIA encoding on hybrid hosts, then integrated GPU paths.
		return (
			AUTO_HWACCEL_PRIORITY.find((kind) => available.includes(kind)) ?? null
		);
	}
	return available.includes(preference) ? preference : null;
}
