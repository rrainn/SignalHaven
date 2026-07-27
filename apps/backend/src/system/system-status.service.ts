import type { SystemStatus } from "@signalhaven/shared";
import { count } from "drizzle-orm";

import type { DatabaseClient } from "../db/client";
import { epgChannels, tuners } from "../db/schema";

import type { SettingsService } from "../settings/settings.service";

export interface SystemStatusServiceOptions {
	database: DatabaseClient;
	settings: SettingsService;
}

/**
 * Aggregates the high-level "do we need to show onboarding?" signals into
 * the shape consumed by `GET /api/v1/system/status`.
 */
export class SystemStatusService {
	private readonly database: DatabaseClient;
	private readonly settings: SettingsService;

	constructor(options: SystemStatusServiceOptions) {
		this.database = options.database;
		this.settings = options.settings;
	}

	async getStatus(): Promise<SystemStatus> {
		const [tunerRow, epgRow, current] = await Promise.all([
			this.database.select({ value: count() }).from(tuners),
			this.database.select({ value: count() }).from(epgChannels),
			this.settings.getAll()
		]);

		const hasTuners = (tunerRow[0]?.value ?? 0) > 0;
		const hasEpg = (epgRow[0]?.value ?? 0) > 0;
		const hasStorage =
			typeof current.storage.path === "string" &&
			current.storage.path.length > 0;

		return {
			hasTuners,
			hasEpg,
			hasStorage,
			// First-run UX is gated on the user having configured none of the
			// foundational pieces yet.
			firstRun: !hasTuners && !hasEpg && !hasStorage
		};
	}
}
