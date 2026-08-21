import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Tuner } from "@signalhaven/shared";

import { RecordingSession } from "../src/recordings/recording-session";
import { StreamSession } from "../src/streaming/stream-session";
import { TunerAllocator } from "../src/tuners/tuner-allocator";
import { IptvProvider } from "../src/tuners/providers/iptv";

const ffmpegAvailable =
	spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

test(
	"IPTV headers cross the provider, live playback, and recording boundaries",
	{ skip: !ffmpegAvailable && "ffmpeg not installed" },
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "signalhaven-header-upstream-"));
		const fixturePath = join(root, "fixture.ts");
		const recordingPath = join(root, "recording.mkv");
		const generated = spawnSync(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=160x120:rate=10",
				"-t",
				"1",
				"-c:v",
				"mpeg2video",
				"-f",
				"mpegts",
				fixturePath
			],
			{ stdio: "ignore" }
		);
		assert.equal(generated.status, 0, "the FFmpeg fixture should be generated");
		const media = await readFile(fixturePath);

		const expectedUserAgent = "SignalHaven Header Integration";
		const expectedReferer = "https://guide.example/protected";
		let unauthorizedRequests = 0;
		let authorizedRequests = 0;
		let baseUrl = "";
		const server = createServer((req, res) => {
			if (req.url === "/lineup.m3u") {
				res.writeHead(200, { "Content-Type": "audio/x-mpegurl" });
				res.end(
					`#EXTM3U\n#EXTINF:-1 user-agent="${expectedUserAgent}" referrer="${expectedReferer}",Protected\n${baseUrl}/live.ts\n`
				);
				return;
			}
			if (req.url !== "/live.ts") {
				res.writeHead(404).end();
				return;
			}
			if (
				req.headers["user-agent"] !== expectedUserAgent ||
				req.headers.referer !== expectedReferer
			) {
				unauthorizedRequests += 1;
				res.writeHead(403).end("required headers missing");
				return;
			}
			authorizedRequests += 1;
			res.writeHead(200, { "Content-Type": "video/mp2t" });
			// Repeat a valid transport stream so both FFmpeg consumers remain live.
			const timer = setInterval(() => res.write(media), 50);
			res.once("close", () => clearInterval(timer));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		baseUrl = `http://127.0.0.1:${address.port}`;

		t.after(async () => {
			server.close();
			await once(server, "close");
			await rm(root, { recursive: true, force: true });
		});

		const denied = await fetch(`${baseUrl}/live.ts`);
		assert.equal(denied.status, 403, "the mock upstream enforces its headers");
		unauthorizedRequests = 0;

		const row: Tuner = {
			id: randomUUID(),
			kind: "iptv",
			name: "Protected IPTV",
			config: { url: `${baseUrl}/lineup.m3u` },
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString()
		};
		const provider = new IptvProvider(row);
		const [channel] = await provider.getLineup();
		assert.ok(channel);
		const stream = await provider.getStreamUrl(channel.channelId);

		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const lease = await allocator.acquire({
			providerId: row.id,
			channelId: channel.channelId,
			purpose: "live",
			priority: 0
		});
		const live = new StreamSession({
			sessionId: randomUUID(),
			upstreamUrl: stream.url,
			...(stream.httpHeaders ? { httpHeaders: stream.httpHeaders } : {}),
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			tmpRoot: root,
			profile: "direct"
		});
		await live.start();
		assert.match(await live.readPlaylist(), /^#EXTM3U/m);
		const stopped = new Promise<void>((resolve) =>
			live.onStopped(() => resolve())
		);
		live.stop();
		await stopped;

		const recording = new RecordingSession({
			upstreamUrl: stream.url,
			...(stream.httpHeaders ? { httpHeaders: stream.httpHeaders } : {}),
			outputPath: recordingPath,
			durationSeconds: 1
		});
		assert.deepEqual(await recording.done(), { kind: "completed" });
		assert.equal(unauthorizedRequests, 0);
		assert.ok(
			authorizedRequests >= 2,
			"live and recording reached the upstream"
		);
	}
);
