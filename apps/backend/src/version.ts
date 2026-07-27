let cachedVersion: string | undefined;

/** Resolve the release version embedded in an image, with package metadata as fallback. */
export function getVersion(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SIGNALHAVEN_VERSION) {
		return env.SIGNALHAVEN_VERSION;
	}

	if (cachedVersion !== undefined) {
		return cachedVersion;
	}

	if (env.npm_package_version) {
		cachedVersion = env.npm_package_version;
		return cachedVersion;
	}

	try {
		// Resolved relative to apps/backend/src/, so package.json is one level up.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pkg = require("../package.json") as { version?: string };
		cachedVersion = pkg.version ?? "0.0.0";
	} catch {
		cachedVersion = "0.0.0";
	}

	return cachedVersion;
}

/** Resolve the source revision embedded by the release image build. */
export function getGitCommit(env: NodeJS.ProcessEnv = process.env): string {
	return env.SIGNALHAVEN_GIT_SHA ?? "unknown";
}
