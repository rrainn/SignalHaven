import path from "node:path";

export type DatabaseConfig = {
	connectionString: string;
	max: number;
	statementTimeoutMs: number;
	idleInTransactionSessionTimeoutMs: number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

function getBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}

	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function buildConnectionStringFromDiscreteEnv(
	env: NodeJS.ProcessEnv
): string | undefined {
	const host = env.PGHOST;
	const user = env.PGUSER;
	const database = env.PGDATABASE;

	if (!host || !user || !database) {
		return undefined;
	}

	const password = env.PGPASSWORD ?? "";
	const port = parsePositiveInt(env.PGPORT, 5432);

	return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function resolveDatabaseConfig(
	env: NodeJS.ProcessEnv = process.env
): DatabaseConfig {
	const connectionString =
		env.SIGNALHAVEN_DATABASE_URL ??
		buildConnectionStringFromDiscreteEnv(env) ??
		"postgres://signalhaven:signalhaven@localhost:5432/signalhaven";

	return {
		connectionString,
		max: parsePositiveInt(env.SIGNALHAVEN_DATABASE_POOL_MAX, 10),
		statementTimeoutMs: parsePositiveInt(
			env.SIGNALHAVEN_DB_STATEMENT_TIMEOUT_MS,
			30_000
		),
		idleInTransactionSessionTimeoutMs: parsePositiveInt(
			env.SIGNALHAVEN_DB_IDLE_IN_TX_TIMEOUT_MS,
			30_000
		)
	};
}

export function shouldAutoMigrate(
	env: NodeJS.ProcessEnv = process.env
): boolean {
	return getBoolean(env.SIGNALHAVEN_DB_AUTO_MIGRATE, true);
}

export function resolveMigrationsFolder(cwd = process.cwd()): string {
	const workspacePath = path.resolve(cwd, "migrations");
	if (workspacePath.includes("apps/backend")) {
		return workspacePath;
	}

	return path.resolve(cwd, "apps/backend/migrations");
}
