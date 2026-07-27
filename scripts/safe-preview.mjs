import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const BUILD_HEAP_MB = 768;
export const SERVER_HEAP_MB = 512;

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const frontendRoot = path.join(repositoryRoot, "apps", "frontend");
const runtimeDirectory = path.join(repositoryRoot, ".signalhaven-preview");
const stateFile = path.join(runtimeDirectory, "preview.json");
const logFile = path.join(runtimeDirectory, "preview.log");
const cleanupHook = path.join(
	repositoryRoot,
	"scripts",
	"safe-preview-cleanup.mjs"
);

/** Builds the Node arguments for a resource-bounded webpack production build. */
export function buildCommand(nextCli, heapMb = BUILD_HEAP_MB) {
	return [`--max-old-space-size=${heapMb}`, nextCli, "build", "--webpack"];
}

/** Marks the Next.js config as a one-worker safe-preview build. */
export function buildEnvironment(environment = process.env) {
	return {
		...environment,
		NODE_ENV: "production",
		SIGNALHAVEN_SAFE_PREVIEW: "1"
	};
}

/** Reads one stable process attribute from the platform process table. */
async function readProcessAttribute(pid, attribute) {
	try {
		const { stdout } = await execFileAsync("ps", [
			"-ww",
			"-p",
			String(pid),
			"-o",
			`${attribute}=`
		]);
		return stdout.trim();
	} catch {
		return null;
	}
}

/** Captures the identity needed to distinguish a preview from a reused PID. */
export async function inspectProcess(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1) {
		return null;
	}

	const [processGroupValue, startTime, command] = await Promise.all([
		readProcessAttribute(pid, "pgid"),
		readProcessAttribute(pid, "lstart"),
		readProcessAttribute(pid, "command")
	]);
	const processGroup = Number.parseInt(processGroupValue ?? "", 10);
	if (!Number.isSafeInteger(processGroup) || !startTime || !command) {
		return null;
	}

	return { pid, processGroup, startTime, command };
}

/** Returns true only when every recorded process fingerprint still matches. */
function identitiesMatch(recorded, current) {
	return Boolean(
		current &&
		recorded.pid === current.pid &&
		recorded.processGroup === current.processGroup &&
		recorded.startTime === current.startTime &&
		recorded.command === current.command
	);
}

/** Reads the state file without treating missing or malformed state as active. */
async function readState(targetStateFile) {
	try {
		const state = JSON.parse(await readFile(targetStateFile, "utf8"));
		if (
			state.version !== 1 ||
			!Number.isSafeInteger(state.pid) ||
			!Number.isSafeInteger(state.processGroup) ||
			typeof state.startTime !== "string" ||
			typeof state.command !== "string"
		) {
			return null;
		}
		return state;
	} catch {
		return null;
	}
}

/** Removes a runtime state file while tolerating concurrent cleanup. */
async function removeState(targetStateFile) {
	await rm(targetStateFile, { force: true });
}

/** Checks whether a process group still contains any live processes. */
function processGroupIsAlive(processGroup) {
	try {
		process.kill(-processGroup, 0);
		return true;
	} catch {
		return false;
	}
}

/** Waits for a process group to exit before the caller considers escalation. */
async function waitForProcessGroupExit(processGroup, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processGroupIsAlive(processGroup)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !processGroupIsAlive(processGroup);
}

/** Terminates a process group created moments earlier by this command. */
async function terminateFreshProcessGroup(processGroup) {
	try {
		process.kill(-processGroup, "SIGTERM");
	} catch (error) {
		if (error.code === "ESRCH") {
			return;
		}
		throw error;
	}
	if (!(await waitForProcessGroupExit(processGroup, 5_000))) {
		try {
			process.kill(-processGroup, "SIGKILL");
		} catch (error) {
			if (error.code !== "ESRCH") {
				throw error;
			}
		}
		await waitForProcessGroupExit(processGroup, 1_000);
	}
}

/** Stops a preview only after its PID, group, start time, and command match. */
export async function stopRecordedPreview(targetStateFile = stateFile) {
	const recorded = await readState(targetStateFile);
	if (!recorded) {
		await removeState(targetStateFile);
		return "absent";
	}

	const current = await inspectProcess(recorded.pid);
	if (
		!identitiesMatch(recorded, current) ||
		recorded.processGroup !== recorded.pid
	) {
		await removeState(targetStateFile);
		return "stale";
	}

	// Identity validation above makes escalation safe for this isolated group.
	await terminateFreshProcessGroup(recorded.processGroup);
	await removeState(targetStateFile);
	return "stopped";
}

