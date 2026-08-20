import { userPreferencesDefaults, type AuthStatus } from "@signalhaven/shared";
import { describe, expect, it, vi } from "vitest";

import { loadServerAuthBootstrap } from "../../app/_auth/server-auth-bootstrap";

const admin = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

/** Creates a request whose completion remains under test control. */
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

/** Builds a JSON response that matches the production transport. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}

describe("server account bootstrap", () => {
	it("starts auth and preferences together with private cookie forwarding", async () => {
		const statusResponse = deferred<Response>();
		const preferencesResponse = deferred<Response>();
		const fetchImpl = vi.fn(
			(input: string | URL | Request, _init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				return path.endsWith("/auth/status")
					? statusResponse.promise
					: preferencesResponse.promise;
			}
		);

		const bootstrapPromise = loadServerAuthBootstrap({
			backendOrigin: "http://backend.internal:3000",
			cookie: "signalhaven_session=private-token",
			fetchImpl
		});

		// Both reads must begin before either response resolves.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		for (const [, init] of fetchImpl.mock.calls) {
			expect(init?.cache).toBe("no-store");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(new Headers(init?.headers).get("cookie")).toBe(
				"signalhaven_session=private-token"
			);
		}

		preferencesResponse.resolve(jsonResponse(userPreferencesDefaults));
		statusResponse.resolve(
			jsonResponse({
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: admin
			} satisfies AuthStatus)
		);

		await expect(bootstrapPromise).resolves.toEqual({
			status: "signed-in",
			user: admin,
			preferences: {
				status: "ready",
				preferences: userPreferencesDefaults
			}
		});
	});

	it("does not forward a Cookie header when the request has none", async () => {
		const fetchImpl = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/auth/status")) {
					return jsonResponse({
						requiresInitialAdmin: false,
						systemSetupRequired: false,
						user: null
					} satisfies AuthStatus);
				}
				return jsonResponse({ error: { code: "unauthorized" } }, 401);
			}
		);

		await expect(
			loadServerAuthBootstrap({
				backendOrigin: "http://backend.internal:3000",
				cookie: null,
				fetchImpl
			})
		).resolves.toEqual({ status: "signed-out" });
		for (const [, init] of fetchImpl.mock.calls) {
			expect(new Headers(init?.headers).has("cookie")).toBe(false);
		}
	});

	it("fails closed when preferences reject a status-confirmed session", async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/auth/status")) {
				return jsonResponse({
					requiresInitialAdmin: false,
					systemSetupRequired: false,
					user: admin
				} satisfies AuthStatus);
			}
			return jsonResponse({ error: { code: "unauthorized" } }, 401);
		});

		await expect(
			loadServerAuthBootstrap({
				backendOrigin: "http://backend.internal:3000",
				cookie: "signalhaven_session=expired",
				fetchImpl
			})
		).resolves.toEqual({ status: "signed-out" });
	});

	it("retains a recoverable preference error without exposing backend details", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/auth/status")) {
				return jsonResponse({
					requiresInitialAdmin: false,
					systemSetupRequired: false,
					user: admin
				} satisfies AuthStatus);
			}
			return jsonResponse(
				{ error: { message: "private backend diagnostic" } },
				500
			);
		});

		try {
			await expect(
				loadServerAuthBootstrap({
					backendOrigin: "http://backend.internal:3000",
					cookie: "signalhaven_session=valid",
					fetchImpl
				})
			).resolves.toEqual({
				status: "signed-in",
				user: admin,
				preferences: {
					status: "error",
					message: "Saved preferences could not be loaded"
				}
			});
			expect(consoleError).toHaveBeenCalledWith(
				"[auth-bootstrap] preferences request failed",
				{ status: 500 }
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("keeps account setup routable when speculative preferences are unauthorized", async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/auth/status")) {
				return jsonResponse({
					requiresInitialAdmin: true,
					systemSetupRequired: true,
					user: null
				} satisfies AuthStatus);
			}
			return jsonResponse({ error: { code: "unauthorized" } }, 401);
		});

		await expect(
			loadServerAuthBootstrap({
				backendOrigin: "http://backend.internal:3000",
				cookie: null,
				fetchImpl
			})
		).resolves.toEqual({
			status: "account-required",
			systemSetupRequired: true
		});
	});

	it("returns a generic unavailable state for an invalid auth response", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			return path.endsWith("/auth/status")
				? jsonResponse({ private: "unexpected payload" })
				: jsonResponse({ error: { code: "unauthorized" } }, 401);
		});

		try {
			await expect(
				loadServerAuthBootstrap({
					backendOrigin: "http://backend.internal:3000",
					cookie: null,
					fetchImpl
				})
			).resolves.toEqual({
				status: "unavailable",
				message: "SignalHaven could not be reached"
			});
		} finally {
			consoleError.mockRestore();
		}
	});
});
