import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
	buildFfmpegArgs,
	buildCaptionsFfmpegArgs,
	CAPTIONS_PLAYLIST_NAME,
	CAPTIONS_SEGMENT_PREFIX,
	parseFfmpegLine,
	type InputCodecInfo
} from "../src/streaming/transcoder";
import {
	detectHwaccels,
	resolveHwaccel,
	type HwaccelProbeResult
} from "../src/streaming/hwaccel";

const OUT_DIR = "/tmp/signalhaven-test";
const INPUT = "udp://example/in";
const ffmpegAvailable =
	spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function snapshot(args: readonly string[]): string {
	// Strip the path-prefixed segment filename so the snapshot is stable
	// across operating systems / temp paths.
	return args
		.map((a) => a.replace(/\/tmp\/signalhaven-test/g, "<OUT>"))
		.join(" ");
}

test("direct profile produces a pure stream-copy pipeline", () => {
	const args = buildFfmpegArgs({ input: INPUT, outDir: OUT_DIR });
	assert.equal(
		snapshot(args),
		"-hide_banner -loglevel warning -nostdin -nostats -stats_period 1 " +
			"-progress pipe:2 -fflags +genpts+nobuffer -i " +
			"udp://example/in -c copy -f hls -hls_time 1 -hls_list_size 12 " +
			"-hls_flags delete_segments+independent_segments+omit_endlist " +
			"-hls_segment_filename <OUT>/seg-%05d.ts <OUT>/playlist.m3u8"
	);
});

test("live output publishes an atomic bounded time-shift window", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		timeShiftWindowSeconds: 30 * 60
	});

	assert.equal(args[args.indexOf("-hls_list_size") + 1], "1800");
	assert.equal(args[args.indexOf("-hls_delete_threshold") + 1], "2");
	assert.equal(
		args[args.indexOf("-hls_flags") + 1],
		"delete_segments+independent_segments+omit_endlist+temp_file"
	);
});

test("caption output retains the same time-shift duration", () => {
	const args = buildCaptionsFfmpegArgs(INPUT, OUT_DIR, 30 * 60);

	assert.equal(args[args.indexOf("-hls_time") + 1], "6");
	assert.equal(args[args.indexOf("-hls_list_size") + 1], "300");
	assert.match(args[args.indexOf("-hls_flags") + 1] ?? "", /temp_file/);
});

test("direct profile ignores hwaccel hints (no decode hwaccel for copy)", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "direct",
		hwaccel: "vaapi"
	});
	assert.ok(!args.includes("-hwaccel"), "no -hwaccel before -i");
	assert.ok(args.includes("-c"), "still uses -c copy");
});

test("audio-only profile drops video and re-encodes audio to AAC", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "audio-only"
	});
	assert.ok(args.includes("-vn"));
	const aacIdx = args.indexOf("-c:a");
	assert.equal(args[aacIdx + 1], "aac");
	assert.ok(!args.includes("-c:v"));
});

test("original-quality stream-copies a browser-safe h264 source", () => {
	const codecs: InputCodecInfo = {
		videoCodec: "h264",
		videoProfile: "Main",
		videoLevel: 40,
		audioCodec: "aac",
		height: 1080
	};
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "original-quality",
		input_codecs: codecs
	});
	assert.deepEqual(
		args.filter((_, i) => args[i - 1] === "-c:v" || args[i - 1] === "-c:a"),
		["copy", "copy"]
	);
});

test("original-quality re-encodes when source codec is mpeg2/ac3", () => {
	const codecs: InputCodecInfo = {
		videoCodec: "mpeg2video",
		audioCodec: "ac3",
		height: 720
	};
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "original-quality",
		input_codecs: codecs
	});
	assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
	assert.equal(args[args.indexOf("-c:a") + 1], "aac");
	// No scaling filter at original-quality (no maxHeight cap).
	assert.ok(!args.includes("-vf"));
});

