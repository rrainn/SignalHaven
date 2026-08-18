import { eq } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";
import { userPreferences } from "../db/schema";

export type UserPreferenceValue = Record<string, unknown>;

export class UserPreferencesRepository {
	constructor(private readonly database: DatabaseClient) {}

	async listForUser(
		userId: string
	): Promise<Record<string, UserPreferenceValue>> {
		const rows = await this.database
			.select()
			.from(userPreferences)
			.where(eq(userPreferences.userId, userId));
		return Object.fromEntries(
			rows.map((row) => [row.key, row.value as UserPreferenceValue])
		);
	}

	/** A transaction keeps a multi-group PATCH from becoming partially visible. */
	async upsertManyForUser(
		userId: string,
		updates: Record<string, UserPreferenceValue>
	): Promise<void> {
		const entries = Object.entries(updates);
		if (entries.length === 0) return;
		await this.database.transaction(async (tx) => {
			for (const [key, value] of entries) {
				await tx
					.insert(userPreferences)
					.values({ userId, key, value })
					.onConflictDoUpdate({
						target: [userPreferences.userId, userPreferences.key],
						set: { value }
					});
			}
		});
	}
}
