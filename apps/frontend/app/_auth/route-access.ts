import type { UserRole } from "@signalhaven/shared";

const AUTH_PATHS = ["/sign-in", "/setup/account"] as const;

/** System configuration and diagnostics remain administrator-only surfaces. */
export function isAdministratorPath(pathname: string): boolean {
	return (
		pathname === "/settings" ||
		pathname.startsWith("/settings/") ||
		pathname === "/advanced" ||
		pathname.startsWith("/advanced/")
	);
}

/** Prevents untrusted query parameters from becoming open or privileged redirects. */
export function safeAppReturnPath(
	value: string | null | undefined,
	role: UserRole
): string {
	if (!value || !value.startsWith("/") || value.startsWith("//")) {
		return "/guide";
	}
	try {
		const url = new URL(value, "https://signalhaven.invalid");
		if (url.origin !== "https://signalhaven.invalid") return "/guide";
		if (AUTH_PATHS.some((path) => url.pathname === path)) return "/guide";
		if (role !== "admin" && isAdministratorPath(url.pathname)) return "/guide";
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return "/guide";
	}
}

/** Identifies the two routes that render outside the authenticated shell. */
export function isAccessPath(pathname: string): boolean {
	return AUTH_PATHS.some((path) => pathname === path);
}
