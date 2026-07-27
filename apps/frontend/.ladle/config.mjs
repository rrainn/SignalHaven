/**
 * Ladle config.
 *
 * Stories live alongside their components under `app/_ui/*.stories.tsx`.
 * Ladle is a dev-only tool — these stories are never bundled into the
 * production Next.js build.
 *
 * @type {import('@ladle/react').UserConfig}
 */
const config = {
	stories: "app/_ui/*.stories.{ts,tsx}",
	defaultStory: "components--button-primary",
	addons: {
		theme: {
			enabled: true,
			defaultState: "light"
		},
		rtl: { enabled: true, defaultState: false },
		a11y: { enabled: true }
	}
};

export default config;
