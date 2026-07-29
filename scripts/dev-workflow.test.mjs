import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the root dev workflow gives the frontend and backend distinct ports", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8"));
	const devCommand = packageJson.scripts.dev;

	// Keep the browser-facing frontend on 3000 while its API rewrite targets 3001.
	assert.match(devCommand, /PORT=3001 pnpm --filter @signalhaven\/backend dev/);
	assert.match(
		devCommand,
		/SIGNALHAVEN_BACKEND_ORIGIN=http:\/\/localhost:3001 pnpm --filter @signalhaven\/frontend dev/
	);
});
