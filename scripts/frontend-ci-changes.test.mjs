import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { affectsFrontendCi } from "./frontend-ci-changes.mjs";

test("frontend production and test changes require frontend CI", () => {
	assert.equal(affectsFrontendCi(["apps/frontend/app/page.tsx"]), true);
	assert.equal(affectsFrontendCi(["apps/frontend/e2e/guide.spec.ts"]), true);
});

test("shared contracts and build configuration require frontend CI", () => {
	for (const path of [
		"packages/shared/src/index.ts",
		"package.json",
		"pnpm-lock.yaml",
		"tsconfig.base.json",
		".lighthouserc.json",
		".github/workflows/ci.yml",
		"scripts/frontend-ci-changes.mjs"
	]) {
		assert.equal(affectsFrontendCi([path]), true, path);
	}
});

test("backend-only and documentation-only changes skip frontend CI", () => {
	assert.equal(
		affectsFrontendCi([
			"apps/backend/src/app.ts",
			"apps/backend/tests/app.test.ts"
		]),
		false
	);
	assert.equal(
		affectsFrontendCi(["README.md", "docs/configuration.md"]),
		false
	);
});

test("any frontend-relevant path enables frontend CI", () => {
	assert.equal(
		affectsFrontendCi([
			"docs/configuration.md",
			"apps/frontend/next.config.ts"
		]),
		true
	);
});

test("command-line mode reads changed paths from standard input", () => {
	const result = spawnSync(
		process.execPath,
		["scripts/frontend-ci-changes.mjs"],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			input: "apps/backend/src/app.ts\napps/frontend/app/page.tsx\n"
		}
	);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "true\n");
});
