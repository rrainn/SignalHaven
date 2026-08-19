import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import {
	authStatusSchema,
	userPreferencesDefaults,
	userPreferencesSchema
} from "@signalhaven/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOST = "127.0.0.1";
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

describe("Lighthouse mock backend account bootstrap", () => {
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
});