test("720p profile re-encodes video and applies a scale filter", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "720p",
		input_codecs: { videoCodec: "mpeg2video", audioCodec: "ac3" }
	});
	assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
	const vfIdx = args.indexOf("-vf");
	assert.ok(vfIdx > -1, "video filter present");
	assert.match(String(args[vfIdx + 1]), /min\(720,ih\)/);
	assert.equal(args[args.indexOf("-b:v") + 1], "3000k");
});

test("480p profile keeps copy when source already fits and is browser-safe", () => {
	const codecs: InputCodecInfo = {
		videoCodec: "h264",
		videoProfile: "high",
		videoLevel: 31,
		audioCodec: "aac",
		height: 360
	};
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "480p",
		input_codecs: codecs
	});
	assert.equal(args[args.indexOf("-c:v") + 1], "copy");
	assert.equal(args[args.indexOf("-c:a") + 1], "copy");
});

test("1080p profile re-encodes when source height exceeds target", () => {
	const codecs: InputCodecInfo = {
		videoCodec: "h264",
		videoProfile: "high",
		videoLevel: 40,
		audioCodec: "aac",
		height: 2160
	};
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "1080p",
		input_codecs: codecs
	});
	assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
	assert.equal(args[args.indexOf("-c:a") + 1], "copy");
});

test("hwaccel=videotoolbox switches encoder + decode hint", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "720p",
		hwaccel: "videotoolbox"
	});
	assert.equal(args[args.indexOf("-hwaccel") + 1], "videotoolbox");
	assert.equal(args[args.indexOf("-c:v") + 1], "h264_videotoolbox");
});

test("hwaccel=vaapi prepends vaapi decode + uses h264_vaapi encoder", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "720p",
		hwaccel: "vaapi"
	});
	assert.equal(args[args.indexOf("-hwaccel") + 1], "vaapi");
	assert.equal(args[args.indexOf("-hwaccel_output_format") + 1], "vaapi");
	assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
	assert.match(String(args[args.indexOf("-vf") + 1]), /scale_vaapi/);
});

test("hwaccel=qsv selects qsv encoder + scaler", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "1080p",
		hwaccel: "qsv"
	});
	assert.equal(args[args.indexOf("-c:v") + 1], "h264_qsv");
	assert.match(String(args[args.indexOf("-vf") + 1]), /scale_qsv/);
});

test("hwaccel=nvenc selects cuda decode + nvenc encoder", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "1080p",
		hwaccel: "nvenc"
	});
	assert.equal(args[args.indexOf("-hwaccel") + 1], "cuda");
	assert.equal(args[args.indexOf("-c:v") + 1], "h264_nvenc");
});

test("nvenc preserves CUDA frames for original-quality re-encoding", () => {
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "original-quality",
		hwaccel: "nvenc",
		input_codecs: { videoCodec: "mpeg2video", audioCodec: "ac3" }
	});

	assert.equal(args[args.indexOf("-hwaccel_output_format") + 1], "cuda");
	assert.equal(args[args.indexOf("-c:v") + 1], "h264_nvenc");
	assert.equal(
		args[args.indexOf("-pix_fmt") + 1],
		"cuda",
		"GPU-resident decoded frames must not require an implicit CPU conversion"
	);
});

