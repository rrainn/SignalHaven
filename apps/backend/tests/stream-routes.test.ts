import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import express from "express";
import request from "supertest";

import { errorHandler } from "../src/http/middleware/errors";
import { createStreamRouter } from "../src/http/routes/stream";
import {
	StreamSession,
	UpstreamStreamError
} from "../src/streaming/stream-session";
import type { StreamingService } from "../src/streaming/streaming.service";
import { TunerAllocator } from "../src/tuners/tuner-allocator";

/** Mount the stream router with deterministic request ids for error envelopes. */
function buildApp(streaming: StreamingService): express.Express {
	const app = express();
	app.use((req, _res, next) => {
		req.id = randomUUID();
		next();
	});
	app.use(
		"/api/v1",
		createStreamRouter(streaming, (_req, _res, next) => next())
	);
	app.use(errorHandler());
	return app;
}

test("adaptive rendition playlist route does not require a segment", async () => {
	const session = {
		readRenditionPlaylist: async () =>
			"#EXTM3U\n#EXTINF:2.0,\nsegments/seg-00000.m4s\n"
	};
	const streaming = {
		getSession: () => session
	} as unknown as StreamingService;
	const channelId = randomUUID();

	const response = await request(buildApp(streaming)).get(
		`/api/v1/stream/${channelId}/variants/480p/playlist.m3u8?profile=auto`
	);

	assert.equal(response.status, 200);
	assert.match(response.text, /segments\/seg-00000\.m4s/);
});

test("stream startup failures return an upstream-specific HTTP error", async () => {
	const streaming = {
		attach: async () => {
			throw new UpstreamStreamError("input_unreachable");
		}
	} as unknown as StreamingService;

	const response = await request(buildApp(streaming)).get(
		`/api/v1/stream/${randomUUID()}/master.m3u8?profile=direct`
	);

	assert.equal(response.status, 502);
	assert.equal(response.body.error.code, "upstream_stream_unavailable");
	assert.equal(response.body.error.message, "Upstream stream unavailable");
});

test("FFmpeg input failures are classified as upstream failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "signalhaven-upstream-classify-"));
	try {
		const allocator = new TunerAllocator({ capacity: async () => 1 });
		const lease = await allocator.acquire({
			providerId: randomUUID(),
			channelId: "protected",
			purpose: "live",
			priority: 0
		});
		const session = new StreamSession({
			sessionId: randomUUID(),
			upstreamUrl: "https://stream.example/protected.ts",
			lease,
			releaseLease: () => allocator.release(lease.leaseId),
			lingerMs: 0,
			tmpRoot: root,
			profile: "direct",
			runner: {
				spawn: () => {
					const process = new EventEmitter() as EventEmitter & {
						stderr: EventEmitter;
						exitCode: number | null;
						signalCode: NodeJS.Signals | null;
						kill: () => boolean;
					};
					process.stderr = new EventEmitter();
					process.exitCode = null;
					process.signalCode = null;
					process.kill = () => true;
					setImmediate(() => {
						process.stderr.emit(
							"data",
							Buffer.from("Server returned 403 Forbidden\n")
						);
						process.stderr.emit("end");
						process.exitCode = 8;
						process.emit("exit", 8, null);
					});
					return process as unknown as ChildProcess;
				}
			}
		});

		await assert.rejects(
			session.start(),
			(error: unknown) =>
				error instanceof UpstreamStreamError &&
				error.category === "input_unreachable"
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
