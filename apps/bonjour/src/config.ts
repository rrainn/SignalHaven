import { isUuid } from "./uuid";

const DEFAULT_PORT = 3000;
const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const MAX_DNS_LABEL_BYTES = 63;

/** Runtime settings for publishing the host-visible SignalHaven endpoint. */
export interface BonjourConfig {
	port: number;
	healthUrl: URL;
	healthIntervalMs: number;
	healthTimeoutMs: number;
	serviceName: string;
	stateDirectory: string;
	serverId?: string;
	restrictedAddresses?: string[];
	disabledIpv6: boolean;
}

/** Parses a bounded integer so invalid deployment values fail before mDNS starts. */
function parseInteger(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") {
		return fallback;
	}

	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}`
		);
	}

	return value;
}

/** Parses common boolean spellings while rejecting ambiguous configuration. */
function parseBoolean(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: boolean
): boolean {
	const raw = env[name]?.trim().toLowerCase();
	if (raw === undefined || raw === "") {
		return fallback;
	}
	if (["1", "true", "yes", "on"].includes(raw)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(raw)) {
		return false;
	}

	throw new Error(`${name} must be true or false`);
}

/** Loads and validates all configuration consumed by the Bonjour sidecar. */
export function loadConfig(env: NodeJS.ProcessEnv): BonjourConfig {
	const port = parseInteger(
		env,
		"SIGNALHAVEN_HTTP_PORT",
		DEFAULT_PORT,
		1,
		65_535
	);
	const serviceName = env.SIGNALHAVEN_SERVICE_NAME?.trim() || "SignalHaven";
	if (Buffer.byteLength(serviceName, "utf8") > MAX_DNS_LABEL_BYTES) {
		throw new Error("SIGNALHAVEN_SERVICE_NAME must be at most 63 UTF-8 bytes");
	}

	const healthUrl = new URL(
		env.SIGNALHAVEN_HEALTH_URL || `http://127.0.0.1:${port}/api/v1/health`
	);
	if (!["http:", "https:"].includes(healthUrl.protocol)) {
		throw new Error("SIGNALHAVEN_HEALTH_URL must use http or https");
	}

	const serverId = env.SIGNALHAVEN_SERVER_ID?.trim();
	if (serverId && !isUuid(serverId)) {
		throw new Error("SIGNALHAVEN_SERVER_ID must be a UUID");
	}

	const restrictedAddresses = env.SIGNALHAVEN_BONJOUR_INTERFACES?.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

	return {
		port,
		healthUrl,
		healthIntervalMs: parseInteger(
			env,
			"SIGNALHAVEN_HEALTH_INTERVAL_MS",
			DEFAULT_HEALTH_INTERVAL_MS,
			250,
			3_600_000
		),
		healthTimeoutMs: parseInteger(
			env,
			"SIGNALHAVEN_HEALTH_TIMEOUT_MS",
			DEFAULT_HEALTH_TIMEOUT_MS,
			100,
			60_000
		),
		serviceName,
		stateDirectory:
			env.SIGNALHAVEN_BONJOUR_STATE_DIR?.trim() ||
			"/var/lib/signalhaven-bonjour",
		...(serverId ? { serverId } : {}),
		...(restrictedAddresses?.length ? { restrictedAddresses } : {}),
		disabledIpv6: parseBoolean(env, "SIGNALHAVEN_BONJOUR_DISABLE_IPV6", false)
	};
}