test("snapshot: every (profile, hwaccel) combo produces a deterministic vector", () => {
	const profiles = [
		"direct",
		"original-quality",
		"1080p",
		"720p",
		"480p",
		"audio-only"
	] as const;
	const hwaccels = [null, "videotoolbox", "vaapi", "qsv", "nvenc"] as const;

	// Force re-encode for every non-direct profile so the snapshot reflects
	// the encoder branch (probe data omitted).
	const matrix: Record<string, string> = {};
	for (const profile of profiles) {
		for (const hwaccel of hwaccels) {
			const args = buildFfmpegArgs({
				input: INPUT,
				outDir: OUT_DIR,
				profile,
				hwaccel: hwaccel ?? null
			});
			matrix[`${profile}|${hwaccel ?? "sw"}`] = snapshot(args);
		}
	}

	// Every combo must be a non-empty unique-shape string ending in
	// `<OUT>/playlist.m3u8` so we know we routed through `hlsOutputArgs`.
	for (const [combo, snap] of Object.entries(matrix)) {
		assert.ok(
			snap.endsWith("<OUT>/playlist.m3u8"),
			`${combo} should end with playlist.m3u8`
		);
	}

	// Direct ignores hwaccel: every direct row must be identical.
	const directSnaps = Object.entries(matrix)
		.filter(([k]) => k.startsWith("direct|"))
		.map(([, v]) => v);
	assert.equal(
		new Set(directSnaps).size,
		1,
		"direct profile is hwaccel-agnostic"
	);

	// Sized profiles must differ between hwaccels (each picks its own encoder).
	const sevenTwentySnaps = Object.entries(matrix)
		.filter(([k]) => k.startsWith("720p|"))
		.map(([, v]) => v);
	assert.equal(
		new Set(sevenTwentySnaps).size,
		sevenTwentySnaps.length,
		"720p arg vectors are unique per hwaccel"
	);
});

test("parseFfmpegLine classifies common errors", () => {
	assert.equal(
		parseFfmpegLine("Server returned 404 Not Found").category,
		"input_unreachable"
	);
	assert.equal(
		parseFfmpegLine(
			"[h264 @ 0x1] Decoder (codec h264) not found for input stream 0"
		).category,
		"decoder_not_found"
	);
	assert.equal(
		parseFfmpegLine("Failed to init VAAPI context").category,
		"hwaccel_init_failed"
	);
	assert.equal(
		parseFfmpegLine("No device available for decoder: device type cuda")
			.category,
		"hwaccel_init_failed"
	);
	assert.equal(
		parseFfmpegLine("Invalid data found when processing input").category,
		"invalid_data"
	);
	assert.equal(
		parseFfmpegLine("frame=  120 fps= 30 q=-1.0 size=...").level,
		"info"
	);
});

/** Build a successful or failed result from the fake FFmpeg process. */
function probeResult(
	output: string,
	exitCode = 0,
	timedOut = false
): HwaccelProbeResult {
	return { output, exitCode, timedOut };
}

/** Return the compile-time listings shared by hardware detection tests. */
function listingResult(args: readonly string[]): HwaccelProbeResult | null {
	if (args.includes("-hwaccels")) {
		return probeResult(
			"Hardware acceleration methods:\nvideotoolbox\nvaapi\nqsv\ncuda\n"
		);
	}
	if (args.includes("-encoders")) {
		return probeResult(
			[
				" V..... h264_videotoolbox    VideoToolbox H.264 Encoder",
				" V..... h264_vaapi           H.264/AVC (VAAPI)",
				" V..... h264_qsv             H.264 (Intel Quick Sync Video)",
				" V..... h264_nvenc           NVIDIA NVENC H.264 encoder"
			].join("\n")
		);
	}
	return null;
}

test("detectHwaccels retains candidates that encode a synthetic frame", async () => {
	const probes: string[][] = [];
	const detected = await detectHwaccels({
		run: async (args) => {
			probes.push([...args]);
			return listingResult(args) ?? probeResult("");
		}
	});

	assert.deepEqual(detected, ["videotoolbox", "vaapi", "qsv", "nvenc"]);
	const nvencProbe = probes.find((args) => args.includes("h264_nvenc"));
	assert.ok(nvencProbe?.includes("cuda=signalhaven_cuda"));
	assert.ok(
		nvencProbe?.some((arg) => arg.includes("scale_cuda")),
		"NVENC detection exercises the CUDA filter path used by transcodes"
	);
	assert.ok(
		nvencProbe?.includes("format=nv12,hwupload,scale_cuda=256:256"),
		"NVENC detection uses a frame size accepted by supported NVIDIA encoders"
	);
});

