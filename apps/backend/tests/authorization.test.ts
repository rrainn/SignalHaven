import assert from "node:assert/strict";
import test from "node:test";

import {
	settingsDefaults,
	userPreferencesDefaults,
	type User
} from "@signalhaven/shared";
import express, { json } from "express";
import request from "supertest";

import {
	createTestAuthentication,
	type AuthenticationMiddleware
} from "../src/auth/middleware";
import {
	forbidden,
	unauthorized,
	errorHandler,
	HttpError
} from "../src/http/middleware/errors";
import { createApiV1Router } from "../src/http/router";
import { AdaptiveEncoderCapacityError } from "../src/streaming/stream-session";
import { TunerUnavailableError } from "../src/tuners/tuner-allocator";

const USER_ID = "00000000-0000-4000-8000-000000000010";
const ADMIN_ID = "00000000-0000-4000-8000-000000000011";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000012";
const SOURCE_ID = "00000000-0000-4000-8000-000000000013";
const TUNER_ID = "00000000-0000-4000-8000-000000000014";
const PRIVATE_ID = "00000000-0000-4000-8000-000000000015";
const BACKUP_SOURCE_ID = "00000000-0000-4000-8000-000000000016";

const regularUser: User = { id: USER_ID, username: "viewer", role: "user" };
const administrator: User = {
	id: ADMIN_ID,
	username: "admin",
	role: "admin"
};

/** Recreate the allocator error so each request has an independent stack. */
function tunerCapacityError(): TunerUnavailableError {
	return new TunerUnavailableError(TUNER_ID, [
		{
			leaseId: "private-lease",
			providerId: TUNER_ID,
			channelId: "private-provider-channel",
			purpose: "record",
			priority: 100,
			acquiredAt: "2026-08-12T00:00:00.000Z"
		}
	]);
}

/** Build the production router with deterministic seams at its service boundary. */
function buildApp(
	user: User,
	observed: { guideUser?: string; libraryUser?: string },
	streamError: Error = tunerCapacityError()
) {
	const app = express();
	app.use(json());
	app.use((req, _res, next) => {
		req.id = "authorization-test";
		next();
	});
	app.use(
		"/api/v1",
		createApiV1Router({
			healthRepository: {} as never,
			authService: {
				requiresInitialAdmin: async () => false,
				listUsers: async () => [administrator, regularUser]
			} as never,
			authentication: createTestAuthentication(user),
			mediaTicketService: {} as never,
			userPreferencesService: {
				getAll: async () => userPreferencesDefaults,
				patch: async () => userPreferencesDefaults
			} as never,
			settingsService: {
				getAll: async () => settingsDefaults,
				patch: async () => settingsDefaults
			} as never,
			systemStatusService: {
				getStatus: async () => ({ firstRun: false })
			} as never,
			tunersService: {} as never,
			lineupSyncService: {} as never,
			channelsRepository: {
				listLogicalChannelSummaries: async () => [
					{
						channel: {
							id: CHANNEL_ID,
							number: "7.1",
							name: "News",
							logoUrl:
								"https://provider.internal/logo.png?token=private-logo-token",
							enabled: true,
							sortOrder: 1
						},
						sources: [
							{
								id: SOURCE_ID,
								tunerId: TUNER_ID,
								tunerName: "Roof antenna",
								tunerKind: "hdhomerun",
								number: "7.1",
								name: "News",
								tvgId: "provider-news",
								enabled: true,
								sourceStatus: "active",
								sourcePriority: 0
							},
							{
								id: BACKUP_SOURCE_ID,
								tunerId: TUNER_ID,
								tunerName: "Backup antenna",
								tunerKind: "hdhomerun",
								number: "7.1",
								name: "News",
								tvgId: "provider-news-backup",
								enabled: true,
								sourceStatus: "active",
								sourcePriority: 1
							}
						],
						mappedEpgChannelId: SOURCE_ID
					}
				]
			} as never,
			epgService: {} as never,
			epgGridService: {
				invalidateSnapshot: () => undefined,
				getGrid: async (from: Date, to: Date, userId: string) => {
					observed.guideUser = userId;
					return {
						from: from.toISOString(),
						to: to.toISOString(),
						channels: [],
						programs: []
					};
				}
			} as never,
			epgMatcherService: {} as never,
			streamingService: {
				attach: async () => {
					throw streamError;
				}
			} as never,
			recordingsService: {
				listPage: async (_query: unknown, userId: string) => {
					observed.libraryUser = userId;
					return {
						items: [],
						total: 0,
						totalSize: 0,
						limit: 50,
						offset: 0,
						nextCursor: null,
						seriesGroups: [],
						oneOffGroup: null
					};
				},
				assertOwned: async () => {
					throw new HttpError(404, "not_found", "Recording not found");
				},
				schedule: async () => {
					throw tunerCapacityError();
				}
			} as never,
			seriesRulesService: {
				list: async () => [],
				getById: async () => null,
				getConflicts: () => []
			} as never,
			env: { NODE_ENV: "production" }
		})
	);
	app.use(errorHandler());
	return app;
}

