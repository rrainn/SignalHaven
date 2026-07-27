import { join } from "node:path";

import type { HwaccelKind, TranscodeProfile } from "@signalhaven/shared";

/**
 * Browser-friendly h264 profile/level pairs we can stream-copy. Anything
 * outside this set gets re-encoded even when the source is h264 (some
 * broadcasters use High@L5 which Safari rejects).
 */
const BROWSER_SAFE_H264_PROFILES = new Set([
	"baseline",
	"constrained baseline",
	"main",
	"high"
]);
const MAX_BROWSER_SAFE_H264_LEVEL = 42; // 4.2

/** Audio codecs HLS players reliably play in `<video>`. */
const BROWSER_SAFE_AUDIO_CODECS = new Set(["aac", "mp4a"]);

/**
 * What we know about the upstream's elementary streams. Either populated
 * by `ffprobe` (production) or hand-rolled in tests. All fields are
 * optional so the builder degrades to "transcode everything" when probe
 * data isn't available.
 */
export interface InputCodecInfo {
	videoCodec?: string | undefined;
	/** h264 profile name as reported by ffprobe (e.g. `Main`, `High`). */
	videoProfile?: string | undefined;
	/** h264 level × 10 (e.g. `40` for 4.0) as reported by ffprobe. */
	videoLevel?: number | undefined;
	audioCodec?: string | undefined;
	/** Source pixel width; used to decide whether scaling is a no-op. */
	width?: number | undefined;
	/** Source pixel height; used to decide whether scaling is a no-op. */
	height?: number | undefined;
}

/** Resolved per-target encoding plan. */
export interface ProfileTarget {
	/** Maximum output height in pixels; `null` means keep source. */
	maxHeight: number | null;
	/** Target video bitrate in kbps. */
	videoBitrateKbps: number;
	/** Target audio bitrate in kbps. */
	audioBitrateKbps: number;
	/** When true, video is dropped entirely (audio-only). */
	audioOnly: boolean;
}

/**
 * Hard-coded ladder for the named profiles. Bitrates are conservative,
 * tuned for Apple's HLS authoring guidelines (HLS bitrate / resolution
 * recommendations table) so the streams remain playable on flaky links.
 */
const PROFILE_TARGETS: Record<
	Exclude<TranscodeProfile, "direct">,
	ProfileTarget
> = {
	"original-quality": {
		maxHeight: null,
		videoBitrateKbps: 8000,
		audioBitrateKbps: 192,
		audioOnly: false
	},
	"1080p": {
		maxHeight: 1080,
		videoBitrateKbps: 6000,
		audioBitrateKbps: 192,
		audioOnly: false
	},
	"720p": {
		maxHeight: 720,
		videoBitrateKbps: 3000,
		audioBitrateKbps: 160,
		audioOnly: false
	},
	"480p": {
		maxHeight: 480,
		videoBitrateKbps: 1200,
		audioBitrateKbps: 128,
		audioOnly: false
	},
	"audio-only": {
		maxHeight: 0,
		videoBitrateKbps: 0,
		audioBitrateKbps: 128,
		audioOnly: true
	}
};

export interface BuildFfmpegArgsOptions {
	/** Upstream URL fed to ffmpeg as `-i`. */
	input: string;
	/** Directory to write playlist + segments into. */
	outDir: string;
	/** Profile selected by the user / channel. Defaults to `direct`. */
	profile?: TranscodeProfile;
	/**
	 * Hwaccel backend resolved by the caller. `null`/omitted means software.
	 */
	hwaccel?: HwaccelKind | null;
	/** Probe data for the source streams (when available). */
	input_codecs?: InputCodecInfo;
	/**
	 * When true, preserve EIA-608/708 closed captions during a libx264
	 * re-encode (`-a53cc 1`) so downstream players that decode in-band
	 * captions still see them. Has no effect on stream-copy paths
	 * (captions are passed through automatically) or on hardware
	 * encoders (most don't carry the SEI through).
	 */
	captionsEnabled?: boolean;
	/**
	 * `live` keeps a sliding window and omits the end marker; `vod` retains
	 * every segment so completed recordings remain seekable for the session.
	 */
	outputMode?: "live" | "vod";
	/** Retained live window; omitted keeps the low-latency six-segment fallback. */
	timeShiftWindowSeconds?: number;
	/** Start reading a completed input at this timestamp for lazy DVR seeks. */
	inputSeekSeconds?: number;
}

