"use client";

import type { AuthLogin, AuthSetup, User } from "@signalhaven/shared";
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
	getAuthStatus,
	login,
	logout,
	setupInitialAdmin
} from "../../lib/api-client";
import { SESSION_EXPIRED_EVENT } from "../../lib/app-events";
import {
	clearAccountBrowserState,
	setAuthenticatedClientRole
} from "../../lib/account-browser-state";

export type AuthState =
	| { status: "checking" }
	| { status: "account-required"; systemSetupRequired: boolean }
	| { status: "signed-out" }
	| { status: "signed-in"; user: User }
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

/** Owns the browser's cookie session without ever retaining password material. */
export function AuthProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<AuthState>({ status: "checking" });
	const refreshGeneration = useRef(0);

	const refresh = useCallback(async () => {
		const generation = ++refreshGeneration.current;
		setState({ status: "checking" });
		try {
			const status = await getAuthStatus();
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
				setAuthenticatedClientRole(status.user.role);
				setState({ status: "signed-in", user: status.user });
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
		void refresh();
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
			setAuthenticatedClientRole(session.user.role);
			setState({ status: "signed-in", user: session.user });
			return session.user;
		},
		[]
	);

	const signIn = useCallback(
		async (credentials: Pick<AuthLogin, "username" | "password">) => {
			const session = await login(credentials);
			setAuthenticatedClientRole(session.user.role);
			setState({ status: "signed-in", user: session.user });
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
