import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createTestAuthentication } from "../src/auth/middleware";
import { createChannelsRouter } from "../src/http/routes/channels";
import { errorHandler } from "../src/http/middleware/errors";

const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const TUNER_ID = "22222222-2222-4222-8222-222222222222";

/** Build a route-level app without PostgreSQL so diagnostics stay fast to test. */
function buildDiagnosticsApp(role: "admin" | "user" = "admin") {
	const authentication = createTestAuthentication({
		id: "33333333-3333-4333-8333-333333333333",
		username: role === "admin" ? "administrator" : "viewer",
		role
	});
	const source = {
		id: CHANNEL_ID,
		logicalChannelId: CHANNEL_ID,
		tunerId: TUNER_ID,
		number: "42",
		providerChannelId: "stored-news-id",
		name: "Provider News",
		logoUrl: "https://images.example.test/news.png",
		tvgId: "news.example",
		enabled: true,
		sortOrder: 7,
		sourceStatus: "active",
		sourcePriority: 0,
		lineupMissingCount: 0,
		tunerName: "Direct HLS",
		tunerKind: "hls"
	};
	const repository = {
		listLogicalChannelSummaries: async () => [
			{
				channel: {
					id: CHANNEL_ID,
					number: "42",
					name: "Displayed News",
					logoUrl: null,
					enabled: true,
					sortOrder: 7
				},
				sources: [source],
				mappedEpgChannelId: null
			}
		],
		getById: async () => source
	};
	const tuners = {
		getProviderById: async () => ({
			getLineup: async () => [
				{
					channelId: "resolved-news-id",
					number: "42",
					name: "Provider News"
				}
			],
			getStreamUrl: async (providerChannelId: string) => ({
				url: `https://streams.example.test/live/${providerChannelId}.m3u8?token=diagnostic`,
				httpHeaders: { referer: "https://guide.example.test" }
			})
		})
	};
	const app = express();
	app.use(authentication.optional);
	app.use(
		createChannelsRouter(
			{} as never,
			tuners as never,
			repository as never,
			authentication.admin
		)
	);
	app.use(errorHandler());
	return app;
}

test("channel diagnostics expose the playback-resolved upstream coordinates", async () => {
	const response = await request(buildDiagnosticsApp()).get(
		`/channels/${CHANNEL_ID}/diagnostics`
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers["cache-control"], "private, no-store");
	assert.equal(response.body.channel.name, "Displayed News");
	assert.equal(
		response.body.sources[0].storedProviderChannelId,
		"stored-news-id"
	);
	assert.equal(
		response.body.sources[0].resolvedProviderChannelId,
		"resolved-news-id"
	);
	assert.equal(
		response.body.sources[0].streamUrl,
		"https://streams.example.test/live/resolved-news-id.m3u8?token=diagnostic"
	);
	assert.deepEqual(response.body.sources[0].httpHeaders, {
		referer: "https://guide.example.test"
	});
});

test("channel diagnostics reject standard accounts", async () => {
	const response = await request(buildDiagnosticsApp("user")).get(
		`/channels/${CHANNEL_ID}/diagnostics`
	);

	assert.equal(response.status, 403);
	assert.equal(response.body.error.code, "forbidden");
});
