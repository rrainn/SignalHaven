import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { resolveDatabaseConfig } from "./config";
import { schema } from "./schema";

export type DatabaseClient = NodePgDatabase<typeof schema>;

export function createDatabasePool(env: NodeJS.ProcessEnv = process.env): Pool {
	const config = resolveDatabaseConfig(env);

	return new Pool({
		connectionString: config.connectionString,
		max: config.max,
		statement_timeout: config.statementTimeoutMs,
		idle_in_transaction_session_timeout:
			config.idleInTransactionSessionTimeoutMs
	});
}

export function createDatabaseClient(pool: Pool): DatabaseClient {
	return drizzle(pool, { schema });
}

export async function checkDatabase(pool: Pool): Promise<void> {
	await pool.query({
		name: "health-check-select-1",
		text: "SELECT 1"
	});
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
	await pool.end();
}

export const pool = createDatabasePool();
export const db = createDatabaseClient(pool);
