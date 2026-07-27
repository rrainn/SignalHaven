import { spawn } from "node:child_process";

import type { InputCodecInfo } from "./transcoder";

/** Maximum ffprobe JSON retained in memory for one local media file. */
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

interface ProbeStream {
	codec_type?: string;
	codec_name?: string;
	profile?: string;
	level?: number;
	width?: number;
	height?: number;
}

interface ProbeDocument {
	streams?: ProbeStream[];
}

/** Testable boundary for discovering the codecs in a recording file. */
export interface MediaProbe {
	probe(inputPath: string): Promise<InputCodecInfo>;
}

/**
 * Inspect the first video and audio streams without decoding the file. The
 * result feeds the shared transcoder's copy-vs-transcode decision.
 */
export async function probeMedia(inputPath: string): Promise<InputCodecInfo> {
	return new Promise<InputCodecInfo>((resolve, reject) => {
		const child = spawn(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"stream=codec_type,codec_name,profile,level,width,height",
				"-of",
				"json",
				inputPath
			],
			{ stdio: ["ignore", "pipe", "pipe"] }
		);

		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			callback();
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (Buffer.byteLength(stdout) > MAX_PROBE_OUTPUT_BYTES) {
				try {
					child.kill("SIGKILL");
				} catch {
					// The close handler below will surface the bounded-output error.
				}
				finish(() => reject(new Error("ffprobe output exceeded 1 MiB")));
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 16_384) {
				stderr += chunk.toString("utf8");
			}
		});
		child.once("error", (error) => {
			finish(() => reject(error));
		});
		child.once("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				finish(() =>
					reject(
						new Error(
							stderr.trim() || `ffprobe exited with code ${code ?? "null"}`
						)
					)
				);
				return;
			}
			finish(() => {
				try {
					resolve(parseMediaProbeOutput(stdout));
				} catch (error) {
					reject(error);
				}
			});
		});
	});
}

/** Convert ffprobe's stream document into the transcoder's compact shape. */
export function parseMediaProbeOutput(raw: string): InputCodecInfo {
	const document = JSON.parse(raw) as ProbeDocument;
	const video = document.streams?.find(
		(stream) => stream.codec_type === "video"
	);
	const audio = document.streams?.find(
		(stream) => stream.codec_type === "audio"
	);
	if (!video && !audio) {
		throw new Error("Recording contains no playable audio or video streams");
	}
	return {
		...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
		...(video?.profile ? { videoProfile: video.profile } : {}),
		...(typeof video?.level === "number" ? { videoLevel: video.level } : {}),
		...(typeof video?.width === "number" ? { width: video.width } : {}),
		...(typeof video?.height === "number" ? { height: video.height } : {}),
		...(audio?.codec_name ? { audioCodec: audio.codec_name } : {})
	};
}

/** Production media probe used when tests do not inject a fake. */
export const DEFAULT_MEDIA_PROBE: MediaProbe = {
	probe: probeMedia
};
