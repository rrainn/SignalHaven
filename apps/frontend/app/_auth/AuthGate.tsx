"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, type ReactNode } from "react";

import { AdminAccessDenied } from "./AdminAccessDenied";
import { AuthCheckingSurface, AuthUnavailableSurface } from "./AuthSurface";
import { AuthenticatedApplication } from "./AuthenticatedApplication";
import { useAuth } from "./AuthProvider";
import {
	isAccessPath,
	isAdministratorPath,
	safeAppReturnPath
} from "./route-access";

/** Routes every browser state before protected account UI can mount. */
export function AuthGate({ children }: { children: ReactNode }) {
	const auth = useAuth();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const router = useRouter();
	const query = searchParams.toString();
	const currentPath = `${pathname}${query ? `?${query}` : ""}`;

	const redirectTarget = useMemo(() => {
		if (auth.state.status === "account-required") {
			return pathname === "/setup/account"
				? null
				: `/setup/account?next=${encodeURIComponent(currentPath)}`;
		}
		if (auth.state.status === "signed-out") {
			return pathname === "/sign-in"
				? null
				: `/sign-in?next=${encodeURIComponent(currentPath)}`;
		}
		if (auth.state.status === "signed-in" && isAccessPath(pathname)) {
			return safeAppReturnPath(searchParams.get("next"), auth.state.user.role);
		}
		return null;
	}, [auth.state, currentPath, pathname, searchParams]);

	useEffect(() => {
		if (redirectTarget) router.replace(redirectTarget);
	}, [redirectTarget, router]);

	if (auth.state.status === "checking" || redirectTarget) {
		return <AuthCheckingSurface />;
	}
	if (auth.state.status === "unavailable") {
		return (
			<AuthUnavailableSurface error={auth.state.error} onRetry={auth.refresh} />
		);
	}
	if (auth.state.status === "account-required") return children;
	if (auth.state.status === "signed-out") return children;

	const denied =
		auth.state.user.role !== "admin" && isAdministratorPath(pathname);
	return (
		<AuthenticatedApplication
			key={`${auth.state.user.id}:${auth.state.generation}`}
		>
			{denied ? <AdminAccessDenied /> : children}
		</AuthenticatedApplication>
	);
}