/**
 * Build the ffmpeg arg vector for a given (profile, hwaccel, input) tuple.
 *
 * The output is always packaged as HLS with the same segment / playlist
 * settings as the original streaming proxy so the playlist polling loop in
 * `StreamSession` works unchanged.
 *
 *   * `direct` profile always emits `-c copy` (no decode); ignores hwaccel.
 *   * `original-quality` re-muxes when both video and audio are already
 *     browser-safe (effectively `direct`); otherwise transcodes only the
 *     stream(s) that need it.
 *   * Sized profiles always re-encode video; audio is copied iff already
 *     AAC at a sane bitrate (we don't have probe-side bitrate so we just
 *     check the codec).
 *   * `audio-only` drops video and re-encodes audio to AAC.
 */
export function buildFfmpegArgs(options: BuildFfmpegArgsOptions): string[] {
	const profile: TranscodeProfile = options.profile ?? "direct";
	const hwaccel = options.hwaccel ?? null;
	const codecs = options.input_codecs ?? {};
	const captionsEnabled = options.captionsEnabled ?? false;
	const outputMode = options.outputMode ?? "live";

	const head: string[] = [
		"-hide_banner",
		"-loglevel",
		"warning",
		"-nostdin",
		"-fflags",
		outputMode === "live" ? "+genpts+nobuffer" : "+genpts"
	];

	// Hwaccel decode hints must come BEFORE `-i`. They are only useful if we
	// are going to re-encode; pure stream-copy gains nothing from hwaccel.
	const decode =
		profile === "direct" || profile === "audio-only"
			? []
			: hwaccelDecodeArgs(hwaccel);

	// Input-side seeking lets FFmpeg jump by container index instead of decoding
	// everything before the viewer's requested recording position.
	const inputSeek =
		outputMode === "vod" &&
		options.inputSeekSeconds !== undefined &&
		options.inputSeekSeconds > 0
			? ["-ss", String(options.inputSeekSeconds)]
			: [];

	const codec = buildCodecArgs(profile, hwaccel, codecs, captionsEnabled);

	const tail = hlsOutputArgs(
		options.outDir,
		outputMode,
		options.timeShiftWindowSeconds
	);

	return [
		...head,
		...decode,
		...inputSeek,
		"-i",
		options.input,
		...codec,
		...tail
	];
}

/**
 * Decode-side hwaccel hints. Some backends (vaapi, qsv) need the decoded
 * frames placed on a hardware surface so the encoder can avoid an extra
 * upload; we set the hwaccel + output format pair recommended by FFmpeg's
 * docs (HWAccelIntro on the FFmpeg wiki).
 */
function hwaccelDecodeArgs(hwaccel: HwaccelKind | null): string[] {
	switch (hwaccel) {
		case "videotoolbox":
			return ["-hwaccel", "videotoolbox"];
		case "vaapi":
			return [
				"-hwaccel",
				"vaapi",
				"-hwaccel_output_format",
				"vaapi",
				"-vaapi_device",
				"/dev/dri/renderD128"
			];
		case "qsv":
			return ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"];
		case "nvenc":
			return ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
		default:
			return [];
	}
}

function buildCodecArgs(
	profile: TranscodeProfile,
	hwaccel: HwaccelKind | null,
	codecs: InputCodecInfo,
	captionsEnabled: boolean
): string[] {
	if (profile === "direct") {
		return ["-c", "copy"];
	}

	if (profile === "audio-only") {
		return [
			"-vn",
			"-c:a",
			"aac",
			"-b:a",
			`${PROFILE_TARGETS["audio-only"].audioBitrateKbps}k`,
			"-ac",
			"2"
		];
	}

	const target = PROFILE_TARGETS[profile];
	const videoArgs = buildVideoArgs(
		profile,
		target,
		hwaccel,
		codecs,
		captionsEnabled
	);
	const audioArgs = buildAudioArgs(target, codecs);
	return [...videoArgs, ...audioArgs];
}

