import { and, asc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { epgSources } from "../db/schema";

export type EpgSourceKind = "xmltv" | "hdhomerun_guide";

export type CreateEpgSourceInput = {
	kind: EpgSourceKind;
	name: string;
	url?: string | null;
	filePath?: string | null;
	tunerId?: string | null;
	refreshIntervalMinutes?: number;
	timezone?: string | null;
	enabled?: boolean;
};

export type UpdateEpgSourceInput = Partial<{
	name: string;
	url: string | null;
	filePath: string | null;
	tunerId: string | null;
	refreshIntervalMinutes: number;
	timezone: string | null;
	enabled: boolean;
}>;

export type EpgSourceRecord = typeof epgSources.$inferSelect;

/**
 * Persistence for EPG source configurations. XMLTV sources point to a remote
 * URL or local file, while managed HDHomeRun sources reference the tuner that
 * owns their short-lived guide credentials.
 */
export class EpgSourcesRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateEpgSourceInput): Promise<EpgSourceRecord> {
		if (!input.url && !input.filePath && !input.tunerId) {
			throw new Error("EPG source requires a URL, file path, or tuner");
		}
		const now = new Date();
		const [created] = await this.database
			.insert(epgSources)
			.values({
				id: randomUUID(),
				kind: input.kind,
				name: input.name,
				url: input.url ?? null,
				filePath: input.filePath ?? null,
				tunerId: input.tunerId ?? null,
				refreshIntervalMinutes: input.refreshIntervalMinutes ?? 720,
				timezone: input.timezone ?? null,
				enabled: input.enabled ?? true,
				createdAt: now,
				updatedAt: now
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create EPG source record");
		}

		return created;
	}

	async getById(id: string): Promise<EpgSourceRecord | null> {
		const [row] = await this.database
			.select()
			.from(epgSources)
			.where(eq(epgSources.id, id))
			.limit(1);
		return row ?? null;
	}

	async list(): Promise<EpgSourceRecord[]> {
		return this.database
			.select()
			.from(epgSources)
			.orderBy(asc(epgSources.createdAt));
	}

	async listEnabled(): Promise<EpgSourceRecord[]> {
		return this.database
			.select()
			.from(epgSources)
			.where(eq(epgSources.enabled, true))
			.orderBy(asc(epgSources.createdAt));
	}

	/** Returns the managed guide source linked to a tuner, if one exists. */
	async getByTunerId(tunerId: string): Promise<EpgSourceRecord | null> {
		const [row] = await this.database
			.select()
			.from(epgSources)
			.where(eq(epgSources.tunerId, tunerId))
			.limit(1);
		return row ?? null;
	}

	/**
	 * Creates one managed guide source per tuner. The unique tuner constraint
	 * makes concurrent provisioning idempotent across overlapping requests.
	 */
	async ensureHdhomerunForTuner(input: {
		tunerId: string;
		name: string;
	}): Promise<EpgSourceRecord> {
		const now = new Date();
		const [created] = await this.database
			.insert(epgSources)
			.values({
				id: randomUUID(),
				kind: "hdhomerun_guide",
				name: input.name,
				url: null,
				filePath: null,
				tunerId: input.tunerId,
				refreshIntervalMinutes: 720,
				timezone: null,
				enabled: true,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoNothing()
			.returning();
		if (created) {
			return created;
		}
		const existing = await this.getByTunerId(input.tunerId);
		if (!existing) {
			throw new Error("Failed to provision HDHomeRun guide source");
		}
		return existing;
	}

	/** Creates or updates the XMLTV source configured directly on an IPTV tuner. */
	async ensureXmltvForTuner(input: {
		tunerId: string;
		name: string;
		url: string;
	}): Promise<EpgSourceRecord> {
		const existing = await this.getByTunerId(input.tunerId);
		if (existing) {
			if (existing.kind !== "xmltv") {
				throw new Error("Tuner already owns a non-XMLTV EPG source");
			}
			const updated = await this.update(existing.id, {
				name: input.name,
				url: input.url,
				filePath: null
			});
			if (!updated) {
				throw new Error("Failed to update IPTV EPG source");
			}
			return updated;
		}

		const unlinkedMatches = await this.database
			.select()
			.from(epgSources)
			.where(
				and(
					eq(epgSources.kind, "xmltv"),
					eq(epgSources.url, input.url),
					isNull(epgSources.tunerId)
				)
			)
			.limit(2);
		if (unlinkedMatches.length === 1) {
			// Adopt an existing manual source so upgrades keep its imported guide data.
			const adopted = await this.update(unlinkedMatches[0]!.id, {
				name: input.name,
				tunerId: input.tunerId
			});
			if (adopted) return adopted;
		}

		const now = new Date();
		const [created] = await this.database
			.insert(epgSources)
			.values({
				id: randomUUID(),
				kind: "xmltv",
				name: input.name,
				url: input.url,
				filePath: null,
				tunerId: input.tunerId,
				refreshIntervalMinutes: 720,
				timezone: null,
				enabled: true,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoNothing()
			.returning();
		if (created) return created;

		// A concurrent request may have won the unique tuner-source insert.
		const concurrent = await this.getByTunerId(input.tunerId);
		if (!concurrent) {
			throw new Error("Failed to provision IPTV EPG source");
		}
		return concurrent;
	}

	/**
	 * Links a legacy token-bearing source to its sole matching tuner and clears
	 * the persisted credential so subsequent refreshes resolve it dynamically.
	 */
	async adoptHdhomerunSource(
		id: string,
		tunerId: string
	): Promise<EpgSourceRecord | null> {
		const [updated] = await this.database
			.update(epgSources)
			.set({
				tunerId,
				url: null,
				filePath: null,
				updatedAt: new Date()
			})
			.where(eq(epgSources.id, id))
			.returning();
		return updated ?? null;
	}

	async update(
		id: string,
		input: UpdateEpgSourceInput
	): Promise<EpgSourceRecord | null> {
		const set: Record<string, unknown> = { updatedAt: new Date() };
		if (input.name !== undefined) set["name"] = input.name;
		if (input.url !== undefined) set["url"] = input.url;
		if (input.filePath !== undefined) set["filePath"] = input.filePath;
		if (input.tunerId !== undefined) set["tunerId"] = input.tunerId;
		if (input.refreshIntervalMinutes !== undefined) {
			set["refreshIntervalMinutes"] = input.refreshIntervalMinutes;
		}
		if (input.timezone !== undefined) set["timezone"] = input.timezone;
		if (input.enabled !== undefined) set["enabled"] = input.enabled;

		const [updated] = await this.database
			.update(epgSources)
			.set(set)
			.where(eq(epgSources.id, id))
			.returning();

		return updated ?? null;
	}

	async delete(id: string): Promise<boolean> {
		const deleted = await this.database
			.delete(epgSources)
			.where(eq(epgSources.id, id))
			.returning({ id: epgSources.id });
		return deleted.length > 0;
	}

	/**
	 * Records the outcome of a refresh attempt. `status` is a free-form tag
	 * (e.g. "ok", "error") so the UI can render last-refresh diagnostics.
	 */
	async recordRefresh(
		id: string,
		at: Date,
		status: string,
		error: string | null
	): Promise<void> {
		await this.database
			.update(epgSources)
			.set({
				lastRefreshAt: at,
				lastRefreshStatus: status,
				lastRefreshError: error,
				updatedAt: new Date()
			})
			.where(eq(epgSources.id, id));
	}
}
