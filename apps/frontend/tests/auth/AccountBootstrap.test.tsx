import {
	userPreferencesDefaults,
	type AuthStatus,
	type UserPreferences
} from "@signalhaven/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedApplication } from "../../app/_auth/AuthenticatedApplication";
import { AuthProvider, useAuth } from "../../app/_auth/AuthProvider";
import { usePreferences } from "../../app/_preferences/PreferencesProvider";
import { ThemeProvider } from "../../app/_theme/ThemeProvider";
import {
	clearAccountBrowserState,
	mayShowAdvancedDiagnostics,
	setAuthenticatedClientRole
} from "../../lib/account-browser-state";
import { SESSION_EXPIRED_EVENT } from "../../lib/app-events";

vi.mock("../../app/_advanced/AdvancedModeProvider", () => ({
	AdvancedModeProvider: ({ children }: { children: ReactNode }) => children
}));

vi.mock("../../app/_layout/AppShell", () => ({
	AppShell: ({ children }: { children: ReactNode }) => children
}));

vi.mock("../../app/_onboarding/OnboardingProvider", () => ({
	OnboardingProvider: ({ children }: { children: ReactNode }) => children
}));

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		getAuthStatus: vi.fn(),
		getPreferences: vi.fn(),
		login: vi.fn(),
		logout: vi.fn(),
		setupInitialAdmin: vi.fn()
	};
});

import { ApiError, getAuthStatus, getPreferences } from "../../lib/api-client";

const admin = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};

const viewer = {
	id: "00000000-0000-4000-8000-000000000002",
	username: "viewer",
	role: "user" as const
};

const adminPreferences: UserPreferences = {
	...userPreferencesDefaults,
	ui: {
		...userPreferencesDefaults.ui,
		use24HourClock: true
	}
};

const viewerPreferences: UserPreferences = {
	...userPreferencesDefaults,
	ui: {
		...userPreferencesDefaults.ui,
		epgHoursVisible: 8
	}
};

const getAuthStatusMock = vi.mocked(getAuthStatus);
const getPreferencesMock = vi.mocked(getPreferences);

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
};

/** Creates a controllable request so bootstrap ordering stays observable. */
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

/** Exposes the authenticated identity and protected preference snapshot. */
function BootstrapProbe() {
	const auth = useAuth();
	return (
		<div>
			<span data-testid="auth-status">{auth.state.status}</span>
			<span data-testid="username">
				{auth.state.status === "signed-in" ? auth.state.user.username : ""}
			</span>
			<button type="button" onClick={() => void auth.refresh()}>
				Refresh account
			</button>
			{auth.state.status === "signed-in" ? (
				<AuthenticatedApplication>
					<PreferencesProbe />
				</AuthenticatedApplication>
			) : null}
		</div>
	);
}

/** Renders only after the complete account-owned snapshot becomes available. */
function PreferencesProbe() {
	const preferences = usePreferences();
	return (
		<div data-testid="protected-content">
			<span data-testid="clock">
				{String(preferences.preferences.ui.use24HourClock)}
			</span>
			<span data-testid="epg-hours">
				{preferences.preferences.ui.epgHoursVisible}
			</span>
		</div>
	);
}

function renderBootstrap() {
	return render(
		<ThemeProvider>
			<AuthProvider>
				<BootstrapProbe />
			</AuthProvider>
		</ThemeProvider>
	);
}

beforeEach(() => {
	clearAccountBrowserState();
	getAuthStatusMock.mockReset();
	getPreferencesMock.mockReset();
});