/** Resolves the workspace-installed Next.js CLI without another package-manager process. */
function resolveNextCli() {
	try {
		const requireFromFrontend = createRequire(
			path.join(frontendRoot, "package.json")
		);
		return requireFromFrontend.resolve("next/dist/bin/next");
	} catch {
		throw new Error(
			"Next.js is not installed. Run `pnpm install --frozen-lockfile` at the repository root first."
		);
	}
}

/** Parses a bounded positive integer configuration value. */
function configuredInteger(name, fallback, minimum, maximum) {
	const value = process.env[name];
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${name} must be an integer from ${minimum} to ${maximum}.`
		);
	}
	return parsed;
}

/** Fails early on platforms that cannot create and signal process groups. */
function assertSupportedPlatform() {
	if (process.platform === "win32") {
		throw new Error(
			"The safe preview workflow currently requires macOS or Linux."
		);
	}
}

/** Atomically records state so a partial write can never look authoritative. */
async function writeState(state) {
	const temporaryFile = `${stateFile}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
			mode: 0o600
		});
		await rename(temporaryFile, stateFile);
	} finally {
		await rm(temporaryFile, { force: true });
	}
}

/** Removes stale state and rejects attempts to replace an active preview. */
async function ensureNoActivePreview() {
	const recorded = await readState(stateFile);
	if (!recorded) {
		await removeState(stateFile);
		return;
	}
	if (identitiesMatch(recorded, await inspectProcess(recorded.pid))) {
		throw new Error(
			`A safe preview is already running at ${recorded.url ?? `PID ${recorded.pid}`}.`
		);
	}
	await removeState(stateFile);
}

/** Verifies that the configured listener can bind before a process is created. */
async function assertPortAvailable(hostname, port) {
	await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", (error) => {
			reject(
				new Error(
					`Preview port ${hostname}:${port} is unavailable: ${error.message}`
				)
			);
		});
		server.listen(port, hostname, () => server.close(resolve));
	});
}

/** Runs the optimized webpack build with a fixed Node heap limit. */
async function buildPreview() {
	assertSupportedPlatform();
	await ensureNoActivePreview();
	const nextCli = resolveNextCli();
	const heapMb = configuredInteger(
		"SIGNALHAVEN_PREVIEW_BUILD_HEAP_MB",
		BUILD_HEAP_MB,
		256,
		8192
	);
	console.log(
		`Building the frontend with webpack, one worker, and a ${heapMb} MB heap cap...`
	);

	const child = spawn(process.execPath, buildCommand(nextCli, heapMb), {
		cwd: frontendRoot,
		env: buildEnvironment(),
		stdio: "inherit"
	});
	const exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`Preview build stopped by ${signal}.`));
				return;
			}
			resolve(code ?? 1);
		});
	});
	if (exitCode !== 0) {
		throw new Error(`Preview build failed with exit code ${exitCode}.`);
	}
}

/** Waits for the representative route to return HTTP 200. */
async function waitForHealth(url, pid, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await inspectProcess(pid))) {
			throw new Error(`Preview server exited before ${url} became healthy.`);
		}
		const healthy = await new Promise((resolve) => {
			const request = http.get(url, (response) => {
				response.resume();
				resolve(response.statusCode === 200);
			});
			request.setTimeout(1_000, () => request.destroy());
			request.once("error", () => resolve(false));
		});
		if (healthy) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(
		`Preview health check timed out after ${timeoutMs / 1_000} seconds.`
	);
}

/** Totals the process count and RSS for the isolated preview process group. */
async function readProcessGroupStats(processGroup) {
	const { stdout } = await execFileAsync("ps", [
		"-ax",
		"-o",
		"pid=",
		"-o",
		"pgid=",
		"-o",
		"rss="
	]);
	const members = stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([, group]) => group === processGroup);
	return {
		processCount: members.length,
		rssKb: members.reduce((total, [, , rss]) => total + (rss || 0), 0)
	};
}

