import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";

test("uses the published SignalHaven port in the default health URL", () => {
	const config = loadConfig({ SIGNALHAVEN_HTTP_PORT: "43123" });

	assert.equal(config.port, 43_123);
	assert.equal(config.healthUrl.href, "http://127.0.0.1:43123/api/v1/health");
});

test("rejects invalid ports before starting discovery", () => {
	assert.throws(
		() => loadConfig({ SIGNALHAVEN_HTTP_PORT: "70000" }),
		/SIGNALHAVEN_HTTP_PORT must be an integer between 1 and 65535/
	);
});

test("rejects service names that cannot fit in a DNS label", () => {
	assert.throws(
		() => loadConfig({ SIGNALHAVEN_SERVICE_NAME: "x".repeat(64) }),
		/SIGNALHAVEN_SERVICE_NAME must be at most 63 UTF-8 bytes/
	);
});
