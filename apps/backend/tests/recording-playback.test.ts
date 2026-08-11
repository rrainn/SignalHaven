import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import express from "express";
import request from "supertest";

import { EventBus } from "../src/events/event-bus";
import { errorHandler } from "../src/http/middleware/errors";
import { requestId } from "../src/http/middleware/request-id";
import { createRecordingsRouter } from "../src/http/routes/recordings";
import {
	RECORDING_PLAYBACK_ERROR_CODE,
	RecordingPlaybackNotFoundError,
	RecordingPlaybackService,
	RecordingPlaybackUnavailableError
} from "../src/recordings/recording-playback.service";
import type { RecordingPlaybackRunner } from "../src/recordings/recording-playback-session";
import type { RecordingsService } from "../src/recordings/recordings.service";
import type { RecordingRecord } from "../src/repositories/recordings.repository";
import { probeMedia } from "../src/streaming/media-probe";

/** Minimal repository boundary used by the playback manager tests. */
class FakeRecordingsRepo {
	readonly rows = new Map<string, RecordingRecord>();

	async getById(id: string): Promise<RecordingRecord | null> {
		return this.rows.get(id) ?? null;
	}
}

interface FakeProcess extends EventEmitter {
	stderr: EventEmitter;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

/** Write deterministic HLS output while keeping the fake process alive. */
function createFakeProcess(outDir: string): ChildProcess {
	const process = new EventEmitter() as FakeProcess;
	process.stderr = new EventEmitter();
	process.exitCode = null;
	process.signalCode = null;
	process.kill = (signal = "SIGTERM"): boolean => {
		process.signalCode = signal as NodeJS.Signals;
		setImmediate(() => process.emit("exit", null, signal));
		return true;
	};
	setImmediate(async () => {
		await mkdir(outDir, { recursive: true });
		await writeFile(join(outDir, "init_720p.mp4"), "initialization fragment");
		await writeFile(join(outDir, "720p-seg-00000.m4s"), "playable segment");
		await writeFile(
			join(outDir, "720p.m3u8"),
			'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init_720p.mp4"\n#EXTINF:2.0,\n720p-seg-00000.m4s\n#EXT-X-ENDLIST\n'
		);
		await writeFile(
			join(outDir, "master.m3u8"),
			"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n720p.m3u8\n"
		);
	});
	return process as unknown as ChildProcess;
}

/** Exit with one FFmpeg diagnostic so startup failure behavior stays realistic. */
function createFailingProcess(message: string): ChildProcess {
	const process = new EventEmitter() as FakeProcess;
	process.stderr = new EventEmitter();
	process.exitCode = null;
	process.signalCode = null;
	process.kill = (signal = "SIGTERM"): boolean => {
		process.signalCode = signal as NodeJS.Signals;
		setImmediate(() => process.emit("exit", null, signal));
		return true;
	};
	setImmediate(() => {
		process.stderr.emit("data", Buffer.from(`${message}\n`));
		process.stderr.emit("end");
		process.exitCode = 1;
		process.emit("exit", 1, null);
	});
	return process as unknown as ChildProcess;
}

/** Keep FFmpeg alive until the startup timeout terminates the attempt. */
function createHangingProcess(): ChildProcess {
	const process = new EventEmitter() as FakeProcess;
	process.stderr = new EventEmitter();
	process.exitCode = null;
	process.signalCode = null;
	process.kill = (signal = "SIGTERM"): boolean => {
		process.signalCode = signal as NodeJS.Signals;
		setImmediate(() => process.emit("exit", null, signal));
		return true;
	};
	return process as unknown as ChildProcess;
}

/** Extract the generated output directory from the FFmpeg segment template. */
function outputDirectory(args: string[]): string {
	const index = args.indexOf("-hls_segment_filename");
	const pattern = args[index + 1];
	assert.ok(pattern);
	return pattern.substring(0, pattern.lastIndexOf("/"));
}

function makeRow(input: Partial<RecordingRecord> = {}): RecordingRecord {
	const now = new Date();
	return {
		id: randomUUID(),
		channelId: randomUUID(),
		programId: null,
		title: "Playback fixture",
		status: "completed",
		scheduledStart: now,
		scheduledEnd: new Date(now.getTime() + 60_000),
		actualStart: now,
		actualEnd: new Date(now.getTime() + 60_000),
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: 60,
		errorMessage: null,
		schedulerJobId: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null,
		createdAt: now,
		updatedAt: now,
		...input
	};
}

function createFakeRunner(
	onSpawn?: (args: string[]) => void,
	codecs: Awaited<ReturnType<RecordingPlaybackRunner["probe"]>> = {
		videoCodec: "h264",
		videoProfile: "Main",
		videoLevel: 40,
		audioCodec: "aac",
		width: 1280,
		height: 720
	}
): RecordingPlaybackRunner {
	return {
		probe: async () => codecs,
		spawn: (args) => {
			onSpawn?.(args);
			return createFakeProcess(outputDirectory(args));
		}
	};
}

test("GET /recordings/:id/stream.m3u8 exposes a recording manifest", async () => {
	const app = express();
	let requestContext: { requestId?: string } | undefined;
	let requestedStartSeconds: number | undefined;
	let requestedViewerId: string | undefined;
	app.use(requestId());
	app.use(
		createRecordingsRouter({
			getPlaybackManifest: async (
				_id: string,
				context: { requestId?: string },
				startSeconds?: number,
				viewerId?: string
			) => {
				requestContext = context;
				requestedStartSeconds = startSeconds;
				requestedViewerId = viewerId;
				return "#EXTM3U\n";
			}
		} as unknown as RecordingsService)
	);

	const viewerId = randomUUID();
	const response = await request(app).get(
		`/recordings/${randomUUID()}/stream.m3u8?start=1800&viewerId=${viewerId}`
	);

	assert.equal(response.status, 200);
	assert.match(response.headers["content-type"] ?? "", /mpegurl/);
	assert.equal(response.headers["cache-control"], "no-store");
	assert.match(response.text, /^#EXTM3U/);
	assert.equal(requestContext?.requestId, response.headers["x-request-id"]);
	assert.equal(requestedStartSeconds, 1800);
	assert.equal(requestedViewerId, viewerId);
});

test("POST /recordings/:id/viewers/:viewerId/release is idempotent", async () => {
	const app = express();
	const recordingId = randomUUID();
	const viewerId = randomUUID();
	const releases: Array<[string, string]> = [];
	app.use(
		createRecordingsRouter({
			releasePlaybackViewer: (id: string, viewer: string) => {
				releases.push([id, viewer]);
				return releases.length === 1;
			}
		} as unknown as RecordingsService)
	);

	const path = `/recordings/${recordingId}/viewers/${viewerId}/release`;
	assert.equal((await request(app).post(path)).status, 204);
	assert.equal((await request(app).post(path)).status, 204);
	assert.deepEqual(releases, [
		[recordingId, viewerId],
		[recordingId, viewerId]
	]);
});

test("a viewer seek reuses the finalized VOD without input seeking", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-seek-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input, durationSeconds: 3_000 });
	repository.rows.set(row.id, row);
	const attempts: string[][] = [];
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner((args) => attempts.push(args))
	});
	t.after(async () => playback.stopAll());

	const viewerId = randomUUID();
	const first = await playback.getManifest(row.id, {}, 0, viewerId);
	const firstSession = playback.getSession(row.id);
	const second = await playback.getManifest(row.id, {}, 1_800, viewerId);

	assert.equal(attempts.length, 1);
	assert.equal(attempts[0]?.includes("-ss"), false);
	assert.notEqual(first, second);
	assert.match(second, /#EXT-X-START:TIME-OFFSET=1800\.000,PRECISE=YES/);
	assert.equal(firstSession?.getState(), "ready");
	assert.equal(playback.getSession(row.id, 0), firstSession);
});

