import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import {
	authStatusSchema,
	playbackTelemetryEventSchema,
	userPreferencesDefaults,
	userPreferencesSchema
} from "@signalhaven/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOST = "127.0.0.1";
const PRIMARY_CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000000";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";
const MOCK_BACKEND_PATH = path.resolve(
	process.cwd(),
	"scripts/lighthouse-mock-backend.mjs"
);

let backend: ChildProcessWithoutNullStreams;
let baseUrl: string;

/** Reserve a loopback port so the test stays isolated from local development. */
async function findAvailablePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, HOST, resolve);
	});
	const address = probe.address();
	if (!address || typeof address === "string") {
		throw new Error("Could not reserve a Lighthouse mock backend port");
	}
	await new Promise<void>((resolve, reject) => {
		probe.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
}

/** Wait for the real health endpoint so assertions cannot race process startup. */
async function waitUntilReady(
	child: ChildProcessWithoutNullStreams
): Promise<void> {
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});

	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (child.exitCode !== null) {
			throw new Error(`Lighthouse mock backend exited early:\n${output}`);
		}
		try {
			const response = await fetch(`${baseUrl}/api/v1/health`);
			if (response.ok) return;
		} catch {
			// Connection failures are expected while the child binds its port.
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(`Lighthouse mock backend did not become ready:\n${output}`);
}

describe("Lighthouse mock backend", () => {
	beforeAll(async () => {
		const port = await findAvailablePort();
		baseUrl = `http://${HOST}:${port}`;
		backend = spawn(process.execPath, [MOCK_BACKEND_PATH], {
			env: { ...process.env, PORT: String(port) }
		});
		await waitUntilReady(backend);
	});

	afterAll(async () => {
		if (!backend || backend.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			backend.once("exit", () => resolve());
		});
		backend.kill();
		await exited;
	});

	it("serves a schema-valid signed-in administrator", async () => {
		const response = await fetch(`${baseUrl}/api/v1/auth/status`);
		expect(response.status).toBe(200);

		const status = authStatusSchema.parse(await response.json());
		expect(status.requiresInitialAdmin).toBe(false);
		expect(status.systemSetupRequired).toBe(false);
		expect(status.user).toMatchObject({ role: "admin" });
	});

	it("serves schema-valid default account preferences", async () => {
		const response = await fetch(`${baseUrl}/api/v1/preferences`);
		expect(response.status).toBe(200);

		const preferences = userPreferencesSchema.parse(await response.json());
		expect(preferences).toEqual(userPreferencesDefaults);
	});

	it("serves a non-error live HLS manifest for the Watch page", async () => {
		const query = new URLSearchParams({
			profile: "auto",
			viewerId: VIEWER_ID
		});
		const response = await fetch(
			`${baseUrl}/api/v1/stream/${PRIMARY_CHANNEL_ID}/master.m3u8?${query}`
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(
			/^application\/vnd\.apple\.mpegurl\b/
		);
		const manifest = await response.text();
		expect(manifest).toMatch(/^#EXTM3U\r?\n/);
		expect(manifest).toContain("#EXT-X-TARGETDURATION:");
		expect(manifest).toContain("#EXT-X-MEDIA-SEQUENCE:");
		expect(manifest).not.toContain("#EXT-X-ENDLIST");
	});

	it("accepts the Watch page playback telemetry and viewer release POSTs", async () => {
		const telemetry = playbackTelemetryEventSchema.parse({
			event: "startup_completed",
			media: "live",
			client: "web",
			profile: "auto",
			cause: "unknown",
			durationSeconds: 0.25
		});
		const telemetryResponse = await fetch(
			`${baseUrl}/api/v1/playback/telemetry`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telemetry)
			}
		);
		expect(telemetryResponse.status).toBe(204);
		expect(await telemetryResponse.text()).toBe("");

		const releaseResponse = await fetch(
			`${baseUrl}/api/v1/stream/${PRIMARY_CHANNEL_ID}/viewers/${VIEWER_ID}/release?profile=auto`,
			{ method: "POST" }
		);
		expect(releaseResponse.status).toBe(204);
		expect(await releaseResponse.text()).toBe("");
	});
});
