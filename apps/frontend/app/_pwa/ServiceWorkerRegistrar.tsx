"use client";

import { useEffect } from "react";

type ServiceWorkerCleanupOptions = {
	serviceWorker: ServiceWorkerContainer;
	cacheStorage?: CacheStorage | undefined;
	reload?: (() => void) | undefined;
};

/**
 * Removes production PWA state before development continues on the same origin.
 */
export async function clearServiceWorkerState({
	serviceWorker,
	cacheStorage,
	reload
}: ServiceWorkerCleanupOptions): Promise<void> {
	const controlledByWorker = serviceWorker.controller !== null;
	const registrations = await serviceWorker.getRegistrations();
	await Promise.all(
		registrations.map((registration) => registration.unregister())
	);

	if (cacheStorage) {
		const keys = await cacheStorage.keys();
		await Promise.all(
			keys
				.filter((key) => key.startsWith("signalhaven-"))
				.map((key) => cacheStorage.delete(key))
		);
	}

	// An unregistered worker controls the current document until it unloads.
	if (controlledByWorker) reload?.();
}

/**
 * Owns the production service worker that caches the app shell.
 *
 * Registration is deferred until *after* the page becomes interactive so it
 * never competes with the initial render for main-thread time. We use
 * `requestIdleCallback` when available and fall back to `load`-event
 * scheduling otherwise.
 *
 * Development removes any worker left by a production preview. A production
 * worker can otherwise cache Next.js development responses, keep pages
 * available after the server stops, and interfere with route transitions.
 *
 * The worker itself lives at `/sw.js` so it can control the entire origin.
 */
export function ServiceWorkerRegistrar() {
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (!("serviceWorker" in navigator)) return;

		const serviceWorkerEnabled =
			process.env.NODE_ENV === "production" &&
			process.env.NEXT_PUBLIC_DISABLE_SW !== "1";
		if (!serviceWorkerEnabled) {
			// Unregistering alone leaves CacheStorage available to the old worker
			// until reload, so remove only the caches owned by SignalHaven too.
			void clearServiceWorkerState({
				serviceWorker: navigator.serviceWorker,
				cacheStorage: "caches" in window ? window.caches : undefined,
				reload: () => window.location.reload()
			}).catch(() => {
				/* Cleanup is best-effort so development remains usable. */
			});
			return;
		}

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