test("recording manifests expose one finalized VOD timeline with a native start hint", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-vod-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input, durationSeconds: 3_000 });
	repository.rows.set(row.id, row);
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner()
	});
	t.after(async () => playback.stopAll());

	const manifest = await playback.getManifest(row.id, {}, 1_200, randomUUID());
	const staleResumeManifest = await playback.getManifest(
		row.id,
		{},
		5_000,
		randomUUID()
	);
	const session = playback.getSession(row.id, 0);

	assert.match(manifest, /#EXT-X-START:TIME-OFFSET=1200\.000,PRECISE=YES/);
	assert.match(
		staleResumeManifest,
		/#EXT-X-START:TIME-OFFSET=2999\.000,PRECISE=YES/
	);
	assert.equal(session?.startSeconds, 0);
	const renditionUri = manifest
		.split(/\r?\n/)
		.find((line) => line.startsWith("segments/"));
	assert.ok(renditionUri);
	const parsed = new URL(
		renditionUri,
		"http://localhost/recordings/id/stream.m3u8"
	);
	const rendition = await playback.getSegment(
		row.id,
		parsed.searchParams.get("session") ?? "",
		parsed.pathname.split("/").pop() ?? "",
		parsed.searchParams.get("viewerId") ?? undefined
	);
	assert.match(rendition.toString("utf8"), /#EXT-X-PLAYLIST-TYPE:VOD/);
	assert.match(rendition.toString("utf8"), /#EXT-X-ENDLIST/);
});

test("finalized recording VOD is reused across playback service lifetimes", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-cache-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const first = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner(() => {
			spawnCount += 1;
		})
	});
	await first.getManifest(row.id);
	await first.stopAll();

	const second = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner(() => {
			spawnCount += 1;
		})
	});
	t.after(async () => second.stopAll());
	const manifest = await second.getManifest(row.id);

	assert.match(manifest, /^#EXTM3U/);
	assert.equal(spawnCount, 1);
});

