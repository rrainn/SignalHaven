import { and, count, eq, gt, sql } from "drizzle-orm";

import type { UserRole } from "@signalhaven/shared";

import type { DatabaseClient } from "../db/client";
import { mediaTickets, sessions, users } from "../db/schema";

export type MediaResourceKind = "live" | "recording";

export interface ActiveMediaTicket {
	sessionId: string;
	userId: string;
	username: string;
	role: UserRole;
	expiresAt: Date;
	claims: Record<string, unknown>;
}

export class MediaTicketsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async createBounded(
		input: {
			tokenHash: string;
			sessionId: string;
			userId: string;
			resourceKind: MediaResourceKind;
			resourceId: string;
			claims: Record<string, unknown>;
			expiresAt: Date;
		},
		limits: { perSession: number; perUser: number }
	): Promise<void> {
		return this.database.transaction(async (tx) => {
			// A cross-process user lock makes count + insert one atomic decision.
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
			);
			await tx
				.delete(mediaTickets)
				.where(
					and(
						eq(mediaTickets.userId, input.userId),
						sql`${mediaTickets.expiresAt} <= now()`
					)
				);
			const [usage] = await tx
				.select({
					userCount: count(),
					sessionCount: sql<number>`count(*) FILTER (WHERE ${mediaTickets.sessionId} = ${input.sessionId})`
				})
				.from(mediaTickets)
				.where(
					and(
						eq(mediaTickets.userId, input.userId),
						gt(mediaTickets.expiresAt, new Date())
					)
				);
			const rotateCount = Math.max(
				0,
				Number(usage?.sessionCount ?? 0) - limits.perSession + 1,
				Number(usage?.userCount ?? 0) - limits.perUser + 1
			);
			if (rotateCount > 0) {
				await tx.execute(sql`
					DELETE FROM ${mediaTickets}
					WHERE ${mediaTickets.tokenHash} IN (
						SELECT ${mediaTickets.tokenHash}
						FROM ${mediaTickets}
						WHERE ${mediaTickets.userId} = ${input.userId}
						  AND ${mediaTickets.expiresAt} > now()
						ORDER BY
							CASE WHEN ${mediaTickets.sessionId} = ${input.sessionId} THEN 0 ELSE 1 END,
							${mediaTickets.createdAt},
							${mediaTickets.tokenHash}
						LIMIT ${rotateCount}
					)
				`);
			}
			await tx.insert(mediaTickets).values(input);
		});
	}

	/** Bound opportunistic cleanup complements session-cascade revocation. */
	async deleteExpired(now = new Date(), limit = 100): Promise<void> {
		await this.database.execute(sql`
			DELETE FROM ${mediaTickets}
			WHERE ${mediaTickets.tokenHash} IN (
				SELECT ${mediaTickets.tokenHash}
				FROM ${mediaTickets}
				WHERE ${mediaTickets.expiresAt} <= ${now}
				ORDER BY ${mediaTickets.expiresAt}
				LIMIT ${limit}
			)
		`);
	}

	/** Both ticket and parent session must remain live for every HLS request. */
	async findActive(input: {
		tokenHash: string;
		resourceKind: MediaResourceKind;
		resourceId: string;
		now?: Date;
	}): Promise<ActiveMediaTicket | null> {
		const now = input.now ?? new Date();
		const [row] = await this.database
			.select({
				sessionId: sessions.id,
				userId: users.id,
				username: users.username,
				role: users.role,
				expiresAt: mediaTickets.expiresAt,
				claims: mediaTickets.claims
			})
			.from(mediaTickets)
			.innerJoin(sessions, eq(mediaTickets.sessionId, sessions.id))
			.innerJoin(users, eq(mediaTickets.userId, users.id))
			.where(
				and(
					eq(mediaTickets.tokenHash, input.tokenHash),
					eq(mediaTickets.resourceKind, input.resourceKind),
					eq(mediaTickets.resourceId, input.resourceId),
					eq(mediaTickets.userId, sessions.userId),
					gt(mediaTickets.expiresAt, now),
					gt(sessions.expiresAt, now)
				)
			)
			.limit(1);
		if (
			!row ||
			!row.username ||
			(row.role !== "admin" && row.role !== "user")
		) {
			return null;
		}
		return {
			...row,
			username: row.username,
			role: row.role,
			claims: row.claims as Record<string, unknown>
		};
	}
}