/**
 * Decide whether the source video can be `-c:v copy`'d for this profile,
 * or whether we need to re-encode (and how).
 */
function buildVideoArgs(
	profile: TranscodeProfile,
	target: ProfileTarget,
	hwaccel: HwaccelKind | null,
	codecs: InputCodecInfo,
	captionsEnabled: boolean
): string[] {
	// When the source is already h264 with a browser-safe profile/level AND
	// no scaling is required (either original-quality, or the source already
	// fits within the target), we can stream-copy and skip the encoder.
	if (canCopyVideo(profile, target, codecs)) {
		return ["-c:v", "copy"];
	}

	const encoder = videoEncoderFor(hwaccel);
	const scale = scaleArgs(target, hwaccel);
	// `-a53cc 1` tells libx264 to embed CEA-608/708 SEI from the input into
	// the encoded stream. Other encoders ignore the flag (or in the case of
	// hardware encoders, don't carry the SEI at all), so we only set it
	// when we know it's meaningful.
	const captionsFlag =
		captionsEnabled && encoder === "libx264" ? ["-a53cc", "1"] : [];
	return [
		...scale,
		"-c:v",
		encoder,
		...presetArgsFor(encoder),
		...captionsFlag,
		"-b:v",
		`${target.videoBitrateKbps}k`,
		"-maxrate",
		`${Math.round(target.videoBitrateKbps * 1.1)}k`,
		"-bufsize",
		`${target.videoBitrateKbps * 2}k`,
		"-g",
		"60",
		"-keyint_min",
		"60",
		"-sc_threshold",
		"0",
		"-pix_fmt",
		pixFmtFor(encoder)
	];
}

function buildAudioArgs(
	target: ProfileTarget,
	codecs: InputCodecInfo
): string[] {
	const sourceCodec = (codecs.audioCodec ?? "").toLowerCase();
	if (BROWSER_SAFE_AUDIO_CODECS.has(sourceCodec)) {
		return ["-c:a", "copy"];
	}
	return ["-c:a", "aac", "-b:a", `${target.audioBitrateKbps}k`, "-ac", "2"];
}

function canCopyVideo(
	profile: TranscodeProfile,
	target: ProfileTarget,
	codecs: InputCodecInfo
): boolean {
	const codec = (codecs.videoCodec ?? "").toLowerCase();
	if (codec !== "h264") {
		return false;
	}
	const profileName = (codecs.videoProfile ?? "").toLowerCase();
	if (!BROWSER_SAFE_H264_PROFILES.has(profileName)) {
		return false;
	}
	if (
		typeof codecs.videoLevel === "number" &&
		codecs.videoLevel > MAX_BROWSER_SAFE_H264_LEVEL
	) {
		return false;
	}
	if (profile === "original-quality") {
		return true;
	}
	// Sized profiles can copy only when the source already fits.
	if (target.maxHeight === null) {
		return true;
	}
	if (typeof codecs.height !== "number") {
		return false;
	}
	return codecs.height <= target.maxHeight;
}

function videoEncoderFor(hwaccel: HwaccelKind | null): string {
	switch (hwaccel) {
		case "videotoolbox":
			return "h264_videotoolbox";
		case "vaapi":
			return "h264_vaapi";
		case "qsv":
			return "h264_qsv";
		case "nvenc":
			return "h264_nvenc";
		default:
			return "libx264";
	}
}

function presetArgsFor(encoderName: string): string[] {
	switch (encoderName) {
		case "libx264":
			return [
				"-preset",
				"veryfast",
				"-tune",
				"zerolatency",
				"-profile:v",
				"main"
			];
		case "h264_nvenc":
			return ["-preset", "p4", "-tune", "ll", "-profile:v", "main"];
		case "h264_qsv":
			return ["-preset", "veryfast", "-profile:v", "main"];
		case "h264_vaapi":
			return ["-profile:v", "main"];
		case "h264_videotoolbox":
			return ["-profile:v", "main"];
		default:
			return [];
	}
}

