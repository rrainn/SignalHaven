#!/usr/bin/env node
/**
 * Capture the deterministic guide screenshots embedded in the root README.
 *
 * The caller owns starting the production frontend and its fixture backend.
 * Keeping process orchestration in CI makes startup failures visible in logs
 * while this script stays focused on consistent browser state and rendering.
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const BASE_URL =
	process.env.SIGNALHAVEN_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:43100";
const SCREENSHOT_DIRECTORY = fileURLToPath(
	new URL("../../../docs/screenshots/", import.meta.url)
);
// A fixed Sunday morning keeps dates, program slots, and the now marker stable.
const FIXED_TIME = new Date("2026-05-10T08:00:00.000Z");

const variants = [
	{
		filename: "guide-desktop-light.png",
		theme: "light",
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1
	},
	{
		filename: "guide-desktop-dark.png",
		theme: "dark",
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1
	},
	{
		filename: "guide-mobile-light.png",
		theme: "light",
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2
	},
	{
		filename: "guide-mobile-dark.png",
		theme: "dark",
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2
	}
];

/** Capture one viewport and theme combination after the guide becomes idle. */
async function captureVariant(browser, variant) {
	const context = await browser.newContext({
		viewport: variant.viewport,
		deviceScaleFactor: variant.deviceScaleFactor,
		colorScheme: variant.theme,
		reducedMotion: "reduce",
		timezoneId: "America/Denver"
	});
	const page = await context.newPage();

	try {
		// Freeze browser time before application code schedules any timers.
		await page.clock.setFixedTime(FIXED_TIME);
		await page.addInitScript((theme) => {
			// Persist the explicit palette before the pre-hydration theme bootstrap runs.
			window.localStorage.setItem("signalhaven:theme", theme);
		}, variant.theme);

		await page.goto(new URL("/guide", BASE_URL).toString(), {
			waitUntil: "domcontentloaded"
		});
		await page.waitForLoadState("networkidle");
		await page.getByTestId("guide-grid").waitFor({ state: "visible" });
		await page
			.getByRole("status", { name: "Updating guide" })
			.waitFor({ state: "detached" });

		const resolvedTheme = await page
			.locator("html")
			.evaluate((element) =>
				element.classList.contains("dark") ? "dark" : "light"
			);
		if (resolvedTheme !== variant.theme) {
			throw new Error(
				`Expected ${variant.theme} theme, but the page resolved ${resolvedTheme}`
			);
		}

		// Disable incidental motion and caret blinking at the exact capture frame.
		await page.addStyleTag({
			content:
				"*, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }"
		});
		await page.screenshot({
			path: `${SCREENSHOT_DIRECTORY}${variant.filename}`,
			animations: "disabled"
		});
	} finally {
		await context.close();
	}
}

await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
	for (const variant of variants) {
		await captureVariant(browser, variant);
	}
} finally {
	await browser.close();
}
