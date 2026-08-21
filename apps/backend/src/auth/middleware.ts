import type { Request, RequestHandler, Response } from "express";
import type { IncomingMessage } from "node:http";

import type { User } from "@signalhaven/shared";

import { forbidden, unauthorized } from "../http/middleware/errors";
import type { AuthPrincipal, AuthService } from "./auth.service";
import { SESSION_COOKIE_NAME } from "./auth.service";
import {
	resolveMediaResource,
	type MediaTicketService
} from "./media-ticket.service";

declare module "express-serve-static-core" {
	interface Request {
		auth?: AuthPrincipal;
		authTransport?: "cookie" | "bearer" | "media-ticket";
	}
}

export interface AuthenticationMiddleware {
	optional: RequestHandler;
	required: RequestHandler;
	admin: RequestHandler;
	cookieOrigin: RequestHandler;
}

function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const pair of header.split(";")) {
		const separator = pair.indexOf("=");
		if (separator === -1) continue;
		if (pair.slice(0, separator).trim() !== name) continue;
		try {
			return decodeURIComponent(pair.slice(separator + 1).trim());
		} catch {
			return null;
		}
	}
	return null;
}

/** Loopback proxies are the only trusted source of forwarded origin metadata. */
function isLoopback(address: string | undefined): boolean {
	return (
		address === "127.0.0.1" ||
		address === "::1" ||
		address === "::ffff:127.0.0.1"
	);
}

/** Compare the complete browser origin, including scheme and effective port. */
function matchesOrigin(origin: string | undefined, expected: string): boolean {
	if (!origin) return false;
	try {
		return new URL(origin).origin === new URL(expected).origin;
	} catch {
		return false;
	}
}

/** WebSocket upgrades do not pass Express, so validate their cookie origin here. */
export function hasValidIncomingCookieOrigin(req: IncomingMessage): boolean {
	const trustedProxy = isLoopback(req.socket.remoteAddress);
	const forwardedHost = trustedProxy
		? req.headers["x-forwarded-host"]
		: undefined;
	const rawHost = Array.isArray(forwardedHost)
		? forwardedHost[0]
		: (forwardedHost?.split(",")[0]?.trim() ?? req.headers.host);
	if (!rawHost) return false;
	const forwardedProto = trustedProxy
		? req.headers["x-forwarded-proto"]
		: undefined;
	const rawProto = Array.isArray(forwardedProto)
		? forwardedProto[0]
		: forwardedProto?.split(",")[0]?.trim();
	const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
	const protocol =
		rawProto === "https" || rawProto === "http"
			? rawProto
			: encrypted
				? "https"
				: "http";
	const originHeader = req.headers.origin;
	const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
	return matchesOrigin(origin, `${protocol}://${rawHost}`);
}

/** Bearer wins when both transports exist, which keeps native calls explicit. */
export function readRequestToken(req: Request): {
	token: string;
	transport: "cookie" | "bearer";
} | null {
	return readIncomingRequestToken(req);
}

/** Shared header parser keeps HTTP and WebSocket authentication identical. */
export function readIncomingRequestToken(req: IncomingMessage): {
	token: string;
	transport: "cookie" | "bearer";
} | null {
	const authorizationHeader = req.headers.authorization;
	const authorization = Array.isArray(authorizationHeader)
		? authorizationHeader[0]
		: authorizationHeader;
	if (authorization?.startsWith("Bearer ")) {
		const token = authorization.slice("Bearer ".length).trim();
		if (token) return { token, transport: "bearer" };
	}
	const cookieHeader = req.headers.cookie;
	const cookie = readCookie(
		Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader,
		SESSION_COOKIE_NAME
	);
	return cookie ? { token: cookie, transport: "cookie" } : null;
}

