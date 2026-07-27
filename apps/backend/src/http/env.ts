export type Environment = "development" | "test" | "production";

export function resolveEnvironment(
	env: NodeJS.ProcessEnv = process.env
): Environment {
	const value = env.NODE_ENV;

	if (value === "production" || value === "test") {
		return value;
	}

	return "development";
}

export function isDevelopment(env: Environment): boolean {
	return env === "development";
}

export function isProduction(env: Environment): boolean {
	return env === "production";
}
