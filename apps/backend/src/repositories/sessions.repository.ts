import { and, eq, gt, sql } from "drizzle-orm";

import type { UserRole } from "@signalhaven/shared";

import type { DatabaseClient } from "../db/client";
import { sessions, users } from "../db/schema";

export interface AuthenticatedSessionRecord {
	id: string;
	userId: string;
	username: string;
	role: UserRole;
	expiresAt: Date;
}

export class SessionsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: {
		id: string;
		userId: string;
		tokenHash: string;
		expiresAt: Date;
	}, maxActive = 16): Promise<void> {
		await this.database.transaction(async (tx) => {
			// Serialize account-wide rotation across processes and login transports.
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 1))`
			);
			await tx.delete(sessions).where(
				and(
					eq(sessions.userId, input.userId),
					sql`${sessions.expiresAt} <= now()`
				)
			);
			await tx.execute(sql`
				DELETE FROM ${sessions}
				WHERE ${sessions.id} IN (
					SELECT ${sessions.id}
					FROM ${sessions}
					WHERE ${sessions.userId} = ${input.userId}
					  AND ${sessions.expiresAt} > now()
					ORDER BY ${sessions.createdAt} DESC, ${sessions.id} DESC
					OFFSET ${Math.max(0, maxActive - 1)}
				)
			`);
			await tx.insert(sessions).values(input);
		});
	}

	/** Bound opportunistic cleanup so long-running installs do not retain dead secrets. */
	async deleteExpired(now = new Date(), limit = 100): Promise<void> {
		await this.database.execute(sql`
			DELETE FROM ${sessions}
			WHERE ${sessions.id} IN (
				SELECT ${sessions.id}
				FROM ${sessions}
				WHERE ${sessions.expiresAt} <= ${now}
				ORDER BY ${sessions.expiresAt}
				LIMIT ${limit}
			)
		`);
	}

	async findActiveByTokenHash(
		tokenHash: string,
		now = new Date()
	): Promise<AuthenticatedSessionRecord | null> {
		const [row] = await this.database
			.select({
				id: sessions.id,
				userId: users.id,
				username: users.username,
				role: users.role,
				expiresAt: sessions.expiresAt
			})
			.from(sessions)
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(
				and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now))
			)
			.limit(1);

		if (
			!row ||
			!row.username ||
			(row.role !== "admin" && row.role !== "user")
		) {
			return null;
		}
		return { ...row, username: row.username, role: row.role };
	}

	async deleteById(id: string): Promise<void> {
		await this.database.delete(sessions).where(eq(sessions.id, id));
	}
}
