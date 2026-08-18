import assert from "node:assert/strict";
import test from "node:test";

import express, { json, urlencoded } from "express";
import request from "supertest";

import {
	authLoginSchema,
	authSessionSchema,
	authSetupSchema,
	authStatusSchema,
	userCreateSchema,
	userPreferencesPatchSchema
} from "@signalhaven/shared";

import {
	AuthService,
	MAX_ACTIVE_SESSIONS_PER_USER,
	SESSION_DURATION_MS,
	type IssuedSession
} from "../src/auth/auth.service";
import { createAuthenticationMiddleware } from "../src/auth/middleware";
import {
	MEDIA_TICKET_DURATION_MS,
	MEDIA_TICKETS_PER_USER,
	MediaTicketService
} from "../src/auth/media-ticket.service";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { createAuthRateLimiter } from "../src/auth/rate-limit";
import { hashOpaqueToken } from "../src/auth/session-token";
import { errorHandler } from "../src/http/middleware/errors";
import { redactSensitiveUrl } from "../src/http/middleware/logger";
import { createAuthRouter } from "../src/http/routes/auth";
import { createMediaTicketsRouter } from "../src/http/routes/media-tickets";
import type { SessionsRepository } from "../src/repositories/sessions.repository";
import type { MediaTicketsRepository } from "../src/repositories/media-tickets.repository";
import type {
	UserRecord,
	UsersRepository
} from "../src/repositories/users.repository";
import type { SystemStatusService } from "../src/system/system-status.service";
import { ChannelNotStreamableError } from "../src/streaming/streaming.service";

const testUser = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "Admin",
	role: "admin" as const
};

class MemoryUsers {
	private active = false;
	private readonly rows = new Map<string, UserRecord>();

	requiresInitialAdmin = async () => !this.active;

	activateInitialAdmin = async (input: {
		username: string;
		usernameNormalized: string;
		passwordHash: string;
	}) => {
		if (this.active) return null;
		this.active = true;
		const record: UserRecord = {
			id: testUser.id,
			...input,
			role: "admin",
			activatedAt: new Date()
		};
		this.rows.set(record.id, record);
		return record;
	};

	findByNormalizedUsername = async (username: string) =>
		[...this.rows.values()].find(
			(row) => row.usernameNormalized === username
		) ?? null;

	listActive = async () => [...this.rows.values()];

	create = async (input: {
		id: string;
		username: string;
		usernameNormalized: string;
		passwordHash: string;
	}) => {
		if (await this.findByNormalizedUsername(input.usernameNormalized)) {
			throw Object.assign(new Error("duplicate"), { code: "23505" });
		}
		const record: UserRecord = {
			...input,
			role: "user",
			activatedAt: new Date()
		};
		this.rows.set(record.id, record);
		return record;
	};

	get(id: string): UserRecord | undefined {
		return this.rows.get(id);
	}
}

class MemorySessions {
	readonly rows = new Map<
		string,
		{ id: string; userId: string; expiresAt: Date }
	>();

	constructor(private readonly users: MemoryUsers) {}

	create = async (
		input: {
			id: string;
			userId: string;
			tokenHash: string;
			expiresAt: Date;
		},
		maxActive = MAX_ACTIVE_SESSIONS_PER_USER
	) => {
		const activeForUser = [...this.rows.entries()].filter(
			([, row]) => row.userId === input.userId
		);
		for (const [hash] of activeForUser.slice(
			0,
			Math.max(0, activeForUser.length - maxActive + 1)
		)) {
			this.rows.delete(hash);
		}
		this.rows.set(input.tokenHash, input);
	};

	findActiveByTokenHash = async (tokenHash: string) => {
		const session = this.rows.get(tokenHash);
		const user = session ? this.users.get(session.userId) : undefined;
		if (!session || !user || session.expiresAt <= new Date()) return null;
		return {
			id: session.id,
			userId: session.userId,
			username: user.username,
			role: user.role,
			expiresAt: session.expiresAt
		};
	};

