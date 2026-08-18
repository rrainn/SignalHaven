import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createTestAuthentication } from "../src/auth/middleware";
import { createChannelsRouter } from "../src/http/routes/channels";
import { createRecordingsRouter } from "../src/http/routes/recordings";
import type { RemoteImageProxy } from "../src/media/remote-image-proxy";

const LOGICAL_CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const RECORDING_ID = "22222222-2222-4222-8222-222222222222";

test("recording artwork route returns proxied image bytes with safe headers", async () => {
	const app = express();
	app.use(createTestAuthentication().optional);
	app.use(
		createRecordingsRouter(
			{
				assertOwned: async () => undefined,
				getArtwork: async () => ({
					body: Buffer.from([1, 2, 3]),
					contentType: "image/jpeg",
					cacheMaxAgeSeconds: 60
				})
			} as never,
			createTestAuthentication().admin
		)
	);

	const response = await request(app).get(
		`/recordings/${RECORDING_ID}/artwork`
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers["content-type"], "image/jpeg");
	assert.equal(response.headers["cache-control"], "private, no-store");
	assert.equal(response.headers["x-content-type-options"], "nosniff");
	assert.deepEqual(response.body, Buffer.from([1, 2, 3]));
});

test("logical channel logo route hides its provider URL behind the API", async () => {
	const requests: Array<{ ownerKey: string; source: string }> = [];
	const proxy = {
		get: async (ownerKey: string, source: string) => {
			requests.push({ ownerKey, source });
			return {
				body: Buffer.from([4, 5, 6]),
				contentType: "image/png",
				cacheMaxAgeSeconds: 120
			};
		}
	} as unknown as RemoteImageProxy;
	const repository = {
		getLogicalChannelById: async () => ({ id: LOGICAL_CHANNEL_ID }),
		listSourcesByLogicalChannelId: async () => [
			{ id: "physical-source", sourceStatus: "active" }
		],
		getById: async () => ({
			id: "physical-source",
			logoUrl: "https://provider.example/channel.png"
		})
	};
	const app = express();
	app.use(
		createChannelsRouter(
			{} as never,
			{} as never,
			repository as never,
			(_req, _res, next) => next(),
			undefined,
			proxy
		)
	);

	const response = await request(app).get(
		`/channels/${LOGICAL_CHANNEL_ID}/logo`
	);

	assert.equal(response.status, 200);
	assert.deepEqual(requests, [
		{
			ownerKey: LOGICAL_CHANNEL_ID,
			source: "https://provider.example/channel.png"
		}
	]);
	assert.equal(response.headers["content-type"], "image/png");
	assert.equal(response.headers["cache-control"], "private, no-store");
	assert.equal(response.headers["x-content-type-options"], "nosniff");
	assert.deepEqual(response.body, Buffer.from([4, 5, 6]));
});
