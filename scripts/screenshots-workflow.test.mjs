import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
	"../.github/workflows/screenshots.yml",
	import.meta.url
);
const captureScriptUrl = new URL(
	"../apps/frontend/scripts/capture-readme-screenshots.mjs",
	import.meta.url
);

test("README screenshots can be refreshed nightly or tested manually", async () => {
	const workflow = await readFile(workflowUrl, "utf8");

	assert.match(workflow, /schedule:[\s\S]*?- cron:/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /commit_changes:/);
	assert.match(workflow, /contents: write/);
	assert.match(workflow, /capture-readme-screenshots\.mjs/);
	assert.match(workflow, /github\.event_name == 'schedule'/);
	assert.match(workflow, /git push origin HEAD:main/);
});

test("capture script owns every README screenshot variant", async () => {
	const script = await readFile(captureScriptUrl, "utf8");

	for (const screenshot of [
		"guide-desktop-light.png",
		"guide-desktop-dark.png",
		"guide-mobile-light.png",
		"guide-mobile-dark.png"
	]) {
		assert.match(script, new RegExp(screenshot.replace(".", "\\.")));
	}
	assert.match(script, /signalhaven:theme/);
	assert.match(script, /waitForLoadState\("networkidle"\)/);
});
