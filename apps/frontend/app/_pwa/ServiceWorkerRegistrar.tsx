"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that caches the app shell.
 *
 * Registration is deferred until *after* the page becomes interactive so it
 * never competes with the initial render for main-thread time. We use
 * `requestIdleCallback` when available and fall back to `load`-event
 * scheduling otherwise.
 *
 * The worker itself lives at `/sw.js` so it can control the entire origin.
 */
export function ServiceWorkerRegistrar() {
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (!("serviceWorker" in navigator)) return;
		// Don't register on `localhost` HTTP dev unless it's https or localhost
		// (which the SW spec already permits). We also skip registration when
		// explicitly disabled via env (handy for E2E tests).
		if (process.env.NEXT_PUBLIC_DISABLE_SW === "1") return;

		const register = () => {
			navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
				/* Registration failures are non-fatal; the app still works. */
			});
		};

		type IdleWindow = Window & {
			requestIdleCallback?: (
				cb: () => void,
				opts?: { timeout: number }
			) => number;
		};
		const w = window as IdleWindow;
		if (typeof w.requestIdleCallback === "function") {
			w.requestIdleCallback(register, { timeout: 3000 });
		} else {
			// Wait for `load` so registration happens after first interactive.
			window.addEventListener("load", register, { once: true });
		}
	}, []);

	return null;
}
