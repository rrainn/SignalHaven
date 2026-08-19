import path from "path";
import type { NextConfig } from "next";

/**
 * Backend origin used by the dev-time `/api/*` rewrite. Override via
 * `SIGNALHAVEN_BACKEND_ORIGIN` (e.g. `http://localhost:3001`) when running the
 * backend on a non-default port.
 */
const backendOrigin =
	process.env.SIGNALHAVEN_BACKEND_ORIGIN ?? "http://localhost:3001";
const isSafePreviewBuild = process.env.SIGNALHAVEN_SAFE_PREVIEW === "1";

const nextConfig: NextConfig = {
	reactStrictMode: true,
	// Keep gzip enabled for Next-owned responses; proxied API JSON is compressed
	// by the backend and its Content-Encoding header is forwarded unchanged.
	compress: true,
	// Bound only safe-preview builds so regular CI and release builds retain
	// their existing parallelism.
	...(isSafePreviewBuild
		? {
				experimental: {
					cpus: 1,
					staticGenerationMaxConcurrency: 1
				}
			}
		: {}),
	// Produce a self-contained server bundle for Docker deployment. All
	// runtime dependencies are traced and copied into .next/standalone so
	// only `node server.js` is needed to start the frontend in the image.
	output: "standalone",
	// Ensures that shared packages outside this workspace (packages/shared)
	// are included in the traced standalone bundle.
	outputFileTracingRoot: path.join(__dirname, "../../"),
	// Proxy `/api/*` to the backend in development so the browser sees a
	// single origin and we never need CORS in dev. In production both apps
	// are expected to be served behind the same reverse proxy, so this rule
	// is a no-op there (Next.js still applies it but the user can override).
	async rewrites() {
		return [
			{
				source: "/api/:path*",
				destination: `${backendOrigin}/api/:path*`
			}
		];
	},
	async headers() {
		return [
			{
				// The service worker must be served with a scope of `/` so it can
				// intercept navigations site-wide. The default is its own path.
				source: "/sw.js",
				headers: [
					{ key: "Service-Worker-Allowed", value: "/" },
					// Defensive: stop any intermediate cache from pinning an old SW.
					{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }
				]
			}
		];
	}
};

export default nextConfig;
