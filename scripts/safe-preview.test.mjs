import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	BUILD_HEAP_MB,
	SERVER_HEAP_MB,
	buildCommand,
	buildEnvironment,
	inspectProcess,
	stopRecordedPreview
} from "./safe-preview.mjs";

/** Waits until a condition succeeds or the test timeout elapses. */
async function waitFor(condition, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for the preview test process");
}

/** Returns whether a PID still identifies a live process. */
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("the build command forces webpack and the documented heap cap", () => {
	const command = buildCommand("/tmp/next-cli.js");

	assert.deepEqual(command, [
		`--max-old-space-size=${BUILD_HEAP_MB}`,
		"/tmp/next-cli.js",
		"build",
		"--webpack"
	]);
	assert.equal(BUILD_HEAP_MB, 768);
	assert.equal(SERVER_HEAP_MB, 512);
	assert.equal(buildEnvironment({}).SIGNALHAVEN_SAFE_PREVIEW, "1");
});

test("a stale state file never terminates an unrelated process", async (t) => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "signalhaven-preview-")
	);
	const stateFile = path.join(directory, "preview.json");
	const child = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1_000)"],
		{
			detached: true,
			stdio: "ignore"
		}
	);
	child.unref();
	t.after(async () => {
		if (isAlive(child.pid)) {
			process.kill(-child.pid, "SIGKILL");
		}
		await rm(directory, { recursive: true, force: true });
	});

	const identity = await inspectProcess(child.pid);
	assert(identity);
	await writeFile(
		stateFile,
		`${JSON.stringify({
			version: 1,
			...identity,
			command: `${identity.command} --stale`,
			startedAt: "stale"
		})}\n`
	);

	const result = await stopRecordedPreview(stateFile);

	assert.equal(result, "stale");
	assert.equal(isAlive(child.pid), true);
	await assert.rejects(readFile(stateFile));
});

test("the stop workflow terminates only the recorded process group", async (t) => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "signalhaven-preview-")
	);
	const stateFile = path.join(directory, "preview.json");
	const child = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1_000)"],
		{
			detached: true,
			stdio: "ignore"
		}
	);
	child.unref();
	t.after(async () => {
		if (isAlive(child.pid)) {
			process.kill(-child.pid, "SIGKILL");
		}
		await rm(directory, { recursive: true, force: true });
	});

	const identity = await inspectProcess(child.pid);
	assert(identity);
	await writeFile(
		stateFile,
		`${JSON.stringify({ version: 1, ...identity, startedAt: identity.startTime })}\n`
	);

	const result = await stopRecordedPreview(stateFile);
	await waitFor(() => !isAlive(child.pid));

	assert.equal(result, "stopped");
	await assert.rejects(readFile(stateFile));
});