test("independent viewers share matching offsets without clobbering seeks", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-viewers-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input, durationSeconds: 3_000 });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner(() => {
			spawnCount += 1;
		})
	});
	t.after(async () => playback.stopAll());
	const firstViewer = randomUUID();
	const secondViewer = randomUUID();

	await Promise.all([
		playback.getManifest(row.id, {}, 0, firstViewer),
		playback.getManifest(row.id, {}, 0, secondViewer)
	]);
	const shared = playback.getSession(row.id, 0);
	assert.equal(spawnCount, 1);
	assert.equal(shared?.getViewerCount(), 2);

	await playback.getManifest(row.id, {}, 1_800, firstViewer);
	assert.equal(spawnCount, 1);
	assert.equal(shared?.getState(), "ready");
	assert.equal(shared?.getViewerCount(), 2);
	assert.equal(playback.getSession(row.id, 0)?.getViewerCount(), 2);
});

test("the final viewer release stops FFmpeg and duplicate beacons are harmless", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-release-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner()
	});
	const firstViewer = randomUUID();
	const secondViewer = randomUUID();
	await playback.getManifest(row.id, {}, 0, firstViewer);
	await playback.getManifest(row.id, {}, 0, secondViewer);
	const session = playback.getSession(row.id, 0);

	assert.equal(playback.releaseViewer(row.id, firstViewer), true);
	assert.equal(playback.releaseViewer(row.id, firstViewer), false);
	assert.equal(session?.getState(), "ready");
	assert.equal(playback.releaseViewer(row.id, secondViewer), true);
	await waitFor(() => playback.getActiveSessionCount() === 0, 1_000);
	assert.equal(session?.getState(), "stopped");
});

test("viewer heartbeat timeout cleans up when an unload beacon is lost", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-timeout-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		idleMs: 5_000,
		viewerTimeoutMs: 30,
		runner: createFakeRunner()
	});

	await playback.getManifest(row.id, {}, 0, randomUUID());
	await waitFor(() => playback.getActiveSessionCount() === 0, 1_000);
	assert.equal(playback.getRunningProcessCount(), 0);
});

test("legacy activity keeps a shared window after its managed viewer leaves", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-legacy-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		idleMs: 100,
		viewerTimeoutMs: 20,
		runner: createFakeRunner()
	});
	const viewerId = randomUUID();
	await playback.getManifest(row.id);
	await playback.getManifest(row.id, {}, 0, viewerId);
	const session = playback.getSession(row.id, 0);

	assert.equal(playback.releaseViewer(row.id, viewerId), true);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(session?.getState(), "ready");
	await waitFor(() => playback.getActiveSessionCount() === 0, 1_000);
});

test("segment requests remain valid when a viewer seeks on the shared VOD", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-stale-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input, durationSeconds: 3_000 });
	repository.rows.set(row.id, row);
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner()
	});
	t.after(async () => playback.stopAll());
	const viewerId = randomUUID();
	const manifest = await playback.getManifest(row.id, {}, 0, viewerId);
	const uri = manifest
		.split(/\r?\n/)
		.find((line) => line.startsWith("segments/"));
	assert.ok(uri);
	const parsed = new URL(uri, "http://localhost/recordings/id/stream.m3u8");
	await playback.getManifest(row.id, {}, 1_800, viewerId);

	const rendition = await playback.getSegment(
		row.id,
		parsed.searchParams.get("session") ?? "",
		parsed.pathname.split("/").pop() ?? "",
		viewerId
	);
	assert.match(rendition.toString("utf8"), /#EXT-X-ENDLIST/);
});

test("operator stop blocks automatic playlist recreation until requests go quiet", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-operator-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		operatorStopQuietMs: 100,
		runner: createFakeRunner(() => {
			spawnCount += 1;
		})
	});
	t.after(async () => playback.stopAll());
	const viewerId = randomUUID();
	await playback.getManifest(row.id, {}, 0, viewerId);
	const session = playback.getSession(row.id, 0);
	assert.ok(session);
	assert.equal(playback.stopSession(session.sessionId), true);
	await waitFor(() => playback.getActiveSessionCount() === 0, 1_000);

	await assert.rejects(
		playback.getManifest(row.id, {}, 0, viewerId),
		/stopped by an operator/i
	);
	assert.equal(spawnCount, 1);
	await new Promise((resolve) => setTimeout(resolve, 150));
	await playback.getManifest(row.id, {}, 0, viewerId);
	// A stopped session may safely reopen the immutable finalized VOD cache.
	assert.equal(spawnCount, 1);
});