	deleteById = async (id: string) => {
		for (const [hash, row] of this.rows) {
			if (row.id === id) this.rows.delete(hash);
		}
	};
}

/** Exercise the public auth boundary without introducing a production bypass. */
function buildAuthApp() {
	const issued: IssuedSession = {
		principal: {
			sessionId: "00000000-0000-4000-8000-000000000002",
			user: testUser
		},
		token: "s".repeat(43),
		expiresAt: new Date("2030-01-01T00:00:00.000Z")
	};
	const auth = {
		requiresInitialAdmin: async () => false,
		setup: async () => issued,
		login: async () => issued,
		authenticateToken: async () => null,
		logout: async () => undefined
	} as unknown as AuthService;
	const app = express();
	app.set("trust proxy", "loopback");
	app.use(json());
	app.use(urlencoded({ extended: true }));
	app.use(
		createAuthRouter({
			auth,
			authentication: createAuthenticationMiddleware(auth),
			systemStatus: {
				getStatus: async () => ({ firstRun: false })
			} as unknown as SystemStatusService
		})
	);
	app.use(errorHandler());
	return app;
}

test("auth schemas keep browser and Apple session transports explicit", () => {
	const cookie = authLoginSchema.parse({
		username: "Admin",
		password: "correct horse battery staple",
		transport: "cookie"
	});
	const bearer = authSetupSchema.parse({
		username: "Admin",
		password: "correct horse battery staple",
		transport: "bearer"
	});

	assert.equal(cookie.transport, "cookie");
	assert.equal(bearer.transport, "bearer");
	assert.equal(
		authSessionSchema.parse({
			user: { id: crypto.randomUUID(), username: "Admin", role: "admin" },
			token: null,
			expiresAt: new Date().toISOString()
		}).token,
		null
	);
});

test("auth status distinguishes account bootstrap from system onboarding", () => {
	const status = authStatusSchema.parse({
		requiresInitialAdmin: true,
		systemSetupRequired: false,
		user: null
	});

	assert.deepEqual(status, {
		requiresInitialAdmin: true,
		systemSetupRequired: false,
		user: null
	});
});

test("created accounts are always regular users and preferences stay bounded", () => {
	assert.deepEqual(
		userCreateSchema.parse({
			username: "viewer",
			password: "correct horse battery staple"
		}),
		{
			username: "viewer",
			password: "correct horse battery staple"
		}
	);
	assert.deepEqual(
		userPreferencesPatchSchema.parse({
			channels: { favorites: [], hidden: [], order: [] }
		}),
		{ channels: { favorites: [], hidden: [], order: [] } }
	);
});

test("password hashes are salted and never retain the plaintext password", async () => {
	const password = "correct horse battery staple";
	const first = await hashPassword(password);
	const second = await hashPassword(password);

	assert.notEqual(first, second);
	assert.doesNotMatch(first, new RegExp(password));
	assert.equal(await verifyPassword(password, first), true);
	assert.equal(await verifyPassword("not the password", first), false);
});

