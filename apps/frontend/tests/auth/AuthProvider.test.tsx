import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../../app/_auth/AuthProvider";
import { SignInForm } from "../../app/_auth/SignInForm";
import { SESSION_EXPIRED_EVENT } from "../../lib/app-events";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		getAuthStatus: vi.fn(),
		setupInitialAdmin: vi.fn(),
		login: vi.fn(),
		logout: vi.fn()
	};
});

import {
	ApiError,
	getAuthStatus,
	login,
	logout,
	setupInitialAdmin
} from "../../lib/api-client";

const admin = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};

const getAuthStatusMock = vi.mocked(getAuthStatus);
const loginMock = vi.mocked(login);
const logoutMock = vi.mocked(logout);
const setupInitialAdminMock = vi.mocked(setupInitialAdmin);

/** Exposes account state transitions through observable controls. */
function AuthProbe() {
	const auth = useAuth();
	return (
		<div>
			<span data-testid="auth-status">{auth.state.status}</span>
			<span data-testid="username">
				{auth.state.status === "signed-in" ? auth.state.user.username : ""}
			</span>
			<button
				type="button"
				onClick={() =>
					void auth.signIn({ username: "operator", password: "secret123" })
				}
			>
				Sign in
			</button>
			<button
				type="button"
				onClick={() => void auth.signOut().catch(() => undefined)}
			>
				Sign out
			</button>
		</div>
	);
}

function renderProvider() {
	return render(
		<AuthProvider>
			<AuthProbe />
		</AuthProvider>
	);
}

describe("AuthProvider", () => {
	beforeEach(() => {
		getAuthStatusMock.mockReset();
		loginMock.mockReset();
		logoutMock.mockReset();
		setupInitialAdminMock.mockReset();
	});

	it("fails closed while checking and exposes initial-administrator setup", async () => {
		let resolveStatus!: (value: {
			requiresInitialAdmin: boolean;
			systemSetupRequired: boolean;
			user: null;
		}) => void;
		getAuthStatusMock.mockReturnValue(
			new Promise((resolve) => {
				resolveStatus = resolve;
			})
		);
		renderProvider();

		expect(screen.getByTestId("auth-status")).toHaveTextContent("checking");

		resolveStatus({
			requiresInitialAdmin: true,
			systemSetupRequired: false,
			user: null
		});
		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent(
				"account-required"
			)
		);
	});

	it("uses cookie transport for browser sign-in without persisting a token", async () => {
		const user = userEvent.setup();
		getAuthStatusMock.mockResolvedValue({
			requiresInitialAdmin: false,
			systemSetupRequired: false,
			user: null
		});
		loginMock.mockResolvedValue({
			user: admin,
			token: null,
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		renderProvider();
		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out")
		);

		await user.click(screen.getByRole("button", { name: "Sign in" }));

		expect(loginMock).toHaveBeenCalledWith({
			username: "operator",
			password: "secret123"
		});
		expect(screen.getByTestId("username")).toHaveTextContent("operator");
		expect(window.localStorage.getItem("token")).toBeNull();
	});

	it("tears down the signed-in state on session expiry", async () => {
		localStorage.setItem("signalhaven.advanced-mode.v1", "true");
		localStorage.setItem("signalhaven:theme", "dark");
		localStorage.setItem("signalhaven:density", "compact");
		localStorage.setItem("signalhaven:animations", "off");
		getAuthStatusMock.mockResolvedValue({
			requiresInitialAdmin: false,
			systemSetupRequired: false,
			user: admin
		});
		renderProvider();
		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in")
		);

		act(() => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)));

		expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out");
		expect(localStorage.getItem("signalhaven.advanced-mode.v1")).toBe("false");
		expect(localStorage.getItem("signalhaven:theme")).toBe("system");
		expect(localStorage.getItem("signalhaven:density")).toBe("comfortable");
		expect(localStorage.getItem("signalhaven:animations")).toBe("on");
	});

	it("keeps the current session when logout fails", async () => {
		const user = userEvent.setup();
		getAuthStatusMock.mockResolvedValue({
			requiresInitialAdmin: false,
			systemSetupRequired: false,
			user: admin
		});
		logoutMock.mockRejectedValue(new Error("Server unavailable"));
		renderProvider();
		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in")
		);

		await user.click(screen.getByRole("button", { name: "Sign out" }));

		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in")
		);
	});

	it("preserves the sign-in form when an expected login 401 emits expiry", async () => {
		const user = userEvent.setup();
		getAuthStatusMock.mockResolvedValue({
			requiresInitialAdmin: false,
			systemSetupRequired: false,
			user: null
		});
		loginMock.mockImplementation(async () => {
			window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
			throw new ApiError("Unauthorized", 401, null);
		});
		render(
			<AuthProvider>
				<SignInForm />
			</AuthProvider>
		);
		const username = screen.getByLabelText(/^username$/i);
		await user.type(username, "viewer");
		await user.type(screen.getByLabelText(/^password$/i), "incorrect-password");
		await user.click(screen.getByRole("button", { name: /^sign in$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/not recognized/i
		);
		expect(username).toHaveValue("viewer");
	});
});
