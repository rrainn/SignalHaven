import { closeDatabasePool, createDatabasePool } from "../client";
import { runMigrations } from "../migrate";

async function main(): Promise<void> {
	const migrationPool = createDatabasePool();

	try {
		await runMigrations(migrationPool);
	} finally {
		await closeDatabasePool(migrationPool);
	}
}

main().catch((error) => {
	console.error("Failed to run database migrations", error);
	process.exitCode = 1;
});
