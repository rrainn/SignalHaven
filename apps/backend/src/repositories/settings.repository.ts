import { eq } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";
import { settings } from "../db/schema";

export type SettingValue = Record<string, unknown>;

export class SettingsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async upsert(key: string, value: SettingValue) {
		const [stored] = await this.database
			.insert(settings)
			.values({ key, value })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value }
			})
			.returning();

		if (!stored) {
			throw new Error("Failed to upsert setting record");
		}

		return stored;
	}

	async getByKey(key: string) {
		const [record] = await this.database
			.select()
			.from(settings)
			.where(eq(settings.key, key))
			.limit(1);

		return record ?? null;
	}

	/** Returns every persisted setting row keyed by its `key`. */
	async listAll(): Promise<Record<string, SettingValue>> {
		const rows = await this.database.select().from(settings);
		const out: Record<string, SettingValue> = {};
		for (const row of rows) {
			out[row.key] = row.value as SettingValue;
		}
		return out;
	}

	/**
	 * Atomically upserts multiple settings rows in a single transaction so a
	 * partially failing PATCH cannot leave the table in a half-applied state.
	 */
	async upsertMany(updates: Record<string, SettingValue>): Promise<void> {
		const entries = Object.entries(updates);
		if (entries.length === 0) {
			return;
		}
		await this.database.transaction(async (tx) => {
			for (const [key, value] of entries) {
				await tx.insert(settings).values({ key, value }).onConflictDoUpdate({
					target: settings.key,
					set: { value }
				});
			}
		});
	}
}
