import assert from "node:assert/strict";
import {
	spawn as nodeSpawn,
	spawnSync,
	type ChildProcess
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app";
import { EventBus } from "../src/events/event-bus";
import type { HealthRepository } from "../src/repositories/health.repository";
import { StreamSession } from "../src/streaming/stream-session";
import {
	StreamingService,
	type ResolvedStreamSource,
	type StreamSourceResolver
} from "../src/streaming/streaming.service";
import { TunerAllocator } from "../src/tuners/tuner-allocator";
import { TunerRegistry } from "../src/tuners/provider";
import { TunersService } from "../src/tuners/tuners.service";

function stubHealthRepository(): HealthRepository {
	return { isHealthy: async () => true } as unknown as HealthRepository;
}

function stubTunersService(allocator?: TunerAllocator): TunersService {
	// The streaming integration test only needs the app to mount the route;
	// it injects its own `StreamingService` so the underlying `TunersService`
	// is unused for stream resolution. We still need a real instance so the
	// app can start.
	return new TunersService({
		repository: {
			list: async () => [],
			getById: async () => null,
			create: async () => {
				throw new Error("not used");
			},
			update: async () => null,
			delete: async () => false
		} as unknown as ConstructorParameters<
			typeof TunersService
		>[0]["repository"],
		registry: new TunerRegistry(),
		...(allocator ? { allocator } : {})
	});
}

const ffmpegAvailable = (() => {
	try {
		const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
		return result.status === 0;
	} catch {
		return false;
	}
})();

function buildSyntheticResolver(providerId: string): {
	resolver: StreamSourceResolver;
} {
	const resolver: StreamSourceResolver = {
		resolve: async (): Promise<ResolvedStreamSource> => ({
			providerId,
			providerChannelId: "synthetic",
			// Filtergraph fed to `-f lavfi -i ...` by the test runner below.
			// Generates a synthetic A/V source we can transcode without any
			// external dependency.
			upstreamUrl: "testsrc2=size=160x120:rate=10"
		})
	};
	return { resolver };
}

test(
	"Streaming proxy fans out one ffmpeg session to multiple HTTP clients",
	{ skip: !ffmpegAvailable && "ffmpeg not installed" },
	async (t) => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-stream-test-"));
		t.after(async () => {
			await rm(tmpRoot, { recursive: true, force: true });
		});

		const providerId = randomUUID();
		const { resolver } = buildSyntheticResolver(providerId);
		const bus = new EventBus();
		// Build the allocator first and share it with both the streaming
		// service and the stub `TunersService` so the lease appears in
		// `/api/v1/tuners/activity` (the real wiring in `app.ts` does the
		// same via `tunersService.getAllocator()`).
		const allocator = new TunerAllocator({ capacity: async () => 4 });
		const tunersService = stubTunersService(allocator);

		// Use lavfi as a true input via the `-f lavfi` form by injecting a
		// custom runner that prepends the input format flag. ffmpeg needs
		// `-f lavfi` before `-i <filter>` to interpret the URL as a graph.
		const streaming = new StreamingService({
			allocator,
			resolver,
			bus,
			lingerMs: 1500,
			tmpRoot,
			runner: {
				spawn: (args) => {
					// Inject `-f lavfi` immediately before `-i` so testsrc is
					// interpreted as a filtergraph rather than a file path. lavfi
					// produces raw video, so swap `-c copy` for an actual encoder
					// (the production pipeline assumes the upstream is already
					// h264/aac and stream-copies; the test source is raw).
					const inputIdx = args.indexOf("-i");
					const enriched = [
						...args.slice(0, inputIdx),
						"-f",
						"lavfi",
						...args.slice(inputIdx)
					];
					const cIdx = enriched.indexOf("-c");
					if (cIdx !== -1 && enriched[cIdx + 1] === "copy") {
						enriched.splice(
							cIdx,
							2,
							"-c:v",
							"libx264",
							"-preset",
							"ultrafast",
							"-tune",
							"zerolatency",
							"-pix_fmt",
							"yuv420p"
						);
					}
					return nodeSpawn("ffmpeg", enriched, {
						stdio: ["ignore", "ignore", "pipe"]
					});
				}
			}
		});

		const app = createApp({
			env: { ...process.env, NODE_ENV: "test" },
			healthRepository: stubHealthRepository(),
			tunersService,
			streamingService: streaming,
			bus
		});

		const channelId = "ch-1";

		// ---------- two concurrent clients share one session ----------
		const [resp1, resp2] = await Promise.all([
			request(app).get(
				`/api/v1/stream/${channelId}/master.m3u8?profile=direct`
			),
			request(app).get(`/api/v1/stream/${channelId}/master.m3u8?profile=direct`)
		]);

		assert.equal(resp1.status, 200, "first master.m3u8 should be 200");
		assert.equal(resp2.status, 200, "second master.m3u8 should be 200");
		assert.match(resp1.headers["content-type"] ?? "", /mpegurl/);
		assert.equal(resp1.headers["access-control-allow-origin"], "*");
		assert.match(resp1.headers["cache-control"] ?? "", /no-store/);
		assert.match(resp1.text, /^#EXTM3U/);
		assert.match(resp1.text, /playlist\.m3u8/);

		// Only one tuner lease should exist even though two clients asked.
		const leases = allocator.getActivity();
		assert.equal(leases.length, 1, "only one shared tuner lease");
		assert.equal(leases[0]?.providerId, providerId);

		// The session shows up via `/api/v1/tuners/activity` (sourced from the
		// same allocator the streaming service holds).
		const activity = await request(app).get("/api/v1/tuners/activity");
		assert.equal(activity.status, 200);
		assert.equal(activity.body.leases.length, 1);
		assert.equal(activity.body.leases[0].providerId, providerId);

		// ---------- media playlist is reachable while session is up ----------
		const playlistResp = await request(app).get(
			`/api/v1/stream/${channelId}/playlist.m3u8?profile=direct`
		);
		assert.equal(playlistResp.status, 200);
		assert.match(playlistResp.text, /^#EXTM3U/);
		assert.match(
			playlistResp.text,
			/seg-/,
			"playlist should reference segments"
		);

		// ---------- detach both clients; session lingers then tears down ----
		// The supertest responses already drained; their `res.on('close')` /
		// `'finish'` handlers fired, so refCount should be back at 0.
		const session = streaming.getSession(channelId);
		assert.ok(session, "session should still exist during linger");
		assert.equal(
			session?.getRefCount(),
			0,
			"all clients have detached after their requests finished"
		);

		await new Promise<void>((resolve) => {
			session?.onStopped(() => resolve());
		});

		assert.equal(allocator.getActivity().length, 0, "lease released on stop");
		assert.equal(
			streaming.getSession(channelId),
			undefined,
			"session entry cleaned up"
		);

		await new Promise((r) => setTimeout(r, 50));
	}
);

test("StreamSession runs ffmpeg once for many concurrent attaches", async () => {
	// No ffmpeg dependency: stub the runner with a fake child process.
	let spawnCount = 0;
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-fake-"));
	try {
		let createdOutDir = "";
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				spawnCount += 1;
				const idx = args.indexOf("-hls_segment_filename");
				const segPattern = args[idx + 1] as string;
				createdOutDir = segPattern.substring(0, segPattern.lastIndexOf("/"));
				return makeFakeProcess(createdOutDir);
			}
		};

		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();
		const lease = await allocator.acquire({
			providerId,
			channelId: "x",
			purpose: "live",
			priority: 0
		});

		const session = new StreamSession({
			sessionId: "ch",
			upstreamUrl: "fake://input",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			runner,
			tmpRoot
		});

		await session.start();
		assert.equal(spawnCount, 1, "ffmpeg spawned exactly once");
		assert.equal(session.getState(), "ready");

		// Ten concurrent attaches share one process.
		for (let i = 0; i < 10; i += 1) {
			session.attach();
		}
		assert.equal(spawnCount, 1, "no extra ffmpeg processes");
		assert.equal(session.getRefCount(), 10);
		assert.equal(allocator.getActivity().length, 1);

		// Detach all; with lingerMs=0 the session tears down immediately.
		for (let i = 0; i < 10; i += 1) {
			session.detach();
		}
		await new Promise<void>((resolve) => session.onStopped(() => resolve()));
		assert.equal(session.getState(), "stopped");
		assert.equal(
			allocator.getActivity().length,
			0,
			"lease released after tear-down"
		);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("adaptive playlists route fMP4 initialization and media fragments", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-adaptive-fmp4-"));
	try {
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const lease = await allocator.acquire({
			providerId: randomUUID(),
			channelId: "adaptive",
			purpose: "live",
			priority: 0
		});
		const session = new StreamSession({
			sessionId: "adaptive",
			upstreamUrl: "fake://input",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			tmpRoot,
			profile: "auto",
			inputCodecs: { width: 854, height: 480 },
			runner: {
				spawn: (args) => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					return makeAdaptiveFakeProcess(pattern.split("/%v/")[0] ?? "");
				}
			}
		});

		await session.start();
		const playlist = await session.readRenditionPlaylist("480p");
		assert.match(
			playlist,
			/#EXT-X-MAP:URI="segments\/init_480p\.mp4\?profile=auto"/
		);
		assert.match(playlist, /segments\/seg-00000\.m4s\?profile=auto/);
		assert.deepEqual(
			await session.readRenditionSegment("480p", "init_480p.mp4"),
			Buffer.from("initialization fragment")
		);

		const stopped = new Promise<void>((resolve) =>
			session.onStopped(() => resolve())
		);
		session.stop();
		await stopped;
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("StreamSession lingers, then releases lease after lingerMs", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-fake-"));
	try {
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				const idx = args.indexOf("-hls_segment_filename");
				const segPattern = args[idx + 1] as string;
				const dir = segPattern.substring(0, segPattern.lastIndexOf("/"));
				return makeFakeProcess(dir);
			}
		};

		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();
		const lease = await allocator.acquire({
			providerId,
			channelId: "x",
			purpose: "live",
			priority: 0
		});

		const session = new StreamSession({
			sessionId: "ch",
			upstreamUrl: "fake://input",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 75,
			runner,
			tmpRoot
		});

		await session.start();
		session.attach();
		session.detach();

		assert.equal(
			session.getState(),
			"lingering",
			"linger window starts after last detach"
		);
		// Re-attach during linger keeps the session alive.
		session.attach();
		assert.equal(session.getState(), "ready");
		session.detach();

		await new Promise<void>((resolve) => session.onStopped(() => resolve()));
		assert.equal(session.getState(), "stopped");
		assert.equal(allocator.getActivity().length, 0);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("viewer release stops the stream immediately after the last viewer leaves", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-viewer-release-"));
	try {
		const providerId = randomUUID();
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const streaming = new StreamingService({
			allocator,
			lingerMs: 60_000,
			tmpRoot,
			resolver: {
				resolve: async () => ({
					providerId,
					providerChannelId: "viewer-release",
					upstreamUrl: "fake://input"
				})
			},
			runner: {
				spawn: (args) => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					return makeFakeProcess(
						pattern.substring(0, pattern.lastIndexOf("/"))
					);
				}
			}
		});
		const channelId = "viewer-release-channel";
		const firstViewerId = randomUUID();
		const secondViewerId = randomUUID();
		const app = createApp({
			env: { ...process.env, NODE_ENV: "test" },
			healthRepository: stubHealthRepository(),
			tunersService: stubTunersService(allocator),
			streamingService: streaming
		});

		const session = await streaming.attach(channelId, "direct");
		session.attachViewer(firstViewerId);
		session.attachViewer(secondViewerId);
		// Release the transient manifest request while logical viewers remain.
		session.detach();
		assert.equal(session.getViewerCount(), 2);
		assert.match(
			session.buildMasterPlaylist(firstViewerId),
			new RegExp(`viewerId=${firstViewerId}`),
			"media playlist requests retain the logical viewer id"
		);

		const firstRelease = await request(app).post(
			`/api/v1/stream/${channelId}/viewers/${firstViewerId}/release`
		);
		assert.equal(firstRelease.status, 204);
		assert.equal(session.getState(), "ready");
		assert.equal(session.getViewerCount(), 1);

		const stopped = new Promise<void>((resolve) =>
			session.onStopped(() => resolve())
		);
		assert.equal(
			streaming.releaseViewer(channelId, secondViewerId, "direct"),
			true
		);
		await stopped;
		assert.equal(streaming.getSession(channelId, "direct"), undefined);
		assert.equal(allocator.getActivity().length, 0);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("an inactive viewer expires when its unload beacon is lost", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-viewer-expiry-"));
	try {
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const streaming = new StreamingService({
			allocator,
			lingerMs: 60_000,
			viewerTimeoutMs: 25,
			tmpRoot,
			resolver: {
				resolve: async () => ({
					providerId: randomUUID(),
					providerChannelId: "viewer-expiry",
					upstreamUrl: "fake://input"
				})
			},
			runner: {
				spawn: (args) => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					return makeFakeProcess(
						pattern.substring(0, pattern.lastIndexOf("/"))
					);
				}
			}
		});
		const channelId = "viewer-expiry-channel";
		const session = await streaming.attach(channelId, "direct");
		session.attachViewer(randomUUID());
		session.detach();
		await Promise.race([
			new Promise<void>((resolve) => session.onStopped(() => resolve())),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("viewer did not expire")), 500)
			)
		]);

		assert.equal(streaming.getSession(channelId, "direct"), undefined);
		assert.equal(allocator.getActivity().length, 0);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("a recording preemption stops the matching live process and buffer", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-preemption-"));
	try {
		const bus = new EventBus();
		const allocator = new TunerAllocator({ capacity: async () => 1, bus });
		const providerId = randomUUID();
		const streaming = new StreamingService({
			allocator,
			bus,
			tmpRoot,
			resolver: {
				resolve: async () => ({
					providerId,
					providerChannelId: "preempted-live",
					upstreamUrl: "fake://input"
				})
			},
			runner: {
				spawn: (args) => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					return makeFakeProcess(
						pattern.substring(0, pattern.lastIndexOf("/"))
					);
				}
			}
		});

		const session = await streaming.attach("preempted-channel");
		const stopped = new Promise<void>((resolve) =>
			session.onStopped(() => resolve())
		);
		const recordingLease = await allocator.acquire({
			providerId,
			channelId: "recording",
			purpose: "record",
			priority: 100
		});
		await stopped;

		assert.equal(session.getLastError()?.category, "tuner_preempted");
		assert.equal(streaming.getSession("preempted-channel"), undefined);
		assert.deepEqual(
			(await readdir(tmpRoot)).filter((name) =>
				name.startsWith("signalhaven-stream-")
			),
			[]
		);
		allocator.release(recordingLease.leaseId);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("operator stop blocks playlist retries until requests go quiet", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-operator-stop-"));
	try {
		let spawnCount = 0;
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				spawnCount += 1;
				const pattern = args[
					args.indexOf("-hls_segment_filename") + 1
				] as string;
				return makeFakeProcess(pattern.substring(0, pattern.lastIndexOf("/")));
			}
		};
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();
		const resolver: StreamSourceResolver = {
			resolve: async (): Promise<ResolvedStreamSource> => ({
				providerId,
				providerChannelId: "operator-stop",
				upstreamUrl: "fake://input"
			})
		};
		const streaming = new StreamingService({
			allocator,
			resolver,
			operatorStopQuietMs: 250,
			runner,
			tmpRoot
		});
		const channelId = "operator-stopped-channel";
		const session = await streaming.attach(channelId);
		const stopped = new Promise<void>((resolve) =>
			session.onStopped(() => resolve())
		);

		assert.equal(streaming.stopSession(`${channelId}\u001fdirect`), true);
		await stopped;
		await assert.rejects(
			streaming.attach(channelId),
			/stopped by an operator/,
			"a late playlist request must not recreate FFmpeg"
		);
		assert.equal(spawnCount, 1);

		// Each rejected retry extends the barrier until the requester is quiet.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await assert.rejects(streaming.attach(channelId), /stopped by an operator/);
		await new Promise((resolve) => setTimeout(resolve, 300));

		const replacement = await streaming.attach(channelId);
		assert.equal(
			spawnCount,
			2,
			"a deliberate later open starts a fresh session"
		);
		replacement.detach();
		await streaming.stopAll();
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("logical channels fall back when the preferred tuner has no capacity", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-source-fallback-"));
	try {
		const primaryProviderId = randomUUID();
		const backupProviderId = randomUUID();
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const occupied = await allocator.acquire({
			providerId: primaryProviderId,
			channelId: "other-channel",
			purpose: "live",
			priority: 0
		});
		const resolver: StreamSourceResolver = {
			resolve: async () => {
				throw new Error("resolveCandidates should own grouped selection");
			},
			resolveCandidates: async () => [
				{
					providerId: primaryProviderId,
					providerChannelId: "news-primary",
					upstreamUrl: "fake://primary"
				},
				{
					providerId: backupProviderId,
					providerChannelId: "news-backup",
					upstreamUrl: "fake://backup"
				}
			]
		};
		const streaming = new StreamingService({
			allocator,
			resolver,
			tmpRoot,
			runner: {
				spawn: (args) => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					return makeFakeProcess(
						pattern.substring(0, pattern.lastIndexOf("/"))
					);
				}
			}
		});

		const session = await streaming.attach(randomUUID());

		assert.equal(session.lease.providerId, backupProviderId);
		session.detach();
		await streaming.stopAll();
		allocator.release(occupied.leaseId);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("StreamSession stops and cleans up when its buffer exceeds the disk limit", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-buffer-limit-"));
	try {
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const lease = await allocator.acquire({
			providerId: randomUUID(),
			channelId: "buffer-limit",
			purpose: "live",
			priority: 0
		});
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				const pattern = args[
					args.indexOf("-hls_segment_filename") + 1
				] as string;
				return makeFakeProcess(pattern.substring(0, pattern.lastIndexOf("/")));
			}
		};
		const session = new StreamSession({
			sessionId: "buffer-limit",
			upstreamUrl: "fake://input",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 1_000,
			runner,
			tmpRoot,
			timeShiftWindowSeconds: 60,
			maxBufferBytes: 1,
			bufferCheckIntervalMs: 10
		});

		await session.start();
		await new Promise<void>((resolve) => session.onStopped(() => resolve()));

		assert.equal(session.getState(), "stopped");
		assert.equal(session.getLastError()?.category, "time_shift_disk_limit");
		assert.equal(allocator.getActivity().length, 0);
		assert.deepEqual(
			(await readdir(tmpRoot)).filter((name) =>
				name.startsWith("signalhaven-stream-")
			),
			[]
		);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("StreamSession reuses cached sizes for unchanged time-shift segments", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-buffer-cache-"));
	try {
		let outDir = "";
		const statCounts = new Map<string, number>();
		let resolveFirstUsage: (() => void) | undefined;
		const firstUsage = new Promise<void>((resolve) => {
			resolveFirstUsage = resolve;
		});
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const lease = await allocator.acquire({
			providerId: randomUUID(),
			channelId: "buffer-cache",
			purpose: "live",
			priority: 0
		});
		const session = new StreamSession({
			sessionId: "buffer-cache",
			upstreamUrl: "fake://input",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 1_000,
			runner: {
				spawn: (args): ChildProcess => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					outDir = pattern.substring(0, pattern.lastIndexOf("/"));
					return makeFakeProcess(outDir);
				}
			},
			tmpRoot,
			timeShiftWindowSeconds: 60,
			maxBufferBytes: 1024 ** 2,
			bufferCheckIntervalMs: 60_000,
			bufferStat: async (path) => {
				const name = path.substring(path.lastIndexOf("/") + 1);
				statCounts.set(name, (statCounts.get(name) ?? 0) + 1);
				return stat(path);
			},
			onBufferUsage: () => resolveFirstUsage?.()
		});

		await session.start();
		await firstUsage;
		assert.equal(statCounts.get("seg-00000.ts"), 1);

		// Invoke the monitor directly so the regression test does not depend on timers.
		await (
			session as unknown as { checkBufferUsage(): Promise<void> }
		).checkBufferUsage();
		assert.equal(
			statCounts.get("seg-00000.ts"),
			1,
			"an unchanged finalized segment should not be statted again"
		);

		await writeFile(join(outDir, "seg-00001.ts"), "next segment");
		await (
			session as unknown as { checkBufferUsage(): Promise<void> }
		).checkBufferUsage();
		assert.equal(statCounts.get("seg-00000.ts"), 1);
		assert.equal(statCounts.get("seg-00001.ts"), 1);

		await rm(join(outDir, "seg-00000.ts"), { force: true });
		await (
			session as unknown as { checkBufferUsage(): Promise<void> }
		).checkBufferUsage();
		const playlistSize = (await stat(join(outDir, "playlist.m3u8"))).size;
		const nextSegmentSize = (await stat(join(outDir, "seg-00001.ts"))).size;
		assert.equal(
			session.getTimeShiftStatus().bufferBytes,
			playlistSize + nextSegmentSize,
			"removed segments should no longer contribute cached bytes"
		);

		const stopped = new Promise<void>((resolve) =>
			session.onStopped(() => resolve())
		);
		session.stop();
		await stopped;
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

interface FakeProcess extends EventEmitter {
	stderr: EventEmitter;
	kill: (sig: string) => void;
	exitCode: number | null;
	signalCode: string | null;
}

function makeFakeProcess(outDir: string): ChildProcess {
	const proc = new EventEmitter() as FakeProcess;
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.signalCode = null;
	proc.kill = (sig: string): void => {
		proc.signalCode = sig;
		setImmediate(() => proc.emit("exit", null, sig));
	};
	// Write a fake playlist asynchronously to satisfy `pollForPlaylist`.
	setImmediate(async () => {
		await mkdir(outDir, { recursive: true });
		await writeFile(join(outDir, "seg-00000.ts"), "fake segment");
		await writeFile(
			join(outDir, "playlist.m3u8"),
			"#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.0,\nseg-00000.ts\n"
		);
	});
	return proc as unknown as ChildProcess;
}

/** Publish a minimal adaptive fMP4 tree without depending on FFmpeg timing. */
function makeAdaptiveFakeProcess(outDir: string): ChildProcess {
	const proc = new EventEmitter() as FakeProcess;
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.signalCode = null;
	proc.kill = (sig: string): void => {
		proc.signalCode = sig;
		setImmediate(() => proc.emit("exit", null, sig));
	};
	setImmediate(async () => {
		const renditionDir = join(outDir, "480p");
		await mkdir(renditionDir, { recursive: true });
		await writeFile(
			join(renditionDir, "init_480p.mp4"),
			"initialization fragment"
		);
		await writeFile(join(renditionDir, "seg-00000.m4s"), "media fragment");
		await writeFile(
			join(renditionDir, "playlist.m3u8"),
			'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init_480p.mp4"\n#EXTINF:2.0,\nseg-00000.m4s\n'
		);
		await writeFile(
			join(outDir, "master.m3u8"),
			"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\n480p/playlist.m3u8\n"
		);
	});
	return proc as unknown as ChildProcess;
}

test("failed startup writes one sanitized structured log without subscribers", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-startup-failure-"));
	try {
		const logs: Array<{
			context: Record<string, unknown>;
			message: string;
		}> = [];
		const upstreamUrl =
			"http://viewer:secret@192.168.1.20:5004/auto/v11.1?token=private";
		const providerId = randomUUID();
		const channelId = randomUUID();
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const resolver: StreamSourceResolver = {
			resolve: async (): Promise<ResolvedStreamSource> => ({
				providerId,
				providerChannelId: "11.1",
				upstreamUrl
			})
		};
		const runner = {
			spawn: (): ChildProcess => {
				const proc = new EventEmitter() as FakeProcess;
				proc.stderr = new EventEmitter();
				proc.exitCode = null;
				proc.signalCode = null;
				proc.kill = () => undefined;
				// Emit a representative tuner failure before ffmpeg exits.
				setImmediate(() => {
					proc.stderr.emit(
						"data",
						Buffer.from(
							`HTTP error 503 Service Unavailable for ${upstreamUrl}\n`
						)
					);
					proc.stderr.emit("end");
					proc.exitCode = 8;
					proc.emit("exit", 8, null);
				});
				return proc as unknown as ChildProcess;
			}
		};

		const streaming = new StreamingService({
			allocator,
			resolver,
			runner,
			tmpRoot,
			transcodingResolver: {
				resolve: async () => ({
					profile: "720p",
					hwaccel: "vaapi",
					captionsEnabled: false
				})
			},
			// No event bus is supplied: durable diagnostics must not depend on it.
			logger: {
				error: (context: Record<string, unknown>, message: string) => {
					logs.push({ context, message });
				}
			}
		});

		await assert.rejects(streaming.attach(channelId), /ffmpeg exited/);
		assert.equal(logs.length, 1, "one terminal summary avoids per-line spam");
		assert.equal(logs[0]?.message, "Stream session failed to start");
		assert.deepEqual(logs[0]?.context, {
			channelId,
			providerId,
			profile: "720p",
			hwaccel: "vaapi",
			exitCode: 8,
			signal: null,
			errorCategory: "input_unreachable",
			errorMessage:
				"HTTP error 503 Service Unavailable for <redacted upstream URL>"
		});
		const serialized = JSON.stringify(logs);
		assert.doesNotMatch(serialized, /192\.168\.1\.20|viewer|secret|private/);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("StreamSession reports whether live output is keeping up in real time", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-progress-"));
	try {
		const providerId = randomUUID();
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const lease = await allocator.acquire({
			providerId,
			channelId: "progress",
			purpose: "live",
			priority: 0
		});
		let process: FakeProcess | undefined;
		const session = new StreamSession({
			sessionId: "progress\u001f720p",
			channelId: "progress",
			upstreamUrl: "fake://input",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			profile: "720p",
			runner: {
				spawn: (args) => {
					const pattern = args[
						args.indexOf("-hls_segment_filename") + 1
					] as string;
					process = makeFakeProcess(
						pattern.substring(0, pattern.lastIndexOf("/"))
					) as unknown as FakeProcess;
					return process as unknown as ChildProcess;
				}
			},
			tmpRoot
		});

		await session.start();
		process?.stderr.emit(
			"data",
			Buffer.from(
				"frame=120\nfps=21.6\nout_time_us=86400000\nspeed=0.72x\nprogress=continue\n"
			)
		);

		const status = session.getPipelineStatus();
		assert.equal(status.mode, "transcode");
		assert.equal(status.health, "slow");
		assert.equal(status.speed, 0.72);
		assert.equal(status.fps, 21.6);
		assert.equal(status.outputTimeSeconds, 86.4);
		assert.ok(status.lastProgressAt);
		assert.ok((status.progressAgeSeconds ?? Infinity) < 1);

		const stopped = new Promise<void>((resolve) =>
			session.onStopped(() => resolve())
		);
		session.stop();
		await stopped;
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("media playlist segment URLs are served by the streaming route", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-segment-route-"));
	try {
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				const segmentIndex = args.indexOf("-hls_segment_filename");
				const segmentPattern = args[segmentIndex + 1] as string;
				const outDir = segmentPattern.substring(
					0,
					segmentPattern.lastIndexOf("/")
				);
				return makeFakeProcess(outDir);
			}
		};
		const providerId = randomUUID();
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const resolver: StreamSourceResolver = {
			resolve: async (): Promise<ResolvedStreamSource> => ({
				providerId,
				providerChannelId: "segment-route",
				upstreamUrl: "fake://input"
			})
		};
		const streaming = new StreamingService({
			allocator,
			resolver,
			lingerMs: 2_000,
			runner,
			tmpRoot
		});
		const app = createApp({
			env: { ...process.env, NODE_ENV: "test" },
			healthRepository: stubHealthRepository(),
			tunersService: stubTunersService(allocator),
			streamingService: streaming
		});
		const channelId = "ch-segment-route";

		// Start the session through the same entry point used by the player.
		const master = await request(app).get(
			`/api/v1/stream/${channelId}/master.m3u8?profile=direct`
		);
		assert.equal(master.status, 200);

		const playlistPath = `/api/v1/stream/${channelId}/playlist.m3u8?profile=direct`;
		const playlist = await request(app).get(playlistPath);
		assert.equal(playlist.status, 200);
		const segmentUri = playlist.text
			.split(/\r?\n/)
			.find((line) => line.length > 0 && !line.startsWith("#"));
		assert.equal(segmentUri, "segments/seg-00000.ts?profile=direct");

		// Resolve the playlist URI exactly as an HLS client does.
		const segmentUrl = new URL(segmentUri, `http://localhost${playlistPath}`);
		const segment = await request(app).get(
			`${segmentUrl.pathname}${segmentUrl.search}`
		);
		assert.equal(segment.status, 200);
		assert.deepEqual(segment.body, Buffer.from("fake segment"));

		await streaming.stopAll();
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("master.m3u8?profile=720p selects the 720p profile per session", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-profile-"));
	try {
		const spawned: string[][] = [];
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				spawned.push([...args]);
				const idx = args.indexOf("-hls_segment_filename");
				const segPattern = args[idx + 1] as string;
				const dir = segPattern.substring(0, segPattern.lastIndexOf("/"));
				return makeFakeProcess(dir);
			}
		};

		const providerId = randomUUID();
		const allocator = new TunerAllocator({ capacity: async () => 4 });
		const resolver: StreamSourceResolver = {
			resolve: async (): Promise<ResolvedStreamSource> => ({
				providerId,
				providerChannelId: "ch1",
				upstreamUrl: "udp://example/in"
			})
		};

		const streaming = new StreamingService({
			allocator,
			resolver,
			lingerMs: 2_000,
			tmpRoot,
			runner
		});

		const tunersService = stubTunersService(allocator);
		const app = createApp({
			env: { ...process.env, NODE_ENV: "test" },
			healthRepository: stubHealthRepository(),
			tunersService,
			streamingService: streaming
		});

		const channelId = "ch-profile";

		// Explicit direct remains a locked stream-copy recovery profile.
		const respDefault = await request(app).get(
			`/api/v1/stream/${channelId}/master.m3u8?profile=direct`
		);
		assert.equal(respDefault.status, 200);
		assert.match(respDefault.text, /^#EXTM3U/);

		// ?profile=720p triggers a SECOND ffmpeg session at 720p.
		const resp720 = await request(app).get(
			`/api/v1/stream/${channelId}/master.m3u8?profile=720p`
		);
		assert.equal(resp720.status, 200);
		// Peak bandwidth includes encoder overshoot; average reflects the target.
		assert.match(
			resp720.text,
			/#EXT-X-STREAM-INF:BANDWIDTH=7500000,AVERAGE-BANDWIDTH=3500000/
		);
		assert.match(
			resp720.text,
			/^playlist\.m3u8\?profile=720p$/m,
			"the media playlist request stays attached to the selected profile"
		);

		const respOriginal = await request(app).get(
			`/api/v1/stream/${channelId}/master.m3u8?profile=original-quality`
		);
		assert.equal(respOriginal.status, 200);
		assert.match(
			respOriginal.text,
			/BANDWIDTH=20000000/,
			"the peak bandwidth covers live encoder and MPEG-TS overhead"
		);
		assert.doesNotMatch(
			respOriginal.text,
			/CODECS=/,
			"the master must not guess a profile and level that differ from the payload"
		);

		assert.equal(spawned.length, 3, "one ffmpeg per (channel, profile)");
		const directArgs = spawned[0] ?? [];
		const sevenTwentyArgs = spawned[1] ?? [];
		assert.ok(
			directArgs.includes("-c") && directArgs.includes("copy"),
			"direct profile uses -c copy"
		);
		assert.equal(
			sevenTwentyArgs[sevenTwentyArgs.indexOf("-c:v") + 1],
			"libx264",
			"720p profile uses libx264 software encode"
		);
		assert.match(
			String(sevenTwentyArgs[sevenTwentyArgs.indexOf("-vf") + 1]),
			/min\(720,ih\)/
		);

		// /status surfaces the profile + last error fields.
		const status = await request(app).get(
			`/api/v1/stream/${channelId}/status?profile=720p`
		);
		assert.equal(status.status, 200);
		assert.equal(status.body.profile, "720p");
		assert.equal(status.body.lastError, null);

		// Invalid profile is rejected at the validation layer.
		const bad = await request(app).get(
			`/api/v1/stream/${channelId}/master.m3u8?profile=8k`
		);
		assert.equal(bad.status, 400);

		// Tear down so the test process exits cleanly.
		await streaming.stopAll();
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("captionsEnabled omitted on StreamSession → no SUBTITLES tag, no sidecar spawn", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-cc-off-"));
	try {
		const spawned: string[][] = [];
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				spawned.push([...args]);
				const idx = args.indexOf("-hls_segment_filename");
				const segPattern = args[idx + 1] as string;
				const dir = segPattern.substring(0, segPattern.lastIndexOf("/"));
				return makeFakeProcess(dir);
			}
		};
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();
		const lease = await allocator.acquire({
			providerId,
			channelId: "x",
			purpose: "live",
			priority: 0
		});

		const session = new StreamSession({
			sessionId: "ch",
			upstreamUrl: "http://upstream/cc.ts",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			runner,
			tmpRoot
		});

		await session.start();

		// Only the main ffmpeg should have been spawned — no sidecar.
		assert.equal(spawned.length, 1, "no captions sidecar when disabled");

		const master = session.buildMasterPlaylist();
		assert.doesNotMatch(master, /SUBTITLES/);
		assert.doesNotMatch(master, /captions\.m3u8/);

		session.attach();
		session.detach();
		await new Promise<void>((resolve) => session.onStopped(() => resolve()));
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("captions enabled → spawns extraction sidecar + master declares SUBTITLES", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-cc-on-"));
	try {
		const spawned: string[][] = [];
		const runner = {
			spawn: (args: string[]): ChildProcess => {
				spawned.push([...args]);
				// Both the main and the sidecar write into outDir; the helper
				// writes a fake `playlist.m3u8` (harmless for the sidecar) so
				// the polling loop in StreamSession unblocks.
				const segIdx = args.indexOf("-hls_segment_filename");
				const segPattern = args[segIdx + 1] as string;
				const dir = segPattern.substring(0, segPattern.lastIndexOf("/"));
				return makeFakeProcess(dir);
			}
		};
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();
		const lease = await allocator.acquire({
			providerId,
			channelId: "x",
			purpose: "live",
			priority: 0
		});

		const session = new StreamSession({
			sessionId: "ch",
			upstreamUrl: "http://upstream/cc.ts",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			captionsEnabled: true,
			runner,
			tmpRoot
		});

		await session.start();

		// Two ffmpegs: the main video pipeline and the captions sidecar.
		assert.equal(spawned.length, 2, "main + captions sidecar both spawned");
		const sidecar = spawned.find((a) =>
			a.some((tok) => /\[out0\+subcc\]/.test(String(tok)))
		);
		assert.ok(sidecar, "one of the spawned processes is the captions sidecar");
		assert.ok(
			sidecar.some((t) => t === "webvtt"),
			"sidecar encodes subtitles as webvtt"
		);

		const master = session.buildMasterPlaylist();
		assert.match(master, /#EXT-X-MEDIA:TYPE=SUBTITLES/);
		assert.match(master, /GROUP-ID="subs"/);
		assert.match(master, /URI="captions\.m3u8\?profile=direct"/);
		assert.match(master, /SUBTITLES="subs"/);

		// A channel may not emit its first caption packet for several minutes.
		// Keep the advertised rendition loadable while the sidecar is waiting.
		const pendingCaptions = await session.readCaptionsPlaylist();
		assert.match(pendingCaptions, /^#EXTM3U/);
		assert.match(pendingCaptions, /#EXT-X-TARGETDURATION:6/);
		assert.doesNotMatch(pendingCaptions, /cap-\d+\.vtt/);

		session.attach();
		session.detach();
		await new Promise<void>((resolve) => session.onStopped(() => resolve()));
		// Sidecar should have been killed alongside the main process.
		assert.ok(spawned.length === 2, "no respawns after stop");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("caption failures stay isolated and redact the upstream URL", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "signalhaven-cc-error-"));
	try {
		const upstreamUrl =
			"http://viewer:secret@hdhomerun.local:5004/auto/v11.1?token=private";
		const bus = new EventBus();
		const events: Array<{ event: string; data: unknown }> = [];
		bus.subscribe("tuners", ({ event, data }) => events.push({ event, data }));

		const runner = {
			spawn: (args: string[]): ChildProcess => {
				const segmentIndex = args.indexOf("-hls_segment_filename");
				const segmentPattern = args[segmentIndex + 1] as string;
				const outDir = segmentPattern.substring(
					0,
					segmentPattern.lastIndexOf("/")
				);
				const child = makeFakeProcess(outDir);
				const inputArg = args[args.indexOf("-i") + 1];

				if (inputArg?.includes("[out0+subcc]")) {
					// Mirror FFmpeg diagnostics for both escaped and normalized URLs;
					// neither representation may cross the event-bus boundary.
					setImmediate(() => {
						child.stderr?.emit(
							"data",
							Buffer.from(
								`Error opening input file ${inputArg}.\n` +
									`Failed to open ${upstreamUrl}.\n`
							)
						);
						child.stderr?.emit("end");
						child.emit("exit", 234, null);
					});
				}
				return child;
			}
		};
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const providerId = randomUUID();
		const lease = await allocator.acquire({
			providerId,
			channelId: "x",
			purpose: "live",
			priority: 0
		});
		const session = new StreamSession({
			sessionId: "ch",
			upstreamUrl,
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			captionsEnabled: true,
			runner,
			tmpRoot,
			bus
		});

		await session.start();
		assert.equal(session.getState(), "ready");
		assert.ok(
			events.some(({ event }) => event === "session.captions_error"),
			"sidecar failure is reported without stopping video"
		);

		const captionLogs = events.filter(
			({ event }) => event === "session.captions_log"
		);
		assert.equal(captionLogs.length, 2);
		const diagnostics = JSON.stringify(captionLogs);
		assert.match(diagnostics, /<redacted upstream URL>/);
		assert.doesNotMatch(diagnostics, /viewer|secret|token|private/);

		session.attach();
		session.detach();
		await new Promise<void>((resolve) => session.onStopped(() => resolve()));
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});
