import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";

test("accepts and normalizes an HTTPS public URL", () => {
	const config = loadConfig({
		PUBLIC_URL: "https://service.example.com/signalhaven///"
	});

	assert.equal(config.publicUrl, "https://service.example.com/signalhaven");
	assert.equal(
		config.healthUrl.href,
		"https://service.example.com/signalhaven/api/v1/health"
	);
	assert.equal(config.port, 443);
});

test("requires PUBLIC_URL before starting discovery", () => {
	assert.throws(() => loadConfig({}), /PUBLIC_URL is required/);
});

for (const [label, publicUrl] of [
	["HTTP", "http://service.example.com"],
	["credentials", "https://user:secret@service.example.com"],
	["nonstandard ports", "https://service.example.com:8443"],
	["malformed input", "not a url"],
	["scheme-only syntax", "https:service.example.com"],
	["extra leading slashes", "https:///service.example.com"],
	["unsupported schemes", "ftp://service.example.com"],
	["queries", "https://service.example.com?tenant=one"],
	["fragments", "https://service.example.com/#section"]
] as const) {
	test(`rejects ${label} public URLs`, () => {
		assert.throws(() => loadConfig({ PUBLIC_URL: publicUrl }), /PUBLIC_URL/);
	});
}

test("rejects a health override that does not use the canonical HTTPS origin", () => {
	assert.throws(() =>
		loadConfig({
			PUBLIC_URL: "https://service.example.com",
			SIGNALHAVEN_HEALTH_URL: "http://127.0.0.1:3000/api/v1/health"
		})
	);
});

test("rejects service names that cannot fit in a DNS label", () => {
	assert.throws(
		() =>
			loadConfig({
				PUBLIC_URL: "https://service.example.com",
				SIGNALHAVEN_SERVICE_NAME: "x".repeat(64)
			}),
		/SIGNALHAVEN_SERVICE_NAME must be at most 63 UTF-8 bytes/
	);
});
