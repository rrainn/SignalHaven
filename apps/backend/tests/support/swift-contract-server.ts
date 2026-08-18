import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import express, { json, urlencoded } from "express";

import {
	AuthService,
	MAX_ACTIVE_SESSIONS_PER_USER
} from "../../src/auth/auth.service";
import { createAuthenticationMiddleware } from "../../src/auth/middleware";
import { MediaTicketService } from "../../src/auth/media-ticket.service";
import {
	errorHandler,
	notFoundHandler
} from "../../src/http/middleware/errors";
import { requestId } from "../../src/http/middleware/request-id";
import { createAuthRouter } from "../../src/http/routes/auth";
import { createMediaTicketsRouter } from "../../src/http/routes/media-tickets";
import { createPreferencesRouter } from "../../src/http/routes/preferences";
import { RecordingNotFoundError } from "../../src/recordings/recordings.service";
import type {
	ActiveMediaTicket,
	MediaResourceKind
} from "../../src/repositories/media-tickets.repository";
import type { AuthenticatedSessionRecord } from "../../src/repositories/sessions.repository";
import type { UserRecord } from "../../src/repositories/users.repository";
import { UserPreferencesService } from "../../src/settings/user-preferences.service";

const bootstrapUserId = "00000000-0000-4000-8000-000000000001";

/** Keeps one activated administrator for the duration of the bounded HTTP lifecycle. */
class MemoryUsers {
	private activeUser: UserRecord | null = null;

	async requiresInitialAdmin(): Promise<boolean> {
		return this.activeUser === null;
	}

	async activateInitialAdmin(input: {
		username: string;
		usernameNormalized: string;
		passwordHash: string;
	}): Promise<UserRecord | null> {
		if (this.activeUser) return null;
		this.activeUser = {
			id: bootstrapUserId,
			...input,
			role: "admin",
			activatedAt: new Date()
		};
		return this.activeUser;
	}

	async findByNormalizedUsername(
		usernameNormalized: string
	): Promise<UserRecord | null> {
		return this.activeUser?.usernameNormalized === usernameNormalized
			? this.activeUser
			: null;
	}

	async listActive(): Promise<UserRecord[]> {
		return this.activeUser ? [this.activeUser] : [];
	}

	async create(input: {
		id: string;
		username: string;
		usernameNormalized: string;
		passwordHash: string;
	}): Promise<UserRecord> {
		return {
			...input,
			role: "user",
			activatedAt: new Date()
		};
	}

	user(id: string): UserRecord | null {
		return this.activeUser?.id === id ? this.activeUser : null;
	}
}

interface MemorySession {
	id: string;
	userId: string;
	tokenHash: string;
	expiresAt: Date;
}

/** Mirrors session rotation and revocation closely enough to exercise real bearer middleware. */
class MemorySessions {
	private readonly sessions = new Map<string, MemorySession>();

	constructor(private readonly users: MemoryUsers) {}

	async create(
		input: MemorySession,
		maxActive = MAX_ACTIVE_SESSIONS_PER_USER
	): Promise<void> {
		const active = [...this.sessions.values()]
			.filter((session) => session.userId === input.userId)
			.sort(
				(left, right) => left.expiresAt.getTime() - right.expiresAt.getTime()
			);
		for (const session of active.slice(
			0,
			Math.max(0, active.length - maxActive + 1)
		)) {
			this.sessions.delete(session.tokenHash);
		}
		this.sessions.set(input.tokenHash, input);
	}

	async findActiveByTokenHash(
		tokenHash: string
	): Promise<AuthenticatedSessionRecord | null> {
		const session = this.sessions.get(tokenHash);
		const user = session ? this.users.user(session.userId) : null;
		if (!session || !user || session.expiresAt <= new Date()) return null;
		return {
			id: session.id,
			userId: user.id,
			username: user.username,
			role: user.role,
			expiresAt: session.expiresAt
		};
	}

	async deleteById(id: string): Promise<void> {
		for (const [tokenHash, session] of this.sessions) {
			if (session.id === id) this.sessions.delete(tokenHash);
		}
	}

	session(id: string): MemorySession | null {
		return (
			[...this.sessions.values()].find((session) => session.id === id) ?? null
		);
	}
}

/** Persists complete preference groups per user so PATCH followed by GET crosses JSON twice. */
class MemoryPreferences {
	private readonly rows = new Map<
		string,
		Map<string, Record<string, unknown>>
	>();

	async listForUser(
		userId: string
	): Promise<Record<string, Record<string, unknown>>> {
		return Object.fromEntries(this.rows.get(userId) ?? []);
	}