test("concurrent manifest requests share one FFmpeg session and stable segments", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-share-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input, fileSize: 15 });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	let ffmpegArgs: string[] = [];
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		idleMs: 5_000,
		runner: createFakeRunner((args) => {
			spawnCount += 1;
			ffmpegArgs = args;
		})
	});
	t.after(async () => playback.stopAll());

	const [first, second] = await Promise.all([
		playback.getManifest(row.id),
		playback.getManifest(row.id)
	]);

	assert.equal(spawnCount, 1);
	assert.equal(first, second);
	assert.match(first, /segments\/720p\.m3u8\?session=[0-9a-f-]{36}/);
	const uri = first.split(/\r?\n/).find((line) => line.startsWith("segments/"));
	assert.ok(uri);
	const parsed = new URL(uri, "http://localhost/recordings/id/stream.m3u8");
	const rendition = await playback.getSegment(
		row.id,
		parsed.searchParams.get("session") ?? "",
		parsed.pathname.split("/").pop() ?? ""
	);
	assert.match(rendition.toString("utf8"), /init_720p\.mp4\?session=/);
	assert.match(rendition.toString("utf8"), /720p-seg-00000\.m4s\?session=/);
	const segment = await playback.getSegment(
		row.id,
		parsed.searchParams.get("session") ?? "",
		"720p-seg-00000.m4s"
	);
	assert.deepEqual(segment, Buffer.from("playable segment"));

	// Every recording rendition has an encoder ceiling so throttled clients can adapt.
	assert.equal(ffmpegArgs.includes("libx264"), true);
	assert.match(
		ffmpegArgs[ffmpegArgs.indexOf("-var_stream_map") + 1] ?? "",
		/720p/
	);
	// Finalization ensures native players receive a stable duration and seek range.
	assert.equal(ffmpegArgs[ffmpegArgs.indexOf("-hls_playlist_type") + 1], "vod");
	assert.equal(ffmpegArgs[ffmpegArgs.indexOf("-hls_list_size") + 1], "0");
	assert.equal(
		ffmpegArgs.includes("delete_segments+independent_segments+omit_endlist"),
		false
	);
});

test("hardware startup failure retries once in software after cleaning artifacts", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-fallback-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	const attempts: string[][] = [];
	const outputDirectories: string[] = [];
	const bus = new EventBus();
	const fallbackEvents: Array<Record<string, unknown>> = [];
	bus.subscribe("recordings", ({ event, data }) => {
		if (event === "recording.playback.software_fallback") {
			fallbackEvents.push(data as Record<string, unknown>);
		}
	});
	const playback = new RecordingPlaybackService({
		repository,
		bus,
		tmpRoot: tmp,
		resolveHwaccel: async () => "vaapi",
		runner: {
			probe: async () => ({ videoCodec: "mpeg2video", audioCodec: "aac" }),
			spawn: (args) => {
				attempts.push(args);
				const outDir = outputDirectory(args);
				outputDirectories.push(outDir);
				return attempts.length === 1
					? createFailingProcess(
							"Failed to init VAAPI context\nError opening filters!"
						)
					: createFakeProcess(outDir);
			}
		}
	});
	t.after(async () => playback.stopAll());

	const manifest = await playback.getManifest(row.id);

	assert.match(manifest, /^#EXTM3U/);
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0]?.includes("h264_vaapi"), true);
	assert.equal(attempts[1]?.includes("h264_vaapi"), false);
	assert.equal(attempts[1]?.includes("libx264"), true);
	await assert.rejects(stat(outputDirectories[0] ?? ""), /ENOENT/);
	assert.deepEqual(fallbackEvents, [
		{
			recordingId: row.id,
			playbackSessionId: fallbackEvents[0]?.playbackSessionId,
			hwaccel: "vaapi",
			reason: "hwaccel_init_failed"
		}
	]);
});

test("concurrent manifests share one hardware attempt and one software fallback", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-playback-fallback-share-")
	);
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		resolveHwaccel: async () => "qsv",
		runner: {
			probe: async () => ({ videoCodec: "mpeg2video", audioCodec: "aac" }),
			spawn: (args) => {
				spawnCount += 1;
				return spawnCount === 1
					? createFailingProcess("Failed to init QSV device")
					: createFakeProcess(outputDirectory(args));
			}
		}
	});
	t.after(async () => playback.stopAll());

	const manifests = await Promise.all([
		playback.getManifest(row.id),
		playback.getManifest(row.id),
		playback.getManifest(row.id)
	]);

	assert.equal(spawnCount, 2);
	assert.equal(new Set(manifests).size, 1);
});

test("non-hardware FFmpeg failures do not retry", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-playback-no-fallback-")
	);
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		resolveHwaccel: async () => "nvenc",
		runner: {
			probe: async () => ({ videoCodec: "mpeg2video", audioCodec: "aac" }),
			spawn: () => {
				spawnCount += 1;
				return createFailingProcess("Invalid data found when processing input");
			}
		}
	});

	await assert.rejects(playback.getManifest(row.id));
	assert.equal(spawnCount, 1);
});

