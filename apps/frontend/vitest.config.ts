import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Tests need the automatic JSX runtime but not the development refresh plugin.
	esbuild: {
		jsx: "automatic"
	},
	resolve: {
		alias: {
			// Mirror the tsconfig path resolution so test files can import via
			// workspace package names.
			"@signalhaven/shared": path.resolve(
				__dirname,
				"../../packages/shared/src/index.ts"
			)
		}
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./tests/setup.ts"],
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		css: false
	}
});
