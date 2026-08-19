import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the frontend E2E smoke tests.
 *
 * We only run a single browser (Chromium) and a single worker so the suite
 * stays cheap on CI; broader matrices can be added later if/when more
 * coverage is needed. The config boots Next.js in production mode against
 * the bundled `next start` server so we exercise the same code path that
 * ships to users.
 */
export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	reporter: process.env["CI"]
		? [["list"], ["html", { open: "never" }]]
		: "list",
	use: {
		baseURL: "http://127.0.0.1:43100",
		trace: "retain-on-failure"
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				// Allow video.play() without a prior user gesture so HLS.js can
				// start playback in tests and the Player's 'play' event fires.
				launchOptions: {
					args: ["--autoplay-policy=no-user-gesture-required"]
				}
			}
		}
	],
	webServer: {
		// Per-test page routes provide stateful account fixtures, so this test
		// server intentionally leaves bootstrap to the intercepted browser API.
		command: "SIGNALHAVEN_E2E_CLIENT_API_MOCKS=1 PORT=43100 pnpm run start",
		url: "http://127.0.0.1:43100",
		reuseExistingServer: !process.env["CI"],
		timeout: 120_000,
		stdout: "pipe",
		stderr: "pipe"
	}
});