test("software fallback failure surfaces the terminal software cause", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-playback-fallback-error-")
	);
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const logs: Array<Record<string, unknown>> = [];
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		resolveHwaccel: async () => "videotoolbox",
		logger: {
			error: (context) => logs.push(context)
		},
		runner: {
			probe: async () => ({ videoCodec: "mpeg2video", audioCodec: "aac" }),
			spawn: () => {
				spawnCount += 1;
				return createFailingProcess(
					spawnCount === 1
						? "Failed to init VideoToolbox device"
						: "Invalid data found when processing input"
				);
			}
		}
	});

	await assert.rejects(playback.getManifest(row.id), (error: unknown) => {
		assert.ok(error instanceof RecordingPlaybackUnavailableError);
		assert.ok(error.internalCause instanceof Error);
		assert.match(error.internalCause.message, /Invalid data/);
		return true;
	});
	assert.equal(spawnCount, 2);
	assert.equal(
		logs.length,
		1,
		"the recoverable hardware attempt is not terminal"
	);
	assert.equal(logs[0]?.["hwaccel"], "none");
	assert.equal(logs[0]?.["errorCategory"], "invalid_data");
});

test("terminal playback failure writes one sanitized structured summary", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-diagnostic-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "private-recording-token-secret.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	const logs: Array<{
		context: Record<string, unknown>;
		message: string;
	}> = [];
	const events: Array<Record<string, unknown>> = [];
	const bus = new EventBus();
	bus.subscribe("recordings", ({ data }) => {
		events.push(data as Record<string, unknown>);
	});
	const playback = new RecordingPlaybackService({
		repository,
		bus,
		tmpRoot: tmp,
		logger: {
			error: (context, message) => logs.push({ context, message })
		},
		runner: {
			probe: async () => ({ videoCodec: "h264", audioCodec: "aac" }),
			spawn: () =>
				createFailingProcess(
					`${input}: Invalid data found when processing input https://media.invalid/file?access_token=private`
				)
		}
	});

	const routeService = {
		getPlaybackManifest: (id: string, context: { requestId?: string }) =>
			playback.getManifest(id, context)
	} as unknown as RecordingsService;
	const app = express();
	const duplicateRequestLogs: string[] = [];
	app.use(requestId());
	app.use((req, _res, next) => {
		// The terminal service diagnostic makes a generic HTTP warning redundant.
		req.log = {
			warn: () => duplicateRequestLogs.push("warn"),
			error: () => duplicateRequestLogs.push("error")
		} as unknown as typeof req.log;
		next();
	});
	app.use(createRecordingsRouter(routeService));
	app.use(errorHandler());
	const response = await request(app).get(`/recordings/${row.id}/stream.m3u8`);

	assert.equal(response.status, 422);
	assert.deepEqual(response.body.error, {
		code: RECORDING_PLAYBACK_ERROR_CODE.fileUnreadable,
		message:
			"The recording could not be prepared for browser playback. Check the media file and FFmpeg installation.",
		requestId: response.headers["x-request-id"]
	});

	assert.equal(logs.length, 1, "one terminal summary avoids per-line spam");
	assert.deepEqual(duplicateRequestLogs, []);
	assert.equal(logs[0]?.message, "Recording playback failed to prepare");
	assert.deepEqual(logs[0]?.context, {
		requestId: response.headers["x-request-id"],
		recordingId: row.id,
		playbackSessionId: logs[0]?.context["playbackSessionId"],
		profile: "auto",
		hwaccel: "none",
		exitCode: 1,
		signal: null,
		errorCategory: "invalid_data",
		errorMessage:
			"<redacted recording path>: Invalid data found when processing input <redacted URL>"
	});
	assert.match(
		String(logs[0]?.context["playbackSessionId"]),
		/^[0-9a-f-]{36}$/
	);
	const serialized = JSON.stringify(logs);
	assert.doesNotMatch(serialized, /private-recording|media\.invalid|private/);
	assert.doesNotMatch(
		JSON.stringify(events),
		/Invalid data|private-recording|media\.invalid|private/
	);
	assert.doesNotMatch(JSON.stringify(response.body), /Invalid data|private/);
});

test("spawn errors and startup timeouts retain diagnostic classifications", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-playback-classification-")
	);
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const logs: Array<Record<string, unknown>> = [];

	for (const scenario of ["spawn", "timeout"] as const) {
		const row = makeRow({ filePath: input });
		repository.rows.set(row.id, row);
		const playback = new RecordingPlaybackService({
			repository,
			tmpRoot: tmp,
			startTimeoutMs: 10,
			logger: {
				error: (context) => logs.push(context)
			},
			runner: {
				probe: async () => ({ videoCodec: "h264", audioCodec: "aac" }),
				spawn: () => {
					if (scenario === "spawn") {
						throw new Error(`spawn ffmpeg ENOENT for ${input}`);
					}
					return createHangingProcess();
				}
			}
		});

		await assert.rejects(playback.getManifest(row.id));
	}

	assert.deepEqual(
		logs.map((entry) => ({
			category: entry["errorCategory"],
			exitCode: entry["exitCode"],
			signal: entry["signal"]
		})),
		[
			{ category: "ffmpeg_spawn_failed", exitCode: null, signal: null },
			{ category: "ffmpeg_start_timeout", exitCode: null, signal: null }
		]
	);
	assert.doesNotMatch(
		JSON.stringify(logs),
		new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	);
});

