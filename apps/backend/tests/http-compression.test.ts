import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app";
import { createTestAuthentication } from "../src/auth/middleware";

test("large JSON responses are compressed for the Next.js proxy", async () => {
	const app = createApp({
		authentication: createTestAuthentication(),
		configureV1Router: (router) => {
			// This mirrors a large Guide response without coupling the assertion to
			// the compression middleware's default one-kilobyte threshold.
			router.get("/compression-test", (_req, res) => {
				res.json({ payload: "guide-cell".repeat(1_000) });
			});
		}
	});

	const response = await request(app)
		.get("/api/v1/compression-test")
		.set("Accept-Encoding", "br, gzip");

	assert.equal(response.status, 200);
	const contentEncoding = response.headers["content-encoding"];
	assert.ok(
		typeof contentEncoding === "string" &&
			["br", "gzip"].includes(contentEncoding)
	);
	assert.equal(response.body.payload.length, "guide-cell".length * 1_000);
});