test("detection failure preserves the software fallback", async () => {
	const detected = await detectHwaccels(
		{
			run: async () => {
				throw new Error("ffmpeg unavailable");
			}
		},
		{ warn: () => undefined }
	);

	assert.deepEqual(detected, []);
	assert.equal(resolveHwaccel("auto", detected), null);
});

test("detectHwaccels skips backends whose encoder isn't compiled in", async () => {
	const detected = await detectHwaccels({
		run: async (args) => {
			if (args.includes("-hwaccels")) {
				return probeResult(
					"Hardware acceleration methods:\nvaapi\nvideotoolbox\n"
				);
			}
			if (args.includes("-encoders")) {
				// VideoToolbox must not be probed when its encoder is absent.
				return probeResult(" V..... h264_vaapi H.264/AVC (VAAPI)");
			}
			return probeResult("");
		}
	});

	assert.deepEqual(detected, ["vaapi"]);
});

for (const unusable of ["vaapi", "qsv", "nvenc"] as const) {
	test(`detectHwaccels excludes compiled-but-unusable ${unusable}`, async () => {
		const diagnostics: string[] = [];
		const detected = await detectHwaccels(
			{
				run: async (args) => {
					const listing = listingResult(args);
					if (listing) return listing;
					if (args.includes(`h264_${unusable}`)) {
						return probeResult(
							"\u001b[31mDevice initialization failed\npermission denied\u001b[0m",
							1
						);
					}
					return probeResult("");
				}
			},
			{ warn: (message) => diagnostics.push(message) }
		);

		assert.ok(!detected.includes(unusable));
		assert.ok(
			diagnostics.some(
				(message) =>
					message.includes(unusable) &&
					message.includes("Device initialization failed permission denied") &&
					!message.includes("\u001b")
			),
			"operators receive sanitized failure context"
		);
	});
}

test("auto selects the next runtime-usable candidate", async () => {
	const detected = await detectHwaccels(
		{
			run: async (args) => {
				if (args.includes("-hwaccels")) {
					return probeResult("Hardware acceleration methods:\nvaapi\nqsv\n");
				}
				if (args.includes("-encoders")) {
					return probeResult(
						" V..... h264_vaapi H.264/AVC (VAAPI)\n" +
							" V..... h264_qsv H.264 (Intel Quick Sync Video)"
					);
				}
				if (args.includes("h264_vaapi")) {
					return probeResult("No VA display found", 1);
				}
				return probeResult("");
			}
		},
		{ warn: () => undefined }
	);

	assert.deepEqual(detected, ["qsv"]);
	assert.equal(resolveHwaccel("auto", detected), "qsv");
});

test("one runtime probe failure does not prevent later candidates", async () => {
	const detected = await detectHwaccels(
		{
			run: async (args) => {
				const listing = listingResult(args);
				if (listing) return listing;
				if (args.includes("h264_videotoolbox")) {
					throw new Error("probe runner failed");
				}
				return probeResult("");
			}
		},
		{ warn: () => undefined }
	);

	assert.deepEqual(detected, ["vaapi", "qsv", "nvenc"]);
});

test("resolveHwaccel honors user preference + falls back to software", () => {
	assert.equal(resolveHwaccel("none", ["vaapi"]), null);
	assert.equal(resolveHwaccel("auto", []), null);
	assert.equal(resolveHwaccel("auto", ["vaapi", "qsv"]), "qsv");
	assert.equal(
		resolveHwaccel("auto", ["vaapi", "qsv", "nvenc"]),
		"nvenc",
		"auto prefers the exposed NVIDIA encoder on hybrid-GPU hosts"
	);
	assert.equal(resolveHwaccel("qsv", ["vaapi", "qsv"]), "qsv");
	assert.equal(
		resolveHwaccel("nvenc", ["vaapi"]),
		null,
		"pinned but missing → software"
	);
});

