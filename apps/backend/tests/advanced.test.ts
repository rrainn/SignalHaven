import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { test } from "node:test";

import { errorHandler } from "../src/http/middleware/errors";
import { createAdvancedRouter } from "../src/http/routes/advanced";

test("advanced external IP route is disabled unless explicitly enabled", async () => {
	const app = express();
	let fetchCalled = false;
	app.use(
		"/api/v1",
		createAdvancedRouter({
			env: {},
			fetch: async () => {
				fetchCalled = true;
				return new Response("203.0.113.42", { status: 200 });
			}
		})
	);
	app.use(errorHandler());

	const response = await request(app).get("/api/v1/advanced/external-ip");

	assert.equal(response.status, 403);
	assert.equal(response.body.error.code, "external_ip_lookup_disabled");
	assert.equal(fetchCalled, false);
});

test("advanced external IP route returns the server address from the configured lookup", async () => {
	const app = express();
	const calls: string[] = [];
	app.use(
		"/api/v1",
		createAdvancedRouter({
			env: { SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED: "true" },
			fetch: async (input) => {
				calls.push(String(input));
				return new Response("203.0.113.42\n", { status: 200 });
			}
		})
	);

	const response = await request(app).get("/api/v1/advanced/external-ip");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { ip: "203.0.113.42" });
	assert.deepEqual(calls, ["https://ip.rrainn.space"]);
	assert.equal(response.headers["cache-control"], "no-store");
});

test("advanced external IP route accepts the lookup's JSON response", async () => {
	const app = express();
	app.use(
		"/api/v1",
		createAdvancedRouter({
			env: { SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED: "1" },
			fetch: async () =>
				Response.json({
					ip: "2001:db8::42",
					version: 6,
					country: "US"
				})
		})
	);

	const response = await request(app).get("/api/v1/advanced/external-ip");

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { ip: "2001:db8::42" });
});
