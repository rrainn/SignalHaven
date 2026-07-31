import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isUuid } from "./uuid";

const IDENTITY_FILENAME = "server-id";

/** Reads a persisted identifier and rejects corruption instead of changing identity. */
async function readServerId(path: string): Promise<string> {
	const serverId = (await readFile(path, "utf8")).trim();
	if (!isUuid(serverId)) {
		throw new Error(`Persisted Bonjour server ID is invalid: ${path}`);
	}

	return serverId;
}

/** Loads or atomically creates the stable identity published in TXT records. */
export async function loadOrCreateServerId(
	stateDirectory: string
): Promise<string> {
	await mkdir(stateDirectory, { recursive: true });
	const path = join(stateDirectory, IDENTITY_FILENAME);

	try {
		return await readServerId(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	const serverId = randomUUID();
	try {
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile(`${serverId}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		return serverId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return readServerId(path);
		}
		throw error;
	}
}
