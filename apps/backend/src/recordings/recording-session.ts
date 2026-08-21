import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";

import type { TunerHttpHeaders } from "@signalhaven/shared";

import { httpInputArgs, parseFfmpegLine } from "../streaming/transcoder";

/** Hooks for tests to swap out the ffmpeg invocation. */
export interface RecordingRunner {
	spawn(args: string[]): ChildProcess;
}

const DEFAULT_RUNNER: RecordingRunner = {
	spawn: (args) =>
		spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
};

export interface RecordingSessionOptions {
	/** Upstream URL fed to ffmpeg as `-i`. */
	upstreamUrl: string;
	/** Provider-required request headers forwarded to FFmpeg. */
	httpHeaders?: TunerHttpHeaders;
	/** Absolute path to the output `.mkv` file. */
	outputPath: string;
	/** Hard cap on recording wall-clock duration in seconds (`-t`). */
	durationSeconds: number;
	/** Optional inversion-of-control hook for tests. */
	runner?: RecordingRunner;
}

export type RecordingSessionStopReason =
	/** ffmpeg exited 0 — naturally completed (`-t` elapsed). */
	| { kind: "completed" }
	/**
	 * ffmpeg was terminated by `stop()` (cancel API or shutdown). The
	 * partial output file is preserved.
	 */
	| { kind: "cancelled" }
	/** ffmpeg crashed or exited non-zero before `-t` elapsed. */
	| { kind: "failed"; error: string };

/**
 * Build the ffmpeg argv for a one-off recording. `-c copy` (matroska) is
 * the default per the rrainn/SignalHaven#R1-oneoff acceptance criteria so we
 * don't burn CPU during recording. `-t <seconds>` bounds the run-time
 * regardless of upstream behaviour.
 */
export function buildRecordingFfmpegArgs(options: {
	input: string;
	output: string;
	durationSeconds: number;
	/** Provider-required request headers applied before `-i`. */
	httpHeaders?: TunerHttpHeaders;
}): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"warning",
		"-nostdin",
		"-y",
		"-fflags",
		"+genpts",
		...httpInputArgs(options.httpHeaders),
		"-i",
		options.input,
		"-t",
		String(options.durationSeconds),
		"-c",
		"copy",
		"-f",
		"matroska",
		options.output
	];
}

/**
 * One ffmpeg recording. Owns the child process and exposes a `done`
 * promise that resolves when the process exits (with the parsed reason)
 * plus a `stop()` to terminate it cleanly. The caller is responsible
 * for orchestrating tuner leases, DB transitions and event publication
 * around the session — `RecordingSession` only knows about ffmpeg.
 */
export class RecordingSession {
	readonly outputPath: string;
	readonly startedAt: Date;

	private readonly runner: RecordingRunner;
	private readonly process: ChildProcess;
	private readonly args: string[];

	/** Most recent stderr line classified as an error. */
	private lastError: string | undefined;
	private stopRequested = false;
	private exited = false;
	private readonly donePromise: Promise<RecordingSessionStopReason>;

	constructor(options: RecordingSessionOptions) {
		this.outputPath = options.outputPath;
		this.runner = options.runner ?? DEFAULT_RUNNER;
		this.startedAt = new Date();
		this.args = buildRecordingFfmpegArgs({
			input: options.upstreamUrl,
			output: options.outputPath,
			durationSeconds: options.durationSeconds,
			...(options.httpHeaders ? { httpHeaders: options.httpHeaders } : {})
		});

		this.process = this.runner.spawn(this.args);

		let stderrBuffer = "";
		const consume = (raw: string): void => {
			const line = raw.trimEnd();
			if (line.length === 0) {
				return;
			}
			const parsed = parseFfmpegLine(line);
			if (parsed.level === "error") {
				this.lastError = parsed.message;
			}
		};
		this.process.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString("utf8");
			const parts = stderrBuffer.split(/\r?\n/);
			stderrBuffer = parts.pop() ?? "";
			for (const raw of parts) {
				consume(raw);
			}
		});
		this.process.stderr?.once("end", () => {
			if (stderrBuffer.length > 0) {
				consume(stderrBuffer);
				stderrBuffer = "";
			}
		});

		this.donePromise = new Promise<RecordingSessionStopReason>((resolve) => {
			const settle = (reason: RecordingSessionStopReason): void => {
				if (this.exited) {
					return;
				}
				this.exited = true;
				resolve(reason);
			};
			this.process.once("error", (err) => {
				const message = err instanceof Error ? err.message : String(err);
				settle({ kind: "failed", error: message });
			});
			this.process.once("exit", (code, signal) => {
				if (this.stopRequested) {
					settle({ kind: "cancelled" });
					return;
				}
				if (code === 0) {
					settle({ kind: "completed" });
					return;
				}
				settle({
					kind: "failed",
					error:
						this.lastError ??
						`ffmpeg exited unexpectedly (code=${code ?? "null"}, signal=${
							signal ?? "null"
						})`
				});
			});
		});
	}

	/** The argv used to spawn ffmpeg. Useful for tests / diagnostics. */
	getArgs(): string[] {
		return [...this.args];
	}

	/** Resolves once ffmpeg has exited, with the classified outcome. */
	done(): Promise<RecordingSessionStopReason> {
		return this.donePromise;
	}

	/**
	 * Request a clean shutdown. The eventual outcome is reported on
	 * {@link done} as `{ kind: "cancelled" }`. Idempotent.
	 */
	stop(): void {
		if (this.stopRequested || this.exited) {
			return;
		}
		this.stopRequested = true;
		if (this.process.exitCode !== null || this.process.signalCode !== null) {
			return;
		}
		try {
			this.process.kill("SIGTERM");
		} catch {
			// Already gone; the 'exit' handler will resolve the promise.
		}
	}

	/**
	 * Best-effort metadata sniff for the produced file: returns the file
	 * size in bytes (or `null` if the file does not exist). Used at
	 * completion to populate the recording row.
	 */
	static async readFileSize(path: string): Promise<number | null> {
		try {
			const info = await stat(path);
			return info.size;
		} catch {
			return null;
		}
	}
}
