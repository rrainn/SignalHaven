import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";

import type { UserRole } from "@signalhaven/shared";

import type { DatabaseClient } from "../db/client";
import { BOOTSTRAP_ADMIN_USER_ID, users } from "../db/schema";

export interface UserRecord {
	id: string;
	username: string;
	usernameNormalized: string;
	passwordHash: string;
	role: UserRole;
	activatedAt: Date;
}

/** Keep nullable bootstrap fields inside the repository trust boundary. */
function toActiveUser(row: typeof users.$inferSelect): UserRecord | null {
	if (
		!row.username ||
		!row.usernameNormalized ||
		!row.passwordHash ||
		!row.activatedAt ||
		(row.role !== "admin" && row.role !== "user")
	) {
		return null;
	}
	return {
		id: row.id,
		username: row.username,
		usernameNormalized: row.usernameNormalized,
		passwordHash: row.passwordHash,
		role: row.role,
		activatedAt: row.activatedAt
	};
}

export class UsersRepository {
	constructor(private readonly database: DatabaseClient) {}

	async requiresInitialAdmin(): Promise<boolean> {
		const [pending] = await this.database
			.select({ id: users.id })
			.from(users)
			.where(
				and(eq(users.id, BOOTSTRAP_ADMIN_USER_ID), isNull(users.activatedAt))
			)
			.limit(1);
		return pending !== undefined;
	}

	async activateInitialAdmin(input: {
		username: string;
		usernameNormalized: string;
		passwordHash: string;
	}): Promise<UserRecord | null> {
		const now = new Date();
		const [row] = await this.database
			.update(users)
			.set({ ...input, activatedAt: now, updatedAt: now })
			.where(
				and(eq(users.id, BOOTSTRAP_ADMIN_USER_ID), isNull(users.activatedAt))
			)
			.returning();
		return row ? toActiveUser(row) : null;
	}

	async findByNormalizedUsername(
		usernameNormalized: string
	): Promise<UserRecord | null> {
		const [row] = await this.database
			.select()
			.from(users)
			.where(
				and(
					eq(users.usernameNormalized, usernameNormalized),
					isNotNull(users.activatedAt)
				)
			)
			.limit(1);
		return row ? toActiveUser(row) : null;
	}

	async getById(id: string): Promise<UserRecord | null> {
		const [row] = await this.database
			.select()
			.from(users)
			.where(and(eq(users.id, id), isNotNull(users.activatedAt)))
			.limit(1);
		return row ? toActiveUser(row) : null;
	}

	async listActive(): Promise<UserRecord[]> {
		const rows = await this.database
			.select()
			.from(users)
			.where(isNotNull(users.activatedAt))
			.orderBy(asc(users.usernameNormalized));
		return rows.flatMap((row) => {
			const active = toActiveUser(row);
			return active ? [active] : [];
		});
	}

	async create(input: {
		id: string;
		username: string;
		usernameNormalized: string;
		passwordHash: string;
	}): Promise<UserRecord> {
		const now = new Date();
		const [row] = await this.database
			.insert(users)
			.values({
				...input,
				role: "user",
				activatedAt: now,
				updatedAt: now
			})
			.returning();
		const active = row ? toActiveUser(row) : null;
		if (!active) throw new Error("Failed to create user");
		return active;
	}

	/** Test cleanup can preserve the migration-owned bootstrap identity. */
	async deleteCreatedUsers(): Promise<void> {
		await this.database
			.delete(users)
			.where(ne(users.id, BOOTSTRAP_ADMIN_USER_ID));
	}
}