function pixFmtFor(encoderName: string): string {
	switch (encoderName) {
		case "h264_vaapi":
			return "vaapi";
		case "h264_qsv":
			return "nv12";
		case "h264_nvenc":
			// CUDA decoding and scaling leave frames on the GPU. Advertising that
			// format prevents FFmpeg from inserting an unsupported implicit download.
			return "cuda";
		default:
			return "yuv420p";
	}
}

/**
 * Produce the right scale filter for the target. Hardware encoders use
 * their own scaler chain (`scale_vaapi`, `scale_qsv`, `scale_cuda`) so the
 * decoded frames can stay on the GPU.
 */
function scaleArgs(
	target: ProfileTarget,
	hwaccel: HwaccelKind | null
): string[] {
	if (target.maxHeight === null) {
		return [];
	}
	// Width is `-2` so ffmpeg picks an even number that preserves aspect.
	const swExpr = `scale=-2:'min(${target.maxHeight},ih)'`;
	switch (hwaccel) {
		case "vaapi":
			return ["-vf", `scale_vaapi=w=-2:h=${target.maxHeight}`];
		case "qsv":
			return ["-vf", `scale_qsv=w=-2:h=${target.maxHeight}`];
		case "nvenc":
			return ["-vf", `scale_cuda=-2:${target.maxHeight}`];
		case "videotoolbox":
		default:
			return ["-vf", swExpr];
	}
}

/**
 * Common HLS output args. Mirrors the original streaming proxy so the
 * playlist polling loop in `StreamSession` (and its segment route) sees
 * the same on-disk layout regardless of profile.
 */
function hlsOutputArgs(
	outDir: string,
	outputMode: "live" | "vod",
	timeShiftWindowSeconds?: number
): string[] {
	// An unbounded list retains every segment while still publishing updates;
	// FFmpeg's `hls_playlist_type vod` waits for the full input before writing.
	const lifecycleArgs =
		outputMode === "vod"
			? [
					"-hls_time",
					"6",
					"-hls_list_size",
					"0",
					"-hls_flags",
					"independent_segments+temp_file"
				]
			: [
					"-hls_time",
					"1",
					"-hls_list_size",
					String(
						timeShiftWindowSeconds === undefined
							? 6
							: Math.max(1, Math.ceil(timeShiftWindowSeconds))
					),
					...(timeShiftWindowSeconds === undefined
						? []
						: ["-hls_delete_threshold", "2"]),
					"-hls_flags",
					timeShiftWindowSeconds === undefined
						? "delete_segments+independent_segments+omit_endlist"
						: "delete_segments+independent_segments+omit_endlist+temp_file"
				];
	return [
		"-f",
		"hls",
		...lifecycleArgs,
		"-hls_segment_filename",
		join(outDir, "seg-%05d.ts"),
		join(outDir, "playlist.m3u8")
	];
}

/** File name of the WebVTT captions playlist produced by the sidecar. */
export const CAPTIONS_PLAYLIST_NAME = "captions.m3u8";
/** Glob-style stem for the WebVTT segment files (`cap-NNNNN.vtt`). */
export const CAPTIONS_SEGMENT_PREFIX = "cap-";

/**
 * Escapes an input for FFmpeg's nested lavfi `movie` filename parser.
 *
 * The surrounding quotes keep option-separator colons, including an explicit
 * URL port, attached to the filename. Embedded quotes must briefly leave the
 * quoted section so the filter parser can preserve them as literal characters.
 */
export function escapeCaptionsMovieInput(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/:/g, "\\:")
		.replace(/'/g, "'\\''");
}

/**
 * Build the ffmpeg arg vector for the per-session caption-extraction
 * sidecar (rrainn/SignalHaven#23).
 *
 * The sidecar reads the same upstream URL via the lavfi `movie` filter
 * with the `subcc` selector — which exposes EIA-608/708 closed captions
 * decoded from the H.264 SEI as a regular subtitle stream — and wraps
 * the result in an HLS playlist of WebVTT segments. The output is
 * written into the same temp directory as the main session's TS
 * segments and is exposed alongside them via the streaming proxy
 * routes; the synthetic master playlist references it through a
 * standard `EXT-X-MEDIA:TYPE=SUBTITLES` group, so any HLS player with
 * native track support (Safari, hls.js, ExoPlayer, AVPlayer, ...) picks
 * the captions up automatically.
 *
 * Failures here are non-fatal: the upstream may not actually carry CC
 * data, or it may not support concurrent reads. The caller spawns this
 * sidecar with an isolated exit handler so a dead caption pipeline
 * never tears down the video session.
 */