test("cancellation during software fallback stops its process and artifacts", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-playback-fallback-stop-")
	);
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	let fallbackKilled = false;
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		resolveHwaccel: async () => "vaapi",
		runner: {
			probe: async () => ({ videoCodec: "mpeg2video", audioCodec: "aac" }),
			spawn: () => {
				spawnCount += 1;
				if (spawnCount === 1) {
					return createFailingProcess("Failed to init VAAPI context");
				}
				const process = new EventEmitter() as FakeProcess;
				process.stderr = new EventEmitter();
				process.exitCode = null;
				process.signalCode = null;
				process.kill = (signal = "SIGTERM"): boolean => {
					fallbackKilled = true;
					process.signalCode = signal as NodeJS.Signals;
					setImmediate(() => process.emit("exit", null, signal));
					return true;
				};
				return process as unknown as ChildProcess;
			}
		}
	});

	const manifest = playback.getManifest(row.id);
	// Attach the rejection assertion before cancellation can settle the request.
	const manifestRejected = assert.rejects(manifest);
	await waitFor(() => spawnCount === 2, 1_000);
	await playback.stop(row.id);
	await manifestRejected;

	assert.equal(fallbackKilled, true);
	assert.equal(playback.getActiveSessionCount(), 0);
	const remaining = await readdir(tmp);
	assert.equal(
		remaining.some((name) =>
			name.startsWith("signalhaven-recording-playback-")
		),
		false
	);
});

test("codec planning encodes the adaptive ladder and browser-safe audio", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-codecs-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let args: string[] = [];
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		idleMs: 5_000,
		runner: createFakeRunner(
			(captured) => {
				args = captured;
			},
			{
				videoCodec: "h264",
				videoProfile: "High",
				videoLevel: 41,
				audioCodec: "ac3",
				width: 1920,
				height: 1080
			}
		)
	});
	t.after(async () => playback.stopAll());

	await playback.getManifest(row.id);

	assert.equal(args[args.indexOf("-c:v:0") + 1], "libx264");
	assert.equal(args[args.indexOf("-c:a:0") + 1], "aac");
	assert.match(args[args.indexOf("-var_stream_map") + 1] ?? "", /1080p/);
});

test("non-completed and missing recordings return intentional playback errors", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-errors-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner()
	});
	t.after(async () => playback.stopAll());

	await assert.rejects(
		playback.getManifest(randomUUID()),
		RecordingPlaybackNotFoundError
	);

	for (const status of [
		"scheduled",
		"recording",
		"failed",
		"cancelled"
	] as const) {
		const row = makeRow({ status, filePath: input });
		repository.rows.set(row.id, row);
		await assert.rejects(playback.getManifest(row.id), (error: unknown) => {
			assert.ok(error instanceof RecordingPlaybackUnavailableError);
			assert.equal(error.statusCode, 409);
			assert.equal(
				error.code,
				status === "failed"
					? RECORDING_PLAYBACK_ERROR_CODE.failed
					: status === "cancelled"
						? RECORDING_PLAYBACK_ERROR_CODE.cancelled
						: RECORDING_PLAYBACK_ERROR_CODE.notReady
			);
			return true;
		});
	}

	const missing = makeRow({ filePath: join(tmp, "missing.mkv") });
	repository.rows.set(missing.id, missing);
	await assert.rejects(playback.getManifest(missing.id), (error: unknown) => {
		assert.ok(error instanceof RecordingPlaybackUnavailableError);
		assert.equal(error.statusCode, 410);
		assert.equal(error.code, RECORDING_PLAYBACK_ERROR_CODE.fileMissing);
		return true;
	});

	const failed = makeRow({ status: "failed", filePath: input });
	repository.rows.set(failed.id, failed);
	const app = express();
	app.use(requestId());
	app.use(
		createRecordingsRouter({
			getPlaybackManifest: (id: string) => playback.getManifest(id)
		} as unknown as RecordingsService)
	);
	app.use(errorHandler());
	const response = await request(app).get(
		`/recordings/${failed.id}/stream.m3u8`
	);
	assert.equal(response.status, 409);
	assert.equal(response.body.error.code, RECORDING_PLAYBACK_ERROR_CODE.failed);
});

test("idle expiration releases the session while retaining finalized VOD", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-idle-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		idleMs: 30,
		runner: createFakeRunner()
	});

	await playback.getManifest(row.id);
	const output = playback.getSession(row.id)?.getOutputDirectory();
	assert.ok(output);
	await waitFor(() => playback.getActiveSessionCount() === 0, 3_000);
	// Finalized media belongs to the recording, not the short-lived viewer session.
	assert.equal((await stat(output)).isDirectory(), true);
	assert.equal((await stat(join(output, "master.m3u8"))).isFile(), true);
});