export function createAuthenticationMiddleware(
	service: AuthService,
	mediaTickets?: MediaTicketService
): AuthenticationMiddleware {
	const optional: RequestHandler = async (req, _res, next) => {
		try {
			const credential = readRequestToken(req);
			let principal = credential
				? await service.authenticateToken(credential.token)
				: null;
			let transport: Request["authTransport"] = credential?.transport;
			if (!principal && !credential && mediaTickets && req.method === "GET") {
				const requestUrl = new URL(req.originalUrl, "http://signalhaven.local");
				const ticket = requestUrl.searchParams.get("mediaTicket");
				const resource = resolveMediaResource(
					req.path.replace(/^\/api\/v1/, "")
				);
				if (ticket && resource) {
					principal = await mediaTickets.authenticate(
						ticket,
						resource,
						requestUrl
					);
					transport = principal ? "media-ticket" : undefined;
				}
			}
			if (principal) {
				req.auth = principal;
				if (transport) req.authTransport = transport;
			}
			next();
		} catch (error) {
			next(error);
		}
	};

	const required: RequestHandler = (req, _res, next) => {
		if (!req.auth) {
			next(unauthorized());
			return;
		}
		next();
	};

	const admin: RequestHandler = (req, _res, next) => {
		if (req.auth?.user.role !== "admin") {
			next(forbidden());
			return;
		}
		next();
	};

	const cookieOrigin: RequestHandler = (req, _res, next) => {
		const requestedCookieSession =
			typeof req.body === "object" &&
			req.body !== null &&
			"transport" in req.body &&
			(req.body as { transport?: unknown }).transport === "cookie";
		const origin = req.header("origin");
		if (
			(req.authTransport !== "cookie" &&
				!requestedCookieSession &&
				origin === undefined) ||
			req.method === "GET" ||
			req.method === "HEAD" ||
			req.method === "OPTIONS"
		) {
			next();
			return;
		}
		const trustProxy = req.app.get("trust proxy fn") as
			| ((address: string, hop: number) => boolean)
			| undefined;
		const forwardedHost =
			trustProxy?.(req.socket.remoteAddress ?? "", 0) === true
				? req.header("x-forwarded-host")
				: undefined;
		const host = forwardedHost?.split(",")[0]?.trim() ?? req.header("host");
		if (!host || !matchesOrigin(origin, `${req.protocol}://${host}`)) {
			next(
				forbidden(
					"Cookie-authenticated requests require a same-origin Origin header"
				)
			);
			return;
		}
		next();
	};

	return { optional, required, admin, cookieOrigin };
}

/** Explicit test authentication avoids any environment-controlled production bypass. */
export function createTestAuthentication(
	user: User = {
		id: "00000000-0000-4000-8000-000000000001",
		username: "test-admin",
		role: "admin"
	}
): AuthenticationMiddleware {
	const principal: AuthPrincipal = {
		sessionId: "00000000-0000-4000-8000-000000000002",
		user
	};
	const optional: RequestHandler = (req, _res, next) => {
		req.auth = principal;
		req.authTransport = "bearer";
		next();
	};
	const required: RequestHandler = (req, _res, next) => {
		if (!req.auth) req.auth = principal;
		next();
	};
	const admin: RequestHandler = (_req, _res, next) => {
		if (user.role !== "admin") {
			next(forbidden());
			return;
		}
		next();
	};
	const cookieOrigin: RequestHandler = (_req, _res, next) => next();
	return { optional, required, admin, cookieOrigin };
}

export function setSessionCookie(
	res: Response,
	token: string,
	expiresAt: Date,
	secure: boolean
): void {
	// Expire the former API-only scope before issuing the document-wide cookie.
	clearSessionCookieAtPath(res, secure, "/api/v1");
	res.cookie(SESSION_COOKIE_NAME, token, {
		httpOnly: true,
		sameSite: "strict",
		secure,
		// Next.js authenticates document requests before rendering protected pages.
		path: "/",
		expires: expiresAt
	});
}

export function clearSessionCookie(res: Response, secure: boolean): void {
	clearSessionCookieAtPath(res, secure, "/");
	// Older clients may still retain the scope used before page authentication.
	clearSessionCookieAtPath(res, secure, "/api/v1");
}

/** Clears one exact cookie scope because browsers key cookies by name and path. */
function clearSessionCookieAtPath(
	res: Response,
	secure: boolean,
	path: string
): void {
	res.clearCookie(SESSION_COOKIE_NAME, {
		httpOnly: true,
		sameSite: "strict",
		secure,
		path
	});
}
