import type { Pool } from "pg";

import { checkDatabase } from "../db/client";

export class HealthRepository {
	constructor(private readonly pool: Pool) {}

	async isHealthy(): Promise<boolean> {
		try {
			await checkDatabase(this.pool);
			return true;
		} catch {
			return false;
		}
	}
}