test("stop during session startup cancels pending work without orphan artifacts", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-start-stop-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let releaseProbe: (() => void) | undefined;
	let probeStarted = false;
	let spawnCount = 0;
	const probeGate = new Promise<void>((resolve) => {
		releaseProbe = resolve;
	});
	const runner: RecordingPlaybackRunner = {
		probe: async () => {
			probeStarted = true;
			await probeGate;
			return {
				videoCodec: "h264",
				videoProfile: "Main",
				videoLevel: 40,
				audioCodec: "aac"
			};
		},
		spawn: (args) => {
			spawnCount += 1;
			return createFakeProcess(outputDirectory(args));
		}
	};
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner
	});

	const manifest = playback.getManifest(row.id);
	await waitFor(() => probeStarted, 1_000);
	const stopped = playback.stop(row.id);
	releaseProbe?.();
	await stopped;
	await assert.rejects(manifest);
	assert.equal(playback.getActiveSessionCount(), 0);
	assert.equal(spawnCount, 0);
	const remaining = await readdir(tmp);
	assert.equal(
		remaining.some((name) =>
			name.startsWith("signalhaven-recording-playback-")
		),
		false
	);
});

test("viewer release during startup prevents a late FFmpeg spawn", async (t) => {
	const tmp = await mkdtemp(
		join(tmpdir(), "signalhaven-playback-release-start-")
	);
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input });
	repository.rows.set(row.id, row);
	let releaseProbe: (() => void) | undefined;
	let probeStarted = false;
	let spawnCount = 0;
	const probeGate = new Promise<void>((resolve) => {
		releaseProbe = resolve;
	});
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: {
			probe: async () => {
				probeStarted = true;
				await probeGate;
				return { videoCodec: "h264", audioCodec: "aac" };
			},
			spawn: (args) => {
				spawnCount += 1;
				return createFakeProcess(outputDirectory(args));
			}
		}
	});
	const viewerId = randomUUID();
	const manifest = playback.getManifest(row.id, {}, 0, viewerId);
	const rejected = assert.rejects(manifest);
	await waitFor(() => probeStarted, 1_000);
	assert.equal(playback.releaseViewer(row.id, viewerId), true);
	releaseProbe?.();
	await rejected;
	await waitFor(() => playback.getActiveSessionCount() === 0, 1_000);
	assert.equal(spawnCount, 0);
});

test("rapid seeks share one finalized VOD session", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "signalhaven-playback-latest-"));
	t.after(async () => rm(tmp, { recursive: true, force: true }));
	const input = join(tmp, "recording.mkv");
	await writeFile(input, "recording bytes");
	const repository = new FakeRecordingsRepo();
	const row = makeRow({ filePath: input, durationSeconds: 3_000 });
	repository.rows.set(row.id, row);
	let spawnCount = 0;
	const playback = new RecordingPlaybackService({
		repository,
		tmpRoot: tmp,
		runner: createFakeRunner(() => {
			spawnCount += 1;
		})
	});
	t.after(async () => playback.stopAll());
	const viewerId = randomUUID();
	const first = playback.getManifest(row.id, {}, 600, viewerId);
	const second = playback.getManifest(row.id, {}, 1_200, viewerId);
	const third = playback.getManifest(row.id, {}, 1_800, viewerId);

	const manifests = await Promise.all([first, second, third]);
	await waitFor(() => playback.getActiveSessionCount() === 1, 1_000);
	assert.match(manifests[0], /TIME-OFFSET=600\.000/);
	assert.match(manifests[1], /TIME-OFFSET=1200\.000/);
	assert.match(manifests[2], /TIME-OFFSET=1800\.000/);
	assert.equal(playback.getSession(row.id, 0)?.getViewerCount(), 1);
	assert.equal(spawnCount, 1);
});

const mediaToolsAvailable = (() => {
	const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
	const ffprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" });
	const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
		encoding: "utf8"
	});
	return (
		ffmpeg.status === 0 &&
		ffprobe.status === 0 &&
		encoders.status === 0 &&
		/libx264/.test(encoders.stdout ?? "")
	);
})();

/** Create a deterministic recording that exercises browser transcode paths. */
function writeSyntheticRecording(input: string, durationSeconds: number): void {
	const fixture = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=160x120:rate=10",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=1000:sample_rate=48000",
			"-t",
			String(durationSeconds),
			"-shortest",
			"-c:v",
			"mpeg2video",
			"-c:a",
			"mp2",
			"-f",
			"matroska",
			input
		],
		{ encoding: "utf8" }
	);
	assert.equal(fixture.status, 0, fixture.stderr);
}