test("standard users keep guide and library access without machine topology", async () => {
	const observed: { guideUser?: string; libraryUser?: string } = {};
	const app = buildApp(regularUser, observed);
	const from = "2026-08-12T00:00:00.000Z";
	const to = "2026-08-12T01:00:00.000Z";

	const [preferences, channels, guide, recordings] = await Promise.all([
		request(app).get("/api/v1/preferences"),
		request(app).get("/api/v1/channels"),
		request(app).get("/api/v1/epg/grid").query({ from, to }),
		request(app).get("/api/v1/recordings")
	]);
	for (const response of [preferences, channels, guide, recordings]) {
		assert.equal(response.status, 200);
		assert.equal(response.headers["cache-control"], "private, no-store");
	}
	assert.equal(observed.guideUser, USER_ID);
	assert.equal(observed.libraryUser, USER_ID);
	assert.equal(channels.body.items[0].id, CHANNEL_ID);
	assert.equal(
		channels.body.items[0].logoUrl,
		`/api/v1/channels/${CHANNEL_ID}/logo`
	);
	assert.doesNotMatch(
		JSON.stringify(channels.body),
		/provider\.internal|private-logo-token/
	);
	assert.equal(channels.body.items[0].availableSourceCount, 1);
	assert.equal(channels.body.items[0].hasMapping, true);
	for (const field of [
		"tunerId",
		"tunerName",
		"tunerKind",
		"tvgId",
		"sources"
	]) {
		assert.equal(field in channels.body.items[0], false);
	}
});

test("standard users receive 403 for settings and topology diagnostics", async () => {
	const app = buildApp(regularUser, {});
	for (const [method, path] of [
		["get", "/api/v1/settings"],
		["get", "/api/v1/users"],
		["get", "/api/v1/tuners"],
		["get", "/api/v1/advanced/ffmpeg"],
		["get", `/api/v1/channels/${CHANNEL_ID}/quality`],
		["get", `/api/v1/channels/${CHANNEL_ID}/epg-candidates`],
		["get", "/api/v1/stream/news/status"],
		["post", "/api/v1/channels/merge"]
	] as const) {
		const response = await request(app)[method](path);
		assert.equal(response.status, 403, `${method.toUpperCase()} ${path}`);
		assert.equal(response.headers["cache-control"], "private, no-store");
	}
});

test("administrators cannot bypass another account's private library", async () => {
	for (const user of [regularUser, administrator]) {
		const app = buildApp(user, {});
		const [recording, rule] = await Promise.all([
			request(app).get(`/api/v1/recordings/${PRIVATE_ID}`),
			request(app).get(`/api/v1/series-rules/${PRIVATE_ID}`)
		]);
		assert.equal(recording.status, 404);
		assert.equal(rule.status, 404);
	}
	const administratorChannels = await request(buildApp(administrator, {})).get(
		"/api/v1/channels"
	);
	assert.equal(administratorChannels.body.items[0].availableSourceCount, 2);
	assert.equal(administratorChannels.body.items[0].sources.length, 2);
});

