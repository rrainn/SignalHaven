import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { tuners } from "../db/schema";

export type CreateTunerInput = {
	kind: string;
	name: string;
	config: Record<string, unknown>;
};

export type UpdateTunerInput = Partial<{
	name: string;
	kind: string;
	config: Record<string, unknown>;
}>;

export type LineupSyncState =
	| { status: "success"; error?: never }
	| { status: "error"; error: string };

export class TunersRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateTunerInput) {
		const [created] = await this.database
			.insert(tuners)
			.values({
				id: randomUUID(),
				kind: input.kind,
				name: input.name,
				config: input.config,
				updatedAt: new Date()
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create tuner record");
		}

		return created;
	}

	async getById(id: string) {
		const [record] = await this.database
			.select()
			.from(tuners)
			.where(eq(tuners.id, id))
			.limit(1);

		return record ?? null;
	}

	async list() {
		return this.database.select().from(tuners).orderBy(asc(tuners.createdAt));
	}

	/** Persist the latest lineup-sync outcome without changing tuner config. */
	async recordLineupSync(id: string, state: LineupSyncState): Promise<void> {
		await this.database
			.update(tuners)
			.set({
				lastLineupSyncAt: new Date(),
				lastLineupSyncStatus: state.status,
				lastLineupSyncError: state.status === "error" ? state.error : null
			})
			.where(eq(tuners.id, id));
	}

	/**
	 * Partial update. Only the supplied fields are written; `updatedAt` is
	 * always bumped to "now" so observers can detect changes. Returns the
	 * updated row, or `null` if no row matched the id.
	 */
	async update(id: string, input: UpdateTunerInput) {
		const set: Record<string, unknown> = { updatedAt: new Date() };
		if (input.name !== undefined) {
			set["name"] = input.name;
		}
		if (input.kind !== undefined) {
			set["kind"] = input.kind;
		}
		if (input.config !== undefined) {
			set["config"] = input.config;
		}

		const [updated] = await this.database
			.update(tuners)
			.set(set)
			.where(eq(tuners.id, id))
			.returning();

		return updated ?? null;
	}

	/** Returns `true` if a row matched and was deleted. */
	async delete(id: string): Promise<boolean> {
		const deleted = await this.database
			.delete(tuners)
			.where(eq(tuners.id, id))
			.returning({ id: tuners.id });

		return deleted.length > 0;
	}
}