test("AuthService owns one-time setup, normalized users, and revocable hashed sessions", async () => {
	const users = new MemoryUsers();
	const sessions = new MemorySessions(users);
	const auth = new AuthService({
		users: users as unknown as UsersRepository,
		sessions: sessions as unknown as SessionsRepository
	});
	const setup = await auth.setup({
		username: "Admin",
		password: "administrator password",
		transport: "bearer"
	});

	assert.equal(setup.principal.user.role, "admin");
	assert.equal(await auth.requiresInitialAdmin(), false);
	assert.ok(sessions.rows.has(hashOpaqueToken(setup.token)));
	assert.equal(sessions.rows.has(setup.token), false);
	await assert.rejects(
		auth.setup({
			username: "another-admin",
			password: "administrator password",
			transport: "bearer"
		}),
		(error: unknown) => (error as { status?: unknown }).status === 409
	);

	const user = await auth.createUser({
		username: "Viewer",
		password: "viewer password"
	});
	assert.equal(user.role, "user");
	await assert.rejects(
		auth.createUser({
			username: "viewer",
			password: "another password"
		}),
		(error: unknown) => (error as { status?: unknown }).status === 409
	);
	const login = await auth.login({
		username: "VIEWER",
		password: "viewer password",
		transport: "bearer"
	});
	assert.equal((await auth.authenticateToken(login.token))?.user.id, user.id);
	assert.ok(
		login.expiresAt.getTime() - Date.now() > SESSION_DURATION_MS - 5_000
	);
	const storedLogin = sessions.rows.get(hashOpaqueToken(login.token));
	assert.ok(storedLogin);
	storedLogin.expiresAt = new Date(Date.now() - 1);
	assert.equal(await auth.authenticateToken(login.token), null);

	const logoutSession = await auth.login({
		username: "viewer",
		password: "viewer password",
		transport: "bearer"
	});
	await auth.logout(logoutSession.principal.sessionId);
	assert.equal(await auth.authenticateToken(logoutSession.token), null);
	await assert.rejects(
		auth.login({
			username: "Viewer",
			password: "x",
			transport: "bearer"
		}),
		(error: unknown) => (error as { status?: unknown }).status === 401
	);
});

test("media ticket bearer secrets are redacted from request logs", () => {
	const secret = "a".repeat(43);
	const logged = redactSensitiveUrl(
		`/api/v1/stream/channel/master.m3u8?mediaTicket=${secret}&profile=auto`
	);

	assert.doesNotMatch(logged, new RegExp(secret));
	assert.match(logged, /mediaTicket=%3Credacted%3E/);
	assert.match(logged, /profile=auto/);
});

test("media tickets bind resource and playback choices without persisting the secret", async () => {
	let stored:
		| {
				tokenHash: string;
				sessionId: string;
				userId: string;
				resourceKind: "live" | "recording";
				resourceId: string;
				claims: Record<string, unknown>;
				expiresAt: Date;
		  }
		| undefined;
	let active = true;
	const repository = {
		createBounded: async (input: NonNullable<typeof stored>) => {
			stored = input;
		},
		findActive: async (input: {
			tokenHash: string;
			resourceKind: "live" | "recording";
			resourceId: string;
		}) => {
			if (
				!active ||
				!stored ||
				input.tokenHash !== stored.tokenHash ||
				input.resourceKind !== stored.resourceKind ||
				input.resourceId !== stored.resourceId
			) {
				return null;
			}
			return {
				sessionId: stored.sessionId,
				userId: stored.userId,
				username: "Viewer",
				role: "user" as const,
				expiresAt: stored.expiresAt,
				claims: stored.claims
			};
		}
	};
	const service = new MediaTicketService(
		repository as unknown as MediaTicketsRepository
	);
	const principal = {
		sessionId: "00000000-0000-4000-8000-000000000002",
		user: {
			id: "00000000-0000-4000-8000-000000000003",
			username: "Viewer",
			role: "user" as const
		}
	};
	const issued = await service.issue(principal, {
		kind: "live",
		id: "channel-7",
		claims: {
			profile: "720p",
			viewerId: "00000000-0000-4000-8000-000000000004"
		}
	});

	assert.ok(stored);
	assert.equal(stored.tokenHash, hashOpaqueToken(issued.token));
	assert.notEqual(stored.tokenHash, issued.token);
	assert.ok(
		issued.expiresAt.getTime() - Date.now() > MEDIA_TICKET_DURATION_MS - 5_000
	);
	const validUrl = new URL(
		"http://dvr/api/v1/stream/channel-7/master.m3u8?profile=720p&viewerId=00000000-0000-4000-8000-000000000004"
	);
	assert.ok(
		await service.authenticate(
			issued.token,
			{ kind: "live", id: "channel-7" },
			validUrl
		)
	);
	validUrl.searchParams.set("profile", "1080p");
	assert.equal(
		await service.authenticate(
			issued.token,
			{ kind: "live", id: "channel-7" },
			validUrl
		),
		null
	);
	assert.equal(
		await service.authenticate(
			issued.token,
			{ kind: "live", id: "another-channel" },
			validUrl
		),
		null
	);
	active = false;
	assert.equal(
		await service.authenticate(
			issued.token,
			{ kind: "live", id: "channel-7" },
			validUrl
		),
		null
	);

	active = true;
	const recordingId = "00000000-0000-4000-8000-000000000005";
	const recordingTicket = await service.issue(principal, {
		kind: "recording",
		id: recordingId,
		claims: {
			start: 1_800,
			viewerId: "00000000-0000-4000-8000-000000000006"
		}
	});
	const recordingManifest = new URL(
		`http://dvr/api/v1/recordings/${recordingId}/stream.m3u8?start=1800&viewerId=00000000-0000-4000-8000-000000000006`
	);
	assert.ok(
		await service.authenticate(
			recordingTicket.token,
			{ kind: "recording", id: recordingId },
			recordingManifest
		)
	);
	recordingManifest.searchParams.set("start", "900");
	assert.equal(
		await service.authenticate(
			recordingTicket.token,
			{ kind: "recording", id: recordingId },
			recordingManifest
		),
		null
	);
	const nestedSegment = new URL(
		`http://dvr/api/v1/recordings/${recordingId}/segments/segment.m4s?session=00000000-0000-4000-8000-000000000007&viewerId=00000000-0000-4000-8000-000000000006`
	);
	assert.ok(
		await service.authenticate(
			recordingTicket.token,
			{ kind: "recording", id: recordingId },
			nestedSegment
		)
	);
	nestedSegment.searchParams.set(
		"viewerId",
		"00000000-0000-4000-8000-000000000008"
	);
	assert.equal(
		await service.authenticate(
			recordingTicket.token,
			{ kind: "recording", id: recordingId },
			nestedSegment
		),
		null
	);
});