/** Starts one detached production server and cleans it up if readiness fails. */
async function startPreview() {
	assertSupportedPlatform();
	await ensureNoActivePreview();
	const port = configuredInteger("SIGNALHAVEN_PREVIEW_PORT", 3100, 1, 65_535);
	const hostname = process.env.SIGNALHAVEN_PREVIEW_HOST ?? "127.0.0.1";
	const heapMb = configuredInteger(
		"SIGNALHAVEN_PREVIEW_SERVER_HEAP_MB",
		SERVER_HEAP_MB,
		128,
		8192
	);
	const healthPath = "/recordings";
	const url = `http://${hostname}:${port}${healthPath}`;
	const nextCli = resolveNextCli();

	try {
		await readFile(path.join(frontendRoot, ".next", "BUILD_ID"), "utf8");
	} catch {
		throw new Error(
			"No production build exists. Run `pnpm run preview:build` first."
		);
	}
	await assertPortAvailable(hostname, port);
	await mkdir(runtimeDirectory, { recursive: true });
	const logHandle = await open(logFile, "a");
	let child;
	let spawnError = null;
	try {
		child = spawn(
			process.execPath,
			[
				`--max-old-space-size=${heapMb}`,
				"--import",
				cleanupHook,
				nextCli,
				"start",
				"--hostname",
				hostname,
				"--port",
				String(port)
			],
			{
				cwd: frontendRoot,
				detached: true,
				env: {
					...process.env,
					NODE_ENV: "production",
					SIGNALHAVEN_PREVIEW_STATE_FILE: stateFile
				},
				stdio: ["ignore", logHandle.fd, logHandle.fd]
			}
		);
		child.once("error", (error) => {
			spawnError = error;
		});
		child.unref();
	} finally {
		await logHandle.close();
	}

	let interrupted = false;
	const handleSignal = (exitCode) => {
		if (interrupted) {
			return;
		}
		interrupted = true;
		// A detached child does not receive the invoking shell's signal, so the
		// manager explicitly cleans it up while startup is still in progress.
		void terminateFreshProcessGroup(child.pid)
			.then(() => removeState(stateFile))
			.finally(() => process.exit(exitCode));
	};
	const handleInterrupt = () => handleSignal(130);
	const handleTermination = () => handleSignal(143);
	process.once("SIGINT", handleInterrupt);
	process.once("SIGTERM", handleTermination);

	try {
		let identity = null;
		for (let attempt = 0; attempt < 20 && !identity; attempt += 1) {
			identity = await inspectProcess(child.pid);
			if (!identity) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		if (!identity || identity.processGroup !== child.pid) {
			throw new Error(
				spawnError
					? `Could not start the preview server: ${spawnError.message}`
					: "Could not verify the isolated preview process group."
			);
		}

		await writeState({
			version: 1,
			...identity,
			startedAt: new Date().toISOString(),
			hostname,
			port,
			url
		});
		await waitForHealth(url, child.pid);

		// Next.js replaces its process title once startup finishes. Refresh the
		// command fingerprint only after health succeeds so later stops match it.
		const readyIdentity = await inspectProcess(child.pid);
		if (
			!readyIdentity ||
			readyIdentity.processGroup !== child.pid ||
			readyIdentity.startTime !== identity.startTime
		) {
			throw new Error("Could not verify the ready preview process identity.");
		}
		await writeState({
			version: 1,
			...readyIdentity,
			startedAt: new Date().toISOString(),
			hostname,
			port,
			url
		});

		const stats = await readProcessGroupStats(readyIdentity.processGroup);
		console.log("Safe preview is ready.");
		console.log(`URL: ${url}`);
		console.log(`PID: ${child.pid}`);
		console.log(`Processes: ${stats.processCount}`);
		console.log(`Current RSS: ${(stats.rssKb / 1024).toFixed(1)} MB`);
		console.log(`Server heap cap: ${heapMb} MB`);
		console.log(`Log: ${logFile}`);
	} catch (error) {
		await terminateFreshProcessGroup(child.pid);
		await removeState(stateFile);
		throw new Error(`${error.message} See ${logFile} for server output.`);
	} finally {
		process.removeListener("SIGINT", handleInterrupt);
		process.removeListener("SIGTERM", handleTermination);
	}
}

/** Dispatches the repository preview commands. */
async function main() {
	const command = process.argv[2] ?? "safe";
	if (command === "build") {
		await buildPreview();
		return;
	}
	if (command === "start") {
		await startPreview();
		return;
	}
	if (command === "stop") {
		const result = await stopRecordedPreview();
		if (result === "stopped") {
			console.log("Safe preview stopped.");
		} else if (result === "stale") {
			console.log("Removed stale preview state; no process was signaled.");
		} else {
			console.log("No safe preview is running.");
		}
		return;
	}
	if (command === "safe") {
		await buildPreview();
		await startPreview();
		return;
	}
	throw new Error(`Unknown preview command: ${command}`);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(`Safe preview failed: ${error.message}`);
		process.exitCode = 1;
	});
}
