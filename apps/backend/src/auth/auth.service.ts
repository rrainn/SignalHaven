import { randomUUID } from "node:crypto";

import {
	authLoginSchema,
	authSetupSchema,
	userCreateSchema,
	type AuthLogin,
	type AuthSetup,
	type User,
	type UserCreate
} from "@signalhaven/shared";

import { conflict, unauthorized } from "../http/middleware/errors";
import type { SessionsRepository } from "../repositories/sessions.repository";
import type {
	UserRecord,
	UsersRepository
} from "../repositories/users.repository";
import { hashPassword, verifyPassword } from "./password";
import { createOpaqueToken, hashOpaqueToken } from "./session-token";

export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_COOKIE_NAME = "signalhaven_session";
/** Oldest sessions rotate out when an account exceeds this active-device cap. */
export const MAX_ACTIVE_SESSIONS_PER_USER = 16;

/** Equal-cost fallback keeps an unknown username from becoming a timing oracle. */
const dummyPasswordHash = hashPassword("signalhaven dummy password");

export interface AuthPrincipal {
	sessionId: string;
	user: User;
}

export interface IssuedSession {
	principal: AuthPrincipal;
	token: string;
	expiresAt: Date;
}

function toUser(record: UserRecord): User {
	return {
		id: record.id,
		username: record.username,
		role: record.role
	};
}

function normalizeUsername(username: string): string {
	return username.normalize("NFKC").toLocaleLowerCase("en-US");
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "23505"
	);
}

export class AuthService {
	constructor(
		private readonly options: {
			/** Keep authentication portable across the database and bounded contract harness. */
			users: Pick<
				UsersRepository,
				| "requiresInitialAdmin"
				| "activateInitialAdmin"
				| "findByNormalizedUsername"
				| "listActive"
				| "create"
			>;
			sessions: Pick<
				SessionsRepository,
				"create" | "findActiveByTokenHash" | "deleteById"
			>;
		}
	) {}

	requiresInitialAdmin(): Promise<boolean> {
		return this.options.users.requiresInitialAdmin();
	}

	async setup(input: AuthSetup): Promise<IssuedSession> {
		const parsed = authSetupSchema.parse(input);
		const passwordHash = await hashPassword(parsed.password);
		let record: UserRecord | null;
		try {
			record = await this.options.users.activateInitialAdmin({
				username: parsed.username,
				usernameNormalized: normalizeUsername(parsed.username),
				passwordHash
			});
		} catch (error) {
			if (isUniqueViolation(error)) throw conflict("Username already exists");
			throw error;
		}
		if (!record) throw conflict("The initial administrator already exists");
		return this.issueSession(record);
	}

	async login(input: AuthLogin): Promise<IssuedSession> {
		const parsed = authLoginSchema.parse(input);
		const record = await this.options.users.findByNormalizedUsername(
			normalizeUsername(parsed.username)
		);
		const passwordMatches = await verifyPassword(
			parsed.password,
			record?.passwordHash ?? (await dummyPasswordHash)
		);
		if (!record || !passwordMatches) {
			throw unauthorized("Invalid username or password");
		}
		return this.issueSession(record);
	}

	async authenticateToken(token: string): Promise<AuthPrincipal | null> {
		if (token.length < 32 || token.length > 256) return null;
		const session = await this.options.sessions.findActiveByTokenHash(
			hashOpaqueToken(token)
		);
		if (!session) return null;
		return {
			sessionId: session.id,
			user: {
				id: session.userId,
				username: session.username,
				role: session.role
			}
		};
	}

	logout(sessionId: string): Promise<void> {
		return this.options.sessions.deleteById(sessionId);
	}

	async listUsers(): Promise<User[]> {
		return (await this.options.users.listActive()).map(toUser);
	}

	async createUser(input: UserCreate): Promise<User> {
		const parsed = userCreateSchema.parse(input);
		try {
			const created = await this.options.users.create({
				id: randomUUID(),
				username: parsed.username,
				usernameNormalized: normalizeUsername(parsed.username),
				passwordHash: await hashPassword(parsed.password)
			});
			return toUser(created);
		} catch (error) {
			if (isUniqueViolation(error)) throw conflict("Username already exists");
			throw error;
		}
	}

	private async issueSession(record: UserRecord): Promise<IssuedSession> {
		const token = createOpaqueToken();
		const sessionId = randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
		await this.options.sessions.create(
			{
				id: sessionId,
				userId: record.id,
				tokenHash: hashOpaqueToken(token),
				expiresAt
			},
			MAX_ACTIVE_SESSIONS_PER_USER
		);
		return {
			principal: { sessionId, user: toUser(record) },
			token,
			expiresAt
		};
	}
}