test("media ticket issuance rotates old capabilities instead of locking out playback", async () => {
	const active: string[] = [];
	const repository = {
		createBounded: async (input: { tokenHash: string }) => {
			active.push(input.tokenHash);
			while (active.length > MEDIA_TICKETS_PER_USER) active.shift();
		},
		findActive: async () => null
	};
	const service = new MediaTicketService(
		repository as unknown as MediaTicketsRepository
	);
	const principal = {
		sessionId: "00000000-0000-4000-8000-000000000002",
		user: {
			id: "00000000-0000-4000-8000-000000000003",
			username: "Viewer",
			role: "user" as const
		}
	};
	const results = await Promise.all(
		Array.from({ length: MEDIA_TICKETS_PER_USER + 1 }, (_, index) =>
			service.issue(principal, {
				kind: "live",
				id: `channel-${index}`,
				claims: { profile: "auto" }
			})
		)
	);

	assert.equal(results.length, MEDIA_TICKETS_PER_USER + 1);
	assert.equal(active.length, MEDIA_TICKETS_PER_USER);
	assert.equal(active.includes(hashOpaqueToken(results[0]!.token)), false);
});

test("live media-ticket issuance validates the channel before storing a capability", async () => {
	let issueCount = 0;
	const app = express();
	app.use(json());
	app.use((req, _res, next) => {
		req.auth = {
			sessionId: "00000000-0000-4000-8000-000000000002",
			user: {
				id: "00000000-0000-4000-8000-000000000003",
				username: "viewer",
				role: "user"
			}
		};
		next();
	});
	app.use(
		createMediaTicketsRouter({
			tickets: {
				issue: async () => {
					issueCount += 1;
					throw new Error("Ticket issuance should not run");
				}
			} as never,
			assertLiveStreamable: async (channelId) => {
				throw new ChannelNotStreamableError(channelId);
			}
		})
	);
	app.use(errorHandler());

	const response = await request(app)
		.post("/stream/00000000-0000-4000-8000-000000000004/media-ticket")
		.send({});

	assert.equal(response.status, 404);
	assert.equal(response.body.error.code, "not_found");
	assert.equal(response.body.error.message, "Channel is unavailable");
	assert.equal(issueCount, 0);
});

