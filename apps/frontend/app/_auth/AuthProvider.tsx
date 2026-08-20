"use client";

import type {
	AuthLogin,
	AuthSetup,
	User,
	UserPreferences
} from "@signalhaven/shared";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode
} from "react";

import {
	ApiError,
	getAuthStatus,
	getPreferences,
	login,
	logout,
	setupInitialAdmin
} from "../../lib/api-client";
import { SESSION_EXPIRED_EVENT } from "../../lib/app-events";
import {
	clearAccountBrowserState,
	clearAuthenticatedClientRole,
	setAuthenticatedClientRole
} from "../../lib/account-browser-state";
import type { AuthBootstrap } from "./auth-bootstrap";

export type AccountPreferencesBootstrap = {
	userId: User["id"];
	generation: number;
} & (
	| { status: "ready"; preferences: UserPreferences }
	| { status: "error"; error: Error }
);

export type AuthState =
	| { status: "checking" }
	| { status: "account-required"; systemSetupRequired: boolean }
	| { status: "signed-out" }
	| {
			status: "signed-in";
			user: User;
			generation: number;
			preferencesBootstrap: AccountPreferencesBootstrap | null;
	  }
	| { status: "unavailable"; error: Error };

export type AuthContextValue = {
	state: AuthState;
	refresh: () => Promise<void>;
	createInitialAdmin: (
		credentials: Pick<AuthSetup, "username" | "password">
	) => Promise<User>;
	signIn: (
		credentials: Pick<AuthLogin, "username" | "password">
	) => Promise<User>;
	signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Owns cookie authentication and its account-bound preference bootstrap. */
export function AuthProvider({
	children,
	initialBootstrap
}: {
	children: ReactNode;
	initialBootstrap?: AuthBootstrap;
}) {
	const [state, setState] = useState<AuthState>(() =>
		initialBootstrap
			? stateFromBootstrap(initialBootstrap)
			: { status: "checking" }
	);
	const initialBootstrapRef = useRef(initialBootstrap);
	const refreshGeneration = useRef(initialBootstrap ? 1 : 0);

	const refresh = useCallback(async () => {
		const generation = ++refreshGeneration.current;
		// Checking is unauthenticated client state, even if a previous role was cached.
		clearAuthenticatedClientRole();
		setState({ status: "checking" });
		// Start both independent reads before awaiting either to remove bootstrap latency.
		const statusRequest = getAuthStatus();
		const preferencesRequest = getPreferences({
			unauthorized: "return-error"
		}).then(
			(preferences) => ({ status: "ready" as const, preferences }),
			(failure: unknown) => ({ status: "error" as const, failure })
		);
		try {
			const status = await statusRequest;
			if (generation !== refreshGeneration.current) return;
			if (status.requiresInitialAdmin) {
				clearAccountBrowserState();
				setState({
					status: "account-required",
					systemSetupRequired: status.systemSetupRequired
				});
				return;
			}
			if (status.user) {
				const preferencesResult = await preferencesRequest;
				if (generation !== refreshGeneration.current) return;
				if (
					preferencesResult.status === "error" &&
					preferencesResult.failure instanceof ApiError &&
					preferencesResult.failure.status === 401
				) {
					// Auth status proved a session existed, so this 401 is real expiry.
					clearAccountBrowserState();
					setState({ status: "signed-out" });
					return;
				}
				const preferencesBootstrap: AccountPreferencesBootstrap =
					preferencesResult.status === "ready"
						? {
								userId: status.user.id,
								generation,
								status: "ready",
								preferences: preferencesResult.preferences
							}
						: {
								userId: status.user.id,
								generation,
								status: "error",
								error: normalizeError(
									preferencesResult.failure,
									"Saved preferences could not be loaded"
								)
							};
				if (preferencesResult.status === "error") {
					// The authenticated shell remains closed while retaining the root cause.
					console.error(
						"[preferences] failed to load saved settings",
						preferencesResult.failure
					);
				}
				setAuthenticatedClientRole(status.user.role);
				setState({
					status: "signed-in",
					user: status.user,
					generation,
					preferencesBootstrap
				});
			} else {
				clearAccountBrowserState();
				setState({ status: "signed-out" });
			}
		} catch (failure) {
			if (generation !== refreshGeneration.current) return;
			clearAccountBrowserState();
			setState({
				status: "unavailable",
				error: normalizeError(failure, "SignalHaven could not be reached")
			});
		}
	}, []);

	useEffect(() => {
		const bootstrap = initialBootstrapRef.current;
		if (bootstrap) {
			// The role stays memory-only and is established from the validated snapshot.
			if (bootstrap.status === "signed-in") {
				setAuthenticatedClientRole(bootstrap.user.role);
			} else {
				clearAuthenticatedClientRole();
			}
		} else {
			void refresh();
		}
		return () => {
			refreshGeneration.current += 1;
		};
	}, [refresh]);

	useEffect(() => {
		const expire = () => {
			refreshGeneration.current += 1;
			clearAccountBrowserState();
			setState({ status: "signed-out" });
		};
		window.addEventListener(SESSION_EXPIRED_EVENT, expire);
		return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
	}, []);

	const createInitialAdmin = useCallback(
		async (credentials: Pick<AuthSetup, "username" | "password">) => {
			const session = await setupInitialAdmin(credentials);
			const generation = ++refreshGeneration.current;
			setAuthenticatedClientRole(session.user.role);
			setState({
				status: "signed-in",
				user: session.user,
				generation,
				preferencesBootstrap: null
			});
			return session.user;
		},
		[]
	);

	const signIn = useCallback(
		async (credentials: Pick<AuthLogin, "username" | "password">) => {
			const session = await login(credentials);
			const generation = ++refreshGeneration.current;
			setAuthenticatedClientRole(session.user.role);
			setState({
				status: "signed-in",
				user: session.user,
				generation,
				preferencesBootstrap: null
			});
			return session.user;
		},
		[]
	);

	const signOut = useCallback(async () => {
		// Keep the current account mounted if the server did not revoke it.
		await logout();
		refreshGeneration.current += 1;
		clearAccountBrowserState();
		setState({ status: "signed-out" });
	}, []);

	const value = useMemo<AuthContextValue>(
		() => ({ state, refresh, createInitialAdmin, signIn, signOut }),
		[state, refresh, createInitialAdmin, signIn, signOut]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Returns the fail-closed application authentication boundary. */
export function useAuth(): AuthContextValue {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
	return value;
}

/** Supports isolated component previews while production always supplies auth. */
export function useAuthOptional(): AuthContextValue | null {
	return useContext(AuthContext);
}

function normalizeError(failure: unknown, fallback: string): Error {
	return failure instanceof Error ? failure : new Error(fallback);
}

/** Converts the serializable server result into the provider's runtime state. */
function stateFromBootstrap(bootstrap: AuthBootstrap): AuthState {
	if (bootstrap.status === "account-required") return bootstrap;
	if (bootstrap.status === "signed-out") return bootstrap;
	if (bootstrap.status === "unavailable") {
		return { status: "unavailable", error: new Error(bootstrap.message) };
	}
	return {
		status: "signed-in",
		user: bootstrap.user,
		generation: 1,
		preferencesBootstrap:
			bootstrap.preferences.status === "ready"
				? {
						userId: bootstrap.user.id,
						generation: 1,
						status: "ready",
						preferences: bootstrap.preferences.preferences
					}
				: {
						userId: bootstrap.user.id,
						generation: 1,
						status: "error",
						error: new Error(bootstrap.preferences.message)
					}
	};
}
