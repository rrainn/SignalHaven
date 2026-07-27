import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { resolveMigrationsFolder } from "./config";

export async function runMigrations(
	pool: Pool,
	migrationsFolder = resolveMigrationsFolder()
): Promise<void> {
	const migrationDb = drizzle(pool);

	await migrate(migrationDb, {
		migrationsFolder
	});
}
