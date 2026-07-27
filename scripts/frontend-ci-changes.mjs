import { fileURLToPath } from "node:url";

const frontendCiPrefixes = ["apps/frontend/", "packages/shared/"];
const frontendCiFiles = new Set([
	".github/workflows/ci.yml",
	".lighthouserc.json",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"scripts/frontend-ci-changes.mjs",
	"scripts/frontend-ci-changes.test.mjs",
	"tsconfig.base.json",
	"tsconfig.json"
]);

/**
 * Determines whether changed files can affect frontend browser checks.
 *
 * Keeping this policy in a tested script prevents backend-only and documentation
 * changes from paying for production frontend builds, Playwright, and Lighthouse.
 *
 * @param {Iterable<string>} paths Repository-relative changed file paths.
 * @returns {boolean} Whether frontend E2E and Lighthouse jobs must run.
 */
export function affectsFrontendCi(paths) {
	for (const path of paths) {
		const normalizedPath = path.trim();
		if (!normalizedPath) continue;

		if (
			frontendCiFiles.has(normalizedPath) ||
			frontendCiPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
		) {
			return true;
		}
	}

	return false;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
	// Git supplies one repository-relative changed path per line on standard input.
	process.stdin.setEncoding("utf8");
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	process.stdout.write(`${affectsFrontendCi(input.split(/\r?\n/u))}\n`);
}