	async upsertManyForUser(
		userId: string,
		updates: Record<string, Record<string, unknown>>
	): Promise<void> {
		const rows = this.rows.get(userId) ?? new Map();
		for (const [key, value] of Object.entries(updates)) rows.set(key, value);
		this.rows.set(userId, rows);
	}
}

interface StoredMediaTicket {
	tokenHash: string;
	sessionId: string;
	userId: string;
	resourceKind: MediaResourceKind;
	resourceId: string;
	claims: Record<string, unknown>;
	expiresAt: Date;
}

/** The response boundary needs issuance, while lookup remains available for future playback checks. */
class MemoryMediaTickets {
	private readonly tickets = new Map<string, StoredMediaTicket>();

	constructor(
		private readonly users: MemoryUsers,
		private readonly sessions: MemorySessions
	) {}

	async createBounded(input: StoredMediaTicket): Promise<void> {
		this.tickets.set(input.tokenHash, input);
	}

	async findActive(input: {
		tokenHash: string;
		resourceKind: MediaResourceKind;
		resourceId: string;
		now?: Date;
	}): Promise<ActiveMediaTicket | null> {
		const ticket = this.tickets.get(input.tokenHash);
		const session = ticket ? this.sessions.session(ticket.sessionId) : null;
		const user = ticket ? this.users.user(ticket.userId) : null;
		if (
			!ticket ||
			!session ||
			!user ||
			session.userId !== ticket.userId ||
			session.expiresAt <= (input.now ?? new Date()) ||
			ticket.resourceKind !== input.resourceKind ||
			ticket.resourceId !== input.resourceId ||
			ticket.expiresAt <= (input.now ?? new Date())
		) {
			return null;
		}
		return {
			sessionId: ticket.sessionId,
			userId: ticket.userId,
			username: user.username,
			role: user.role,
			expiresAt: ticket.expiresAt,
			claims: ticket.claims
		};
	}
}

/** Builds only the production routers owned by the cross-runtime account contract. */
function buildContractApp() {
	const users = new MemoryUsers();
	const sessions = new MemorySessions(users);
	const auth = new AuthService({
		users,
		sessions
	});
	const tickets = new MediaTicketService(
		new MemoryMediaTickets(users, sessions)
	);
	const authentication = createAuthenticationMiddleware(auth, tickets);
	const preferences = new UserPreferencesService({
		repository: new MemoryPreferences()
	});
	let systemStatusRequests = 0;
	const systemStatus = {
		// Two lifecycle reads prove the generated optionality cannot collapse either boolean value.
		getStatus: async () => ({
			hasTuners: false,
			hasEpg: false,
			hasStorage: false,
			firstRun: systemStatusRequests++ === 0
		})
	};
	const app = express();

	app.disable("x-powered-by");
	app.set("trust proxy", "loopback");
	app.use(requestId());
	app.use(json({ limit: "1mb" }));
	app.use(urlencoded({ extended: false, limit: "1mb" }));
	app.use(
		"/api/v1",
		createAuthRouter({
			auth,
			authentication,
			systemStatus
		})
	);
	app.use(
		"/api/v1",
		authentication.optional,
		authentication.required,
		authentication.cookieOrigin
	);
	app.use("/api/v1", createPreferencesRouter(preferences));
	app.use(
		"/api/v1",
		createMediaTicketsRouter({
			tickets,
			assertLiveStreamable: async () => undefined,
			recordings: {
				assertOwned: async (recordingId: string) => {
					throw new RecordingNotFoundError(recordingId);
				}
			}
		})
	);
	app.use(notFoundHandler);
	app.use(errorHandler());
	return app;
}

/** Binds an ephemeral loopback socket and publishes its URL only after it is ready. */
async function main(): Promise<void> {
	const readyFile = process.env["SIGNALHAVEN_CONTRACT_READY_FILE"];
	if (!readyFile) {
		throw new Error("SIGNALHAVEN_CONTRACT_READY_FILE is required");
	}
	const app = buildContractApp();
	const server = await new Promise<import("node:http").Server>(
		(resolve, reject) => {
			const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
			candidate.once("error", reject);
		}
	);
	const address = server.address() as AddressInfo | null;
	if (!address) {
		server.close();
		throw new Error("Contract server did not publish a bound address");
	}
	const serverURL = `http://127.0.0.1:${address.port}`;
	await writeFile(readyFile, serverURL, { encoding: "utf8", mode: 0o600 });
	console.log(`SignalHaven contract server ready at ${serverURL}`);

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close((error) => {
			if (error) console.error("Contract server shutdown failed", error);
			process.exit(error ? 1 : 0);
		});
		server.closeAllConnections();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	console.error("Failed to start SignalHaven contract server", error);
	process.exitCode = 1;
});
