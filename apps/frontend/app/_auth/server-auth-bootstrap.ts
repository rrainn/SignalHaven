import {
	authStatusSchema,
	userPreferencesSchema,
	type UserPreferences
} from "@signalhaven/shared";
import type { ZodType } from "zod";

import type { AuthBootstrap } from "./auth-bootstrap";

type ServerFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

type ServerAuthBootstrapOptions = {
	/** The private cookie header from this exact incoming browser request. */
	cookie: string | null;
	/** Uses the same trusted backend origin as the Next.js API proxy. */
	backendOrigin?: string;
	/** Injection point keeps transport behavior executable without a real server. */
	fetchImpl?: ServerFetch;
};

type SettledPreferences =
	| { status: "ready"; preferences: UserPreferences }
	| { status: "error"; failure: unknown };

const SERVER_BOOTSTRAP_TIMEOUT_MS = 5_000;

/** Distinguishes an expected authorization response from transport failures. */
class ServerBootstrapRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Server bootstrap request failed with HTTP ${status}`);
		this.name = "ServerBootstrapRequestError";
		this.status = status;
	}
}

/**
 * Resolves the account boundary on the server so authenticated pages can be
 * present in the first HTML response without caching data between requests.
 */
export async function loadServerAuthBootstrap({
	cookie,
	backendOrigin = process.env.SIGNALHAVEN_BACKEND_ORIGIN ??
		"http://localhost:3001",
	fetchImpl = fetch
}: ServerAuthBootstrapOptions): Promise<AuthBootstrap> {
	// These reads are independent; starting both removes a network waterfall.
	const statusRequest = requestBackend(
		"/api/v1/auth/status",
		authStatusSchema,
		{ backendOrigin, cookie, fetchImpl }
	);
	const preferencesRequest: Promise<SettledPreferences> = requestBackend(
		"/api/v1/preferences",
		userPreferencesSchema,
		{ backendOrigin, cookie, fetchImpl }
	).then(
		(preferences) => ({ status: "ready", preferences }),
		(failure: unknown) => ({ status: "error", failure })
	);

	try {
		const status = await statusRequest;
		if (status.requiresInitialAdmin) {
			return {
				status: "account-required",
				systemSetupRequired: status.systemSetupRequired
			};
		}
		if (!status.user) return { status: "signed-out" };

		const preferences = await preferencesRequest;
		if (preferences.status === "ready") {
			return {
				status: "signed-in",
				user: status.user,
				preferences
			};
		}
		if (
			preferences.failure instanceof ServerBootstrapRequestError &&
			preferences.failure.status === 401
		) {
			// Status confirmed a user, so a protected-read 401 means the session died.
			return { status: "signed-out" };
		}

		logBootstrapFailure("preferences", preferences.failure);
		return {
			status: "signed-in",
			user: status.user,
			preferences: {
				status: "error",
				message: "Saved preferences could not be loaded"
			}
		};
	} catch (failure) {
		logBootstrapFailure("authentication", failure);
		return {
			status: "unavailable",
			message: "SignalHaven could not be reached"
		};
	}
}

type BackendRequestOptions = {
	backendOrigin: string;
	cookie: string | null;
	fetchImpl: ServerFetch;
};

/** Performs one uncached, schema-validated read against the trusted backend. */
async function requestBackend<T>(
	path: string,
	schema: ZodType<T>,
	options: BackendRequestOptions
): Promise<T> {
	const headers = new Headers({ Accept: "application/json" });
	if (options.cookie) headers.set("Cookie", options.cookie);
	const origin = options.backendOrigin.replace(/\/$/, "");
	const response = await options.fetchImpl(`${origin}${path}`, {
		cache: "no-store",
		headers,
		// An unreachable internal backend must resolve to the retry surface promptly.
		signal: AbortSignal.timeout(SERVER_BOOTSTRAP_TIMEOUT_MS)
	});
	if (!response.ok) throw new ServerBootstrapRequestError(response.status);
	const parsed = schema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error(`Server bootstrap response failed validation for ${path}`);
	}
	return parsed.data;
}

/** Keeps server logs useful without sending backend diagnostics to the browser. */
function logBootstrapFailure(scope: string, failure: unknown): void {
	if (failure instanceof ServerBootstrapRequestError) {
		console.error(`[auth-bootstrap] ${scope} request failed`, {
			status: failure.status
		});
		return;
	}
	console.error(`[auth-bootstrap] ${scope} request failed`, failure);
}
