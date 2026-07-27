import fs from "node:fs";

const stateFile = process.env.SIGNALHAVEN_PREVIEW_STATE_FILE;

/** Removes only the state file that still belongs to this server process. */
function removeOwnedState() {
	if (!stateFile) {
		return;
	}
	try {
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		if (state.version === 1 && state.pid === process.pid) {
			fs.rmSync(stateFile, { force: true });
		}
	} catch {
		// Missing or malformed state cannot safely be claimed by this process.
	}
}

process.once("exit", removeOwnedState);