export function buildCaptionsFfmpegArgs(
	input: string,
	outDir: string,
	timeShiftWindowSeconds?: number
): string[] {
	const escapedInput = escapeCaptionsMovieInput(input);
	return [
		"-hide_banner",
		"-loglevel",
		"warning",
		"-nostdin",
		"-f",
		"lavfi",
		"-i",
		`movie='${escapedInput}'[out0+subcc]`,
		"-map",
		"0:s:0",
		"-c:s",
		"webvtt",
		"-f",
		"hls",
		"-hls_time",
		"6",
		"-hls_list_size",
		String(
			timeShiftWindowSeconds === undefined
				? 6
				: Math.max(1, Math.ceil(timeShiftWindowSeconds / 6))
		),
		"-hls_flags",
		timeShiftWindowSeconds === undefined
			? "delete_segments+independent_segments+omit_endlist"
			: "delete_segments+independent_segments+omit_endlist+temp_file",
		"-hls_segment_filename",
		join(outDir, `${CAPTIONS_SEGMENT_PREFIX}%05d.vtt`),
		join(outDir, CAPTIONS_PLAYLIST_NAME)
	];
}

/**
 * Best-effort classification of an FFmpeg stderr line. Stream sessions use
 * the matched category for sanitized operator logs while keeping viewer
 * errors generic.
 *
 * The patterns are intentionally conservative so operator summaries do not
 * report a misleading failure category.
 */
export interface ParsedFfmpegLine {
	level: "info" | "warning" | "error";
	/** Short machine-readable category (e.g. `decoder_not_found`). */
	category?: string;
	message: string;
}

const ERROR_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
	{ category: "input_unreachable", pattern: /Server returned 4\d\d/i },
	{ category: "input_unreachable", pattern: /Server returned 5\d\d/i },
	{ category: "input_unreachable", pattern: /HTTP error 5\d\d/i },
	{ category: "input_unreachable", pattern: /No route to host/i },
	{ category: "input_unreachable", pattern: /Connection refused/i },
	{ category: "input_unreachable", pattern: /Input\/output error/i },
	{ category: "decoder_not_found", pattern: /Decoder \(codec .*\) not found/i },
	{ category: "encoder_not_found", pattern: /Unknown encoder/i },
	{
		category: "hwaccel_init_failed",
		pattern:
			/Failed to (?:get|init).* (?:hwaccel|VAAPI|VideoToolbox|QSV|CUDA|NVENC)/i
	},
	{
		category: "hwaccel_init_failed",
		pattern:
			/(?:Device (?:creation|setup) failed|No device available for decoder|Cannot load (?:libcuda|libnvidia-encode)|No VA display found)/i
	},
	{
		category: "hwaccel_init_failed",
		pattern:
			/(?:Failed|Error) (?:to |while )?(?:initializ|initialis|creating|opening).*(?:hardware|device|VAAPI|VideoToolbox|QSV|CUDA|NVENC|MFX)/i
	},
	{
		category: "invalid_data",
		pattern: /Invalid data found when processing input/i
	}
];

const WARNING_HINT = /^\[?\w*\]?\s*(?:warning|deprecated)/i;

export function parseFfmpegLine(line: string): ParsedFfmpegLine {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return { level: "info", message: trimmed };
	}
	for (const { category, pattern } of ERROR_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { level: "error", category, message: trimmed };
		}
	}
	if (WARNING_HINT.test(trimmed)) {
		return { level: "warning", message: trimmed };
	}
	// ffmpeg writes its periodic stats line via `-loglevel warning` muted,
	// so any remaining line at this point is probably a notice/error.
	if (/error/i.test(trimmed)) {
		return { level: "error", message: trimmed };
	}
	return { level: "info", message: trimmed };
}
