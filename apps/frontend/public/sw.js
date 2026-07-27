/* SignalHaven service worker — minimal app-shell cache. */
/* eslint-env serviceworker */

const VERSION = "v1";
const SHELL_CACHE = `signalhaven-shell-${VERSION}`;
const RUNTIME_CACHE = `signalhaven-runtime-${VERSION}`;

// Files that make up the offline-capable shell. Kept short — Next.js asset
// URLs are content-hashed, so we let runtime caching handle them lazily.
const SHELL_URLS = ["/", "/manifest.webmanifest", "/offline.html"];

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

	// Navigation requests: network-first with offline fallback so users see
	// fresh HTML when online but still get the shell when offline.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const clone = res.clone();
					caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
					return res;
				})
				.catch(() =>
					caches
						.match(req)
						.then(
							(m) => m || caches.match("/offline.html") || caches.match("/")
						)
				)
		);
		return;
	}

	// Static assets: cache-first.
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