describe("account-safe preference bootstrap", () => {
	it("revokes a stale administrator diagnostic role while bootstrap is pending", async () => {
		const statusRequest = deferred<AuthStatus>();
		const preferencesRequest = deferred<UserPreferences>();
		localStorage.setItem("signalhaven.advanced-mode.v1", "true");
		setAuthenticatedClientRole("admin");
		getAuthStatusMock.mockReturnValue(statusRequest.promise);
		getPreferencesMock.mockReturnValue(preferencesRequest.promise);

		renderBootstrap();

		await waitFor(() => expect(getAuthStatusMock).toHaveBeenCalledTimes(1));
		expect(mayShowAdvancedDiagnostics()).toBe(false);

		act(() => {
			statusRequest.resolve({
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: null
			});
			preferencesRequest.reject(new ApiError("Unauthorized", 401, null));
		});
		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out")
		);
	});

	it("loads auth and preferences concurrently without a second preference GET", async () => {
		const statusRequest = deferred<AuthStatus>();
		const preferencesRequest = deferred<UserPreferences>();
		getAuthStatusMock.mockReturnValue(statusRequest.promise);
		getPreferencesMock.mockReturnValue(preferencesRequest.promise);

		renderBootstrap();

		await waitFor(() => {
			expect(getAuthStatusMock).toHaveBeenCalledTimes(1);
			expect(getPreferencesMock).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByTestId("auth-status")).toHaveTextContent("checking");

		act(() => preferencesRequest.resolve(adminPreferences));
		expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
		act(() =>
			statusRequest.resolve({
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: admin
			})
		);

		expect(await screen.findByTestId("protected-content")).toBeInTheDocument();
		expect(screen.getByTestId("clock")).toHaveTextContent("true");
		expect(getPreferencesMock).toHaveBeenCalledTimes(1);
		expect(getPreferencesMock).toHaveBeenCalledWith({
			unauthorized: "return-error"
		});
	});

	it.each([
		[
			"account-required",
			{
				requiresInitialAdmin: true,
				systemSetupRequired: false,
				user: null
			} satisfies AuthStatus
		],
		[
			"signed-out",
			{
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: null
			} satisfies AuthStatus
		]
	] as const)(
		"does not expire the session for a speculative 401 in %s state",
		async (expectedState, status) => {
			const expired = vi.fn();
			window.addEventListener(SESSION_EXPIRED_EVENT, expired);
			getAuthStatusMock.mockResolvedValue(status);
			getPreferencesMock.mockImplementation(async (init) => {
				// Model the API client's default side effect unless bootstrap suppresses it.
				if (init?.unauthorized !== "return-error") {
					window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
				}
				throw new ApiError("Unauthorized", 401, null);
			});

			try {
				renderBootstrap();
				await waitFor(() =>
					expect(screen.getByTestId("auth-status")).toHaveTextContent(
						expectedState
					)
				);
				expect(expired).not.toHaveBeenCalled();
			} finally {
				window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
			}
		}
	);

	it("expires a confirmed signed-in session when preference bootstrap returns 401", async () => {
		getAuthStatusMock.mockResolvedValue({
			requiresInitialAdmin: false,
			systemSetupRequired: false,
			user: admin
		});
		getPreferencesMock.mockRejectedValue(
			new ApiError("Unauthorized", 401, null)
		);

		renderBootstrap();

		await waitFor(() =>
			expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out")
		);
		expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
	});

	it("keeps a failed preference bootstrap closed until an explicit retry succeeds", async () => {
		const user = userEvent.setup();
		getAuthStatusMock.mockResolvedValue({
			requiresInitialAdmin: false,
			systemSetupRequired: false,
			user: admin
		});
		getPreferencesMock
			.mockRejectedValueOnce(new Error("Malformed saved settings"))
			.mockResolvedValueOnce(adminPreferences);

		renderBootstrap();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/malformed saved settings/i
		);
		expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
		expect(getPreferencesMock).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole("button", { name: "Try again" }));

		expect(await screen.findByTestId("protected-content")).toBeInTheDocument();
		expect(screen.getByTestId("clock")).toHaveTextContent("true");
		expect(getPreferencesMock).toHaveBeenCalledTimes(2);
	});

	it("drops stale snapshots when a newer generation resolves for another account", async () => {
		const user = userEvent.setup();
		const firstStatus = deferred<AuthStatus>();
		const firstPreferences = deferred<UserPreferences>();
		const secondStatus = deferred<AuthStatus>();
		const secondPreferences = deferred<UserPreferences>();
		getAuthStatusMock
			.mockReturnValueOnce(firstStatus.promise)
			.mockReturnValueOnce(secondStatus.promise);
		getPreferencesMock
			.mockReturnValueOnce(firstPreferences.promise)
			.mockReturnValueOnce(secondPreferences.promise);

		renderBootstrap();
		await waitFor(() => expect(getPreferencesMock).toHaveBeenCalledTimes(1));
		await user.click(screen.getByRole("button", { name: "Refresh account" }));
		await waitFor(() => expect(getPreferencesMock).toHaveBeenCalledTimes(2));

		act(() => {
			secondStatus.resolve({
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: viewer
			});
			secondPreferences.resolve(viewerPreferences);
		});
		await waitFor(() =>
			expect(screen.getByTestId("username")).toHaveTextContent("viewer")
		);
		expect(screen.getByTestId("epg-hours")).toHaveTextContent("8");

		act(() => {
			firstStatus.resolve({
				requiresInitialAdmin: false,
				systemSetupRequired: false,
				user: admin
			});
			firstPreferences.resolve(adminPreferences);
		});
		await waitFor(() =>
			expect(screen.getByTestId("username")).toHaveTextContent("viewer")
		);
		expect(screen.getByTestId("epg-hours")).toHaveTextContent("8");
		expect(getPreferencesMock).toHaveBeenCalledTimes(2);
	});
});