test("cookie login requires a same-origin Origin while bearer login does not", async () => {
	const app = buildAuthApp();
	const payload = {
		username: "Admin",
		password: "password",
		transport: "cookie"
	};

	const missingOrigin = await request(app)
		.post("/auth/login")
		.set("Host", "dvr.local")
		.send(payload);
	assert.equal(missingOrigin.status, 403);
	assert.equal(missingOrigin.headers["cache-control"], "private, no-store");

	const crossOriginForm = await request(app)
		.post("/auth/login")
		.set("Host", "dvr.local")
		.set("Origin", "http://attacker.local")
		.type("form")
		.send(payload);
	assert.equal(crossOriginForm.status, 403);

	const bearer = await request(app)
		.post("/auth/login")
		.send({
			...payload,
			transport: "bearer"
		});
	assert.equal(bearer.status, 200);
	assert.equal(bearer.body.token, "s".repeat(43));
	assert.equal(bearer.body.expiresAt, "2030-01-01T00:00:00Z");
});

test("session cookies follow the actual LAN or trusted-proxy HTTPS request", async () => {
	const app = buildAuthApp();
	const payload = {
		username: "Admin",
		password: "password",
		transport: "cookie"
	};
	const http = await request(app)
		.post("/auth/login")
		.set("Host", "dvr.local")
		.set("Origin", "http://dvr.local")
		.send(payload);
	assert.equal(http.status, 200);
	assert.doesNotMatch(http.headers["set-cookie"]?.[0] ?? "", /; Secure/i);
	const wrongScheme = await request(app)
		.post("/auth/login")
		.set("Host", "dvr.local")
		.set("Origin", "https://dvr.local")
		.send(payload);
	assert.equal(wrongScheme.status, 403);

	const forwardedHttps = await request(app)
		.post("/auth/login")
		.set("Host", "proxy.internal")
		.set("X-Forwarded-Host", "dvr.local")
		.set("X-Forwarded-Proto", "https")
		.set("Origin", "https://dvr.local")
		.send(payload);
	assert.equal(forwardedHttps.status, 200);
	assert.match(forwardedHttps.headers["set-cookie"]?.[0] ?? "", /; Secure/i);
	assert.equal(forwardedHttps.headers["cache-control"], "private, no-store");
});

test("auth rate limiting evicts the oldest live windows at its hard cap", () => {
	const limiter = createAuthRateLimiter({
		limit: 1,
		windowMs: 60_000,
		maxEntries: 2,
		now: () => 1_000
	});
	const run = (ip: string): unknown => {
		let error: unknown;
		limiter(
			{ ip, path: "/auth/login" } as never,
			{ setHeader: () => undefined } as never,
			(value?: unknown) => {
				error = value;
			}
		);
		return error;
	};

	assert.equal(run("one"), undefined);
	assert.equal(run("two"), undefined);
	assert.equal(run("three"), undefined);
	// The oldest still-live key was evicted instead of allowing unbounded growth.
	assert.equal(run("one"), undefined);
});

test("cross-origin and malformed auth requests cannot exhaust the login bucket", async () => {
	const app = buildAuthApp();
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const crossOrigin = await request(app)
			.post("/auth/login")
			.set("Host", "dvr.local")
			.set("Origin", "http://attacker.local")
			.send({ nope: true });
		assert.equal(crossOrigin.status, 403);

		const malformed = await request(app)
			.post("/auth/login")
			.send({ username: "Admin" });
		assert.equal(malformed.status, 400);
	}

	const legitimate = await request(app).post("/auth/login").send({
		username: "Admin",
		password: "password",
		transport: "bearer"
	});
	assert.equal(legitimate.status, 200);
});