test("tuner-capacity conflicts hide topology from users but retain admin diagnostics", async () => {
	const scheduleBody = {
		channelId: CHANNEL_ID,
		title: "Private conflict",
		start: "2026-08-12T01:00:00.000Z",
		end: "2026-08-12T02:00:00.000Z"
	};
	const userApp = buildApp(regularUser, {});
	const userResponses = await Promise.all([
		request(userApp).get(
			`/api/v1/stream/${CHANNEL_ID}/master.m3u8?profile=direct`
		),
		request(userApp).post("/api/v1/recordings").send(scheduleBody)
	]);
	for (const response of userResponses) {
		assert.equal(response.status, 409);
		assert.equal(response.body.error.code, "TUNER_UNAVAILABLE");
		assert.equal(response.body.error.details, undefined);
		assert.doesNotMatch(
			JSON.stringify(response.body),
			new RegExp(`${TUNER_ID}|private-lease|private-provider-channel`)
		);
	}

	const adminApp = buildApp(administrator, {});
	const adminResponses = await Promise.all([
		request(adminApp).get(
			`/api/v1/stream/${CHANNEL_ID}/master.m3u8?profile=direct`
		),
		request(adminApp).post("/api/v1/recordings").send(scheduleBody)
	]);
	for (const response of adminResponses) {
		assert.equal(response.status, 409);
		assert.equal(response.body.error.details.conflicts[0].providerId, TUNER_ID);
		assert.equal(
			response.body.error.details.conflicts[0].leaseId,
			"private-lease"
		);
	}
});

test("adaptive encoder capacity hides host diagnostics from standard users", async () => {
	const diagnostic = new AdaptiveEncoderCapacityError(0.73);
	const userResponse = await request(buildApp(regularUser, {}, diagnostic)).get(
		`/api/v1/stream/${CHANNEL_ID}/master.m3u8?profile=auto`
	);
	assert.equal(userResponse.status, 422);
	assert.equal(userResponse.body.error.code, "encoder_capacity");
	assert.doesNotMatch(
		JSON.stringify(userResponse.body),
		/0\.73|1\.25x|hardware/i
	);

	const adminResponse = await request(
		buildApp(administrator, {}, new AdaptiveEncoderCapacityError(0.73))
	).get(`/api/v1/stream/${CHANNEL_ID}/master.m3u8?profile=auto`);
	assert.equal(adminResponse.status, 422);
	assert.match(adminResponse.body.error.message, /0\.73x/);
});

test("protected routers require an injected authenticated principal", async () => {
	const authentication: AuthenticationMiddleware = {
		optional: (_req, _res, next) => next(),
		required: (_req, _res, next) => next(unauthorized()),
		admin: (_req, _res, next) => next(forbidden()),
		cookieOrigin: (_req, _res, next) => next()
	};
	const app = express();
	app.use(
		"/api/v1",
		createApiV1Router({
			...({} as Parameters<typeof createApiV1Router>[0]),
			healthRepository: {} as never,
			authService: {} as never,
			authentication,
			mediaTicketService: {} as never,
			userPreferencesService: {} as never,
			settingsService: {} as never,
			systemStatusService: {} as never,
			tunersService: {} as never,
			lineupSyncService: {} as never,
			channelsRepository: {} as never,
			epgService: {} as never,
			epgGridService: {} as never,
			epgMatcherService: {} as never,
			env: { NODE_ENV: "production" }
		})
	);
	app.use(errorHandler());
	assert.equal((await request(app).get("/api/v1/preferences")).status, 401);
});
