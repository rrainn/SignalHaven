import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composeUrl = new URL("../docker-compose.yml", import.meta.url);
const nginxExampleUrl = new URL(
	"../docs/examples/signalhaven-nginx.conf",
	import.meta.url
);

test("the example deployment keeps plaintext backend traffic off the LAN", async () => {
	const compose = await readFile(composeUrl, "utf8");

	assert.match(
		compose,
		/127\.0\.0\.1:\$\{SIGNALHAVEN_HTTP_PORT:-3000\}:3000/,
		"the backend port should be reachable only from the reverse-proxy host"
	);
	assert.doesNotMatch(
		compose,
		/^\s+- "\$\{SIGNALHAVEN_HTTP_PORT:-3000\}:3000"/m,
		"the backend must not bind plaintext HTTP on every LAN interface"
	);
});

test("the Bonjour sidecar is configured from the canonical HTTPS URL", async () => {
	const compose = await readFile(composeUrl, "utf8");
	const sidecarStart = compose.indexOf("  signalhaven-bonjour:");
	const sidecar = compose.slice(
		sidecarStart,
		compose.indexOf("\n  postgres:", sidecarStart)
	);

	assert.match(sidecar, /PUBLIC_URL: \$\{PUBLIC_URL:/);
	assert.doesNotMatch(sidecar, /SIGNALHAVEN_HTTP_PORT:/);
	assert.doesNotMatch(sidecar, /SIGNALHAVEN_HEALTH_URL:/);
});

test("the reverse-proxy example preserves upgraded and streamed traffic", async () => {
	const nginx = await readFile(nginxExampleUrl, "utf8");

	assert.match(nginx, /listen 443 ssl/);
	assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/);
	assert.match(nginx, /proxy_set_header X-Forwarded-Host \$host/);
	assert.match(nginx, /proxy_set_header X-Forwarded-Proto https/);
	assert.match(nginx, /proxy_buffering off/);
	assert.doesNotMatch(nginx, /listen 3000/);
});