test("captionsEnabled adds -a53cc 1 only for libx264 re-encodes", () => {
	// libx264 (software) → flag is set so CEA-608 SEI survives the encode.
	const sw = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "720p",
		captionsEnabled: true,
		input_codecs: { videoCodec: "mpeg2video", audioCodec: "ac3" }
	});
	const swA53 = sw.indexOf("-a53cc");
	assert.ok(swA53 > -1, "libx264 re-encode should set -a53cc");
	assert.equal(sw[swA53 + 1], "1");

	// Hardware encoder → flag omitted (encoder doesn't honour it).
	const hw = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "720p",
		hwaccel: "vaapi",
		captionsEnabled: true,
		input_codecs: { videoCodec: "mpeg2video", audioCodec: "ac3" }
	});
	assert.equal(
		hw.indexOf("-a53cc"),
		-1,
		"hwaccel encode should not set -a53cc"
	);

	// captionsEnabled=false → no flag at all.
	const off = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "720p",
		captionsEnabled: false,
		input_codecs: { videoCodec: "mpeg2video", audioCodec: "ac3" }
	});
	assert.equal(off.indexOf("-a53cc"), -1);
});

test("captionsEnabled is a no-op for direct (stream-copy) profile", () => {
	// Direct profile is pure remux; CEA-608 in the SEI is preserved by
	// `-c copy` automatically, so we don't add encoder-specific flags.
	const args = buildFfmpegArgs({
		input: INPUT,
		outDir: OUT_DIR,
		profile: "direct",
		captionsEnabled: true
	});
	assert.equal(args.indexOf("-a53cc"), -1);
	assert.ok(args.includes("-c") && args.includes("copy"));
});

test("buildCaptionsFfmpegArgs produces an HLS WebVTT extraction pipeline", () => {
	const args = buildCaptionsFfmpegArgs("http://host/stream.ts", OUT_DIR);
	// Reads via the lavfi `movie` filter with the `subcc` selector — the
	// standard ffmpeg recipe for surfacing EIA-608/708 as a subtitle stream.
	assert.equal(args[args.indexOf("-f") + 1], "lavfi");
	const inputArg = String(args[args.indexOf("-i") + 1]);
	assert.match(inputArg, /^movie='/);
	assert.match(inputArg, /'\[out0\+subcc\]$/);
	// The quoted filename keeps every escaped URL colon out of lavfi's option
	// grammar, including the separator before an explicit port.
	assert.match(inputArg, /'http\\:\/\/host\/stream\.ts'/);
	// Maps the subtitle stream and encodes it as WebVTT.
	assert.equal(args[args.indexOf("-map") + 1], "0:s:0");
	assert.equal(args[args.indexOf("-c:s") + 1], "webvtt");
	// Outputs an HLS playlist of .vtt segments alongside the video.
	const outputs = args.filter((a) => a.startsWith(OUT_DIR));
	assert.ok(
		outputs.some((p) => p.endsWith(CAPTIONS_PLAYLIST_NAME)),
		"writes captions playlist"
	);
	assert.ok(
		outputs.some(
			(p) => p.includes(CAPTIONS_SEGMENT_PREFIX) && p.endsWith(".vtt")
		),
		"writes .vtt segments"
	);
});

test(
	"buildCaptionsFfmpegArgs produces an explicit-port URL FFmpeg can parse",
	{ skip: !ffmpegAvailable && "ffmpeg not installed" },
	() => {
		const args = buildCaptionsFfmpegArgs(
			"http://127.0.0.1:5004/auto/v11.1",
			OUT_DIR
		);
		const inputArg = String(args[args.indexOf("-i") + 1]);

		// A transport failure is expected because no test server is listening;
		// reaching that stage proves lavfi did not reinterpret the port as an option.
		const result = spawnSync(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-f",
				"lavfi",
				"-i",
				inputArg,
				"-t",
				"0.01",
				"-f",
				"null",
				"-"
			],
			{ encoding: "utf8", timeout: 5_000 }
		);
		assert.equal(result.error, undefined);
		assert.doesNotMatch(
			result.stderr,
			/stream_index|Undefined constant or missing/
		);
	}
);
