/* SignalHaven service worker — minimal app-shell cache. */
/* eslint-env serviceworker */

const VERSION = "v2";
const SHELL_CACHE = `signalhaven-shell-${VERSION}`;
const RUNTIME_CACHE = `signalhaven-runtime-${VERSION}`;

// Files that make up the offline-capable shell. Kept short — Next.js asset
// URLs are content-hashed, so we let runtime caching handle them lazily.
// Root HTML is account-owned, so only user-neutral offline assets are shared.
const SHELL_URLS = ["/manifest.webmanifest", "/offline.html"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(SHELL_CACHE).then((cache) =>
			// `addAll` aborts on the first failure; use individual adds so a missing
			// entry (e.g. /offline.html before it ships) doesn't break install.
			Promise.all(
				SHELL_URLS.map((url) =>
					cache.add(url).catch(() => {
						/* Ignore individual failures during install. */
					})
				)
			)
		)
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
						.map((k) => caches.delete(k))
				)
			)
	);
	self.clients.claim();
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;

	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	// Never cache API calls — they must always hit the network.
	if (url.pathname.startsWith("/api/")) return;

	// Next RSC payloads can contain account-owned route state and are never shared.
	if (url.searchParams.has("_rsc") || req.headers.get("RSC") === "1") return;

	// Navigation HTML is private. Use the network or a user-neutral offline page.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req).catch(async () => {
				const offline = await caches.match("/offline.html");
				return (
					offline ||
					new Response("SignalHaven is offline.", {
						status: 503,
						headers: { "Content-Type": "text/plain; charset=utf-8" }
					})
				);
			})
		);
		return;
	}

	// Cache only immutable/user-neutral assets, never arbitrary same-origin GETs.
	const cacheableAsset =
		url.pathname.startsWith("/_next/static/") ||
		url.pathname.startsWith("/icons/") ||
		url.pathname === "/manifest.webmanifest" ||
		url.pathname === "/offline.html" ||
		url.pathname === "/favicon.ico";
	if (!cacheableAsset) return;

	// User-neutral static assets remain cache-first for a useful offline surface.
	event.respondWith(
		caches.match(req).then(
			(cached) =>
				cached ||
				fetch(req)
					.then((res) => {
						if (!res || res.status !== 200 || res.type !== "basic") return res;
						const clone = res.clone();
						caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
						return res;
					})
					.catch(() => cached)
		)
	);
});