test(
	"integration: long recordings publish only a finalized VOD manifest",
	{ skip: !mediaToolsAvailable && "ffmpeg, ffprobe, or libx264 unavailable" },
	async (t) => {
		const tmp = await mkdtemp(
			join(tmpdir(), "signalhaven-playback-progressive-")
		);
		t.after(async () => rm(tmp, { recursive: true, force: true }));
		const input = join(tmp, "long-synthetic.mkv");
		writeSyntheticRecording(input, 12);

		const repository = new FakeRecordingsRepo();
		const row = makeRow({ filePath: input });
		repository.rows.set(row.id, row);
		const runner: RecordingPlaybackRunner = {
			probe: probeMedia,
			spawn: (args) => {
				const inputIndex = args.indexOf("-i");
				assert.ok(inputIndex >= 0);
				// Real-time input proves readiness waits for a closed VOD timeline.
				const pacedArgs = [
					...args.slice(0, inputIndex),
					"-re",
					...args.slice(inputIndex)
				];
				return spawn("ffmpeg", pacedArgs, {
					stdio: ["ignore", "ignore", "pipe"]
				});
			}
		};
		const playback = new RecordingPlaybackService({
			repository,
			runner,
			tmpRoot: tmp,
			idleMs: 5_000,
			startTimeoutMs: 9_000
		});
		t.after(async () => playback.stopAll());

		const manifest = await playback.getManifest(row.id);

		assert.match(manifest, /#EXTM3U/);
		assert.match(manifest, /segments\/480p\.m3u8/);
		assert.equal(playback.getSession(row.id)?.getState(), "ready");
		const renditionUri = manifest
			.split(/\r?\n/)
			.find((line) => line.startsWith("segments/"));
		assert.ok(renditionUri);
		const parsed = new URL(
			renditionUri,
			"http://localhost/recordings/id/stream.m3u8"
		);
		const rendition = await playback.getSegment(
			row.id,
			parsed.searchParams.get("session") ?? "",
			parsed.pathname.split("/").pop() ?? ""
		);
		assert.match(rendition.toString("utf8"), /#EXT-X-ENDLIST/);
	}
);

test(
	"integration: completed MKV returns a playable HLS manifest and segment",
	{ skip: !mediaToolsAvailable && "ffmpeg, ffprobe, or libx264 unavailable" },
	async (t) => {
		const tmp = await mkdtemp(
			join(tmpdir(), "signalhaven-playback-integration-")
		);
		t.after(async () => rm(tmp, { recursive: true, force: true }));
		const input = join(tmp, "synthetic.mkv");
		writeSyntheticRecording(input, 2);

		const repository = new FakeRecordingsRepo();
		const row = makeRow({ filePath: input });
		repository.rows.set(row.id, row);
		const playback = new RecordingPlaybackService({
			repository,
			tmpRoot: tmp,
			idleMs: 5_000
		});
		t.after(async () => playback.stopAll());
		const routeService = {
			getPlaybackManifest: (id: string) => playback.getManifest(id),
			getPlaybackSegment: (id: string, session: string, segment: string) =>
				playback.getSegment(id, session, segment)
		} as unknown as RecordingsService;
		const app = express();
		app.use(createRecordingsRouter(routeService));

		const manifestPath = `/recordings/${row.id}/stream.m3u8`;
		const manifest = await request(app).get(manifestPath);
		assert.equal(manifest.status, 200);
		assert.match(manifest.headers["content-type"] ?? "", /mpegurl/);
		assert.match(manifest.text, /#EXTM3U/);
		const segmentUri = manifest.text
			.split(/\r?\n/)
			.find((line) => line.startsWith("segments/"));
		assert.ok(segmentUri);

		const renditionUrl = new URL(segmentUri, `http://localhost${manifestPath}`);
		const rendition = await request(app).get(
			`${renditionUrl.pathname}${renditionUrl.search}`
		);
		assert.equal(rendition.status, 200);
		assert.match(rendition.headers["content-type"] ?? "", /mpegurl/);
		const renditionSegmentUri = rendition.text
			.split(/\r?\n/)
			.find((line) => line.length > 0 && !line.startsWith("#"));
		assert.ok(renditionSegmentUri);
		const segmentUrl = new URL(
			renditionSegmentUri,
			`http://localhost${renditionUrl.pathname}`
		);
		const segment = await request(app).get(
			`${segmentUrl.pathname}${segmentUrl.search}`
		);
		assert.equal(segment.status, 200);
		assert.match(segment.headers["content-type"] ?? "", /video\/iso\.segment/);
		assert.ok(segment.body.length > 0);

		const initMatch = /#EXT-X-MAP:URI="([^"]+)"/.exec(rendition.text);
		assert.ok(initMatch?.[1]);
		const initUrl = new URL(
			initMatch[1],
			`http://localhost${renditionUrl.pathname}`
		);
		const init = await request(app).get(`${initUrl.pathname}${initUrl.search}`);
		assert.equal(init.status, 200);
		assert.match(init.headers["content-type"] ?? "", /video\/mp4/);

		const downloaded = join(tmp, "downloaded.mp4");
		// A fragmented media segment needs its initialization box for probing.
		await writeFile(downloaded, Buffer.concat([init.body, segment.body]));
		const probe = spawnSync(
			"ffprobe",
			["-v", "error", "-show_streams", downloaded],
			{ encoding: "utf8" }
		);
		assert.equal(probe.status, 0, probe.stderr);
		assert.match(probe.stdout, /codec_type=video/);

		await playback.stopAll();
		const remaining = await readdir(tmp);
		assert.equal(
			remaining.some((name) =>
				name.startsWith("signalhaven-recording-playback-")
			),
			false
		);
	}
);

/** Poll an eventually-cleaned session without pinning tests to timer ordering. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs: number
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for playback session cleanup");
}
