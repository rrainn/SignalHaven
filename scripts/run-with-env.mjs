import { constants } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);

/**
 * Loads workspace configuration while preserving explicit shell overrides.
 *
 * @param {string} environmentPath Path to the optional dotenv file.
 */
export function loadWorkspaceEnvironment(
	environmentPath = path.join(workspaceRoot, ".env")
) {
	if (existsSync(environmentPath)) {
		process.loadEnvFile(environmentPath);
	}
}

/**
 * Runs a package-script command with the workspace environment applied.
 *
 * Signal forwarding keeps Ctrl+C and process-manager shutdowns attached to the
 * real command instead of leaving child development servers behind.
 *
 * @param {string[]} commandArguments Executable followed by its arguments.
 * @returns {Promise<number>} The child process exit code.
 */
export async function runWithWorkspaceEnvironment(commandArguments) {
	const [command, ...args] = commandArguments;
	if (!command) {
		throw new Error("Expected a command to run after run-with-env.mjs");
	}

	loadWorkspaceEnvironment();
	const child = spawn(command, args, {
		cwd: workspaceRoot,
		env: process.env,
		stdio: "inherit"
	});

	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			if (!child.killed) child.kill(signal);
		});
	}

	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code !== null) {
				resolve(code);
				return;
			}

			// Preserve conventional signal exit codes for callers and CI.
			resolve(128 + (constants.signals[signal ?? "SIGTERM"] ?? 1));
		});
	});
}

const invokedPath = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: undefined;
if (invokedPath === import.meta.url) {
	try {
		process.exitCode = await runWithWorkspaceEnvironment(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
