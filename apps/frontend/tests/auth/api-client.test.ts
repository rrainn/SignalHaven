import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
	ApiError,
	apiRequest,
	getPreferences,
	login,
	prepareRecordingPlayback,
	setupInitialAdmin
} from "../../lib/api-client";
import {
	clearAccountBrowserState,
	setAuthenticatedClientRole
} from "../../lib/account-browser-state";
import { SESSION_EXPIRED_EVENT } from "../../lib/app-events";

const user = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};

afterEach(() => {
	clearAccountBrowserState();
	vi.unstubAllGlobals();
});

describe("browser authentication requests", () => {
	it.each([
		["sign-in", login, "/api/v1/auth/login"],
		["initial administrator", setupInitialAdmin, "/api/v1/auth/setup"]
	] as const)("uses cookie transport for %s", async (_label, request, path) => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						user,
						token: null,
						expiresAt: "2099-01-01T00:00:00.000Z"
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" }
					}
				)
		);
		vi.stubGlobal("fetch", fetchMock);

		await request({ username: "operator", password: "secret123" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(path);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.credentials).toBe("same-origin");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({
			username: "operator",
			password: "secret123",
			transport: "cookie"
		});
	});

	it("expires the session and uses no-store cookies for recording preflight", async () => {
		const expired = vi.fn();
		window.addEventListener(SESSION_EXPIRED_EVENT, expired);
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ error: { message: "Expired" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" }
				})
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(prepareRecordingPlayback(user.id)).rejects.toBeInstanceOf(
			ApiError
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.credentials).toBe("same-origin");
		expect(init.cache).toBe("no-store");
		expect(expired).toHaveBeenCalledTimes(1);
		window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
	});

	it("returns a speculative preference 401 without expiring an unknown session", async () => {
		const expired = vi.fn();
		window.addEventListener(SESSION_EXPIRED_EVENT, expired);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
						status: 401,
						headers: { "Content-Type": "application/json" }
					})
			)
		);

		try {
			await expect(
				getPreferences({ unauthorized: "return-error" })
			).rejects.toBeInstanceOf(ApiError);
			expect(expired).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
		}
	});

	it("does not trust a stale advanced flag without an authenticated admin", async () => {
		localStorage.setItem("signalhaven.advanced-mode.v1", "true");
		setAuthenticatedClientRole("user");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								message: "Database details",
								requestId: "private-request"
							}
						}),
						{ status: 500 }
					)
			)
		);

		await expect(apiRequest("/failure", z.unknown())).rejects.toMatchObject({
			message: expect.not.stringContaining("private-request")
		});
	});
});
