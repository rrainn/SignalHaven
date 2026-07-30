import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWorkspaceEnvironment } from "./run-with-env.mjs";

test("the root dev workflow gives the frontend and backend distinct ports", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8"));
	const devCommand = packageJson.scripts.dev;

	// Keep the browser-facing frontend on 3000 while its API rewrite targets 3001.
	assert.match(devCommand, /concurrently --kill-others/);
	assert.match(devCommand, /PORT=3001 pnpm --filter @signalhaven\/backend dev/);
	assert.match(
		devCommand,
		/SIGNALHAVEN_BACKEND_ORIGIN=http:\/\/localhost:3001 pnpm --filter @signalhaven\/frontend dev/
	);
});

test("environment-sensitive root scripts load the workspace .env file", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8"));

	// These commands start application code that reads runtime configuration.
	for (const scriptName of ["dev", "build", "db:migrate"]) {
		assert.match(
			packageJson.scripts[scriptName],
			/node scripts\/run-with-env\.mjs/,
			`${scriptName} should load the root .env file`
		);
	}
});

test("the script launcher loads .env without replacing shell overrides", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "signalhaven-env-"));
	const environmentPath = path.join(directory, ".env");
	const loadedName = "SIGNALHAVEN_TEST_ENV_LOADED";
	const overriddenName = "SIGNALHAVEN_TEST_ENV_OVERRIDE";
	const originalLoaded = process.env[loadedName];
	const originalOverride = process.env[overriddenName];

	await writeFile(
		environmentPath,
		`${loadedName}=from-file\n${overriddenName}=from-file\n`
	);
	delete process.env[loadedName];
	process.env[overriddenName] = "from-shell";

	try {
		loadWorkspaceEnvironment(environmentPath);
		assert.equal(process.env[loadedName], "from-file");
		assert.equal(process.env[overriddenName], "from-shell");
	} finally {
		if (originalLoaded === undefined) delete process.env[loadedName];
		else process.env[loadedName] = originalLoaded;
		if (originalOverride === undefined) delete process.env[overriddenName];
		else process.env[overriddenName] = originalOverride;
		await rm(directory, { recursive: true, force: true });
	}
});

test("the example and Compose stack use backend-compatible Postgres names", async () => {
	const [exampleEnvironment, compose] = await Promise.all([
		readFile(".env.example", "utf8"),
		readFile("docker-compose.yml", "utf8")
	]);

	// The same .env file should configure local scripts and the bundled container.
	for (const variable of ["PGDATABASE", "PGUSER", "PGPASSWORD"]) {
		assert.match(exampleEnvironment, new RegExp(`^${variable}=`, "m"));
	}
	assert.doesNotMatch(exampleEnvironment, /^POSTGRES_(DB|USER|PASSWORD)=/m);
	assert.match(compose, /POSTGRES_DB: \$\{PGDATABASE\}/);
	assert.match(compose, /POSTGRES_USER: \$\{PGUSER\}/);
	assert.match(compose, /POSTGRES_PASSWORD: \$\{PGPASSWORD\}/);
});
