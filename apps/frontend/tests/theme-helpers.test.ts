import { describe, expect, it } from "vitest";

import {
	THEME_MODES,
	isThemeMode,
	themeBootstrapScript
} from "../app/_theme/theme";

describe("theme helpers", () => {
	it("declares exactly the three supported modes", () => {
		expect([...THEME_MODES]).toEqual(["light", "system", "dark"]);
	});

	it("isThemeMode validates strings", () => {
		expect(isThemeMode("light")).toBe(true);
		expect(isThemeMode("dark")).toBe(true);
		expect(isThemeMode("system")).toBe(true);
		expect(isThemeMode("blue")).toBe(false);
		expect(isThemeMode(null)).toBe(false);
		expect(isThemeMode(undefined)).toBe(false);
	});

	describe("themeBootstrapScript", () => {
		it("applies dark when localStorage prefers dark", () => {
			const root = { classList: new Set<string>(), style: { colorScheme: "" } };
			const fakeWindow = {
				matchMedia: () => ({ matches: false }),
				localStorage: { getItem: () => "dark" }
			};
			runScript(themeBootstrapScript, fakeWindow, root);
			expect(root.classList.has("dark")).toBe(true);
			expect(root.style.colorScheme).toBe("dark");
		});

		it("falls back to system preference when nothing is stored", () => {
			const root = { classList: new Set<string>(), style: { colorScheme: "" } };
			const fakeWindow = {
				matchMedia: () => ({ matches: true }),
				localStorage: { getItem: () => null }
			};
			runScript(themeBootstrapScript, fakeWindow, root);
			expect(root.classList.has("dark")).toBe(true);
		});

		it("removes dark class when light is selected", () => {
			const root = {
				classList: new Set<string>(["dark"]),
				style: { colorScheme: "" }
			};
			const fakeWindow = {
				matchMedia: () => ({ matches: true }),
				localStorage: { getItem: () => "light" }
			};
			runScript(themeBootstrapScript, fakeWindow, root);
			expect(root.classList.has("dark")).toBe(false);
			expect(root.style.colorScheme).toBe("light");
		});
	});
});

/**
 * Execute the bootstrap script body inside an isolated function scope so we
 * can mock its `window`/`document` globals without polluting the test
 * environment.
 */
function runScript(
	script: string,
	fakeWindow: {
		matchMedia: (q: string) => { matches: boolean };
		localStorage: { getItem: (k: string) => string | null };
	},
	root: { classList: Set<string>; style: { colorScheme: string } }
) {
	const fakeClassList = {
		add: (c: string) => root.classList.add(c),
		remove: (c: string) => root.classList.delete(c)
	};
	const fakeDocument = {
		documentElement: { classList: fakeClassList, style: root.style }
	};
	// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
	const fn = new Function("window", "document", "localStorage", script);
	fn(fakeWindow, fakeDocument, fakeWindow.localStorage);
}
