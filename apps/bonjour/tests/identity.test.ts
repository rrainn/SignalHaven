import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreateServerId } from "../src/identity";
import { isUuid } from "../src/uuid";

/** Creates an isolated state directory that is always removed after the test. */
async function createStateDirectory(t: test.TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "signalhaven-bonjour-test-"));
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

test("persists one stable server identity across restarts", async (t) => {
	const directory = await createStateDirectory(t);

	const first = await loadOrCreateServerId(directory);
	const second = await loadOrCreateServerId(directory);

	assert.equal(second, first);
	assert.equal(isUuid(first), true);
	assert.equal(
		(await readFile(join(directory, "server-id"), "utf8")).trim(),
		first
	);
});

test("surfaces corrupted identity instead of silently replacing it", async (t) => {
	const directory = await createStateDirectory(t);
	await writeFile(join(directory, "server-id"), "not-a-uuid\n", "utf8");

	await assert.rejects(
		loadOrCreateServerId(directory),
		/Persisted Bonjour server ID is invalid/
	);
});
