import {
	authLoginSchema,
	authSessionSchema,
	authSetupSchema,
	authStatusSchema
} from "@signalhaven/shared";
import { Router } from "express";

import type { AuthService } from "../../auth/auth.service";
import { createAuthRateLimiter } from "../../auth/rate-limit";
import {
	clearSessionCookie,
	setSessionCookie,
	type AuthenticationMiddleware
} from "../../auth/middleware";
import type { SystemStatusService } from "../../system/system-status.service";
import { toApiDateTime } from "../date-time";
import { validate } from "../middleware/validate";

export function createAuthRouter(options: {
	auth: AuthService;
	authentication: AuthenticationMiddleware;
	/** Status is deliberately narrowed so contract tests still execute the production router. */
	systemStatus: Pick<SystemStatusService, "getStatus">;
	env?: NodeJS.ProcessEnv;
}): Router {
	const router = Router();
	const limitAuthentication = createAuthRateLimiter();
	const noStore = (
		_req: unknown,
		res: import("express").Response,
		next: () => void
	) => {
		res.setHeader("Cache-Control", "private, no-store");
		next();
	};

	router.get(
		"/auth/status",
		noStore,
		options.authentication.optional,
		async (req, res, next) => {
			try {
				const [requiresInitialAdmin, systemStatus] = await Promise.all([
					options.auth.requiresInitialAdmin(),
					options.systemStatus.getStatus()
				]);
				res.json(
					authStatusSchema.parse({
						requiresInitialAdmin,
						systemSetupRequired: systemStatus.firstRun,
						user: req.auth?.user ?? null
					})
				);
			} catch (error) {
				next(error);
			}
		}
	);

	router.post(
		"/auth/setup",
		noStore,
		options.authentication.cookieOrigin,
		validate({ body: authSetupSchema }),
		limitAuthentication,
		async (req, res, next) => {
			try {
				const issued = await options.auth.setup(req.body);
				if (req.body.transport === "cookie") {
					setSessionCookie(res, issued.token, issued.expiresAt, req.secure);
				}
				res.status(201).json(
					authSessionSchema.parse({
						user: issued.principal.user,
						token: req.body.transport === "bearer" ? issued.token : null,
						expiresAt: toApiDateTime(issued.expiresAt)
					})
				);
			} catch (error) {
				next(error);
			}
		}
	);

	router.post(
		"/auth/login",
		noStore,
		options.authentication.cookieOrigin,
		validate({ body: authLoginSchema }),
		limitAuthentication,
		async (req, res, next) => {
			try {
				const issued = await options.auth.login(req.body);
				if (req.body.transport === "cookie") {
					setSessionCookie(res, issued.token, issued.expiresAt, req.secure);
				}
				res.json(
					authSessionSchema.parse({
						user: issued.principal.user,
						token: req.body.transport === "bearer" ? issued.token : null,
						expiresAt: toApiDateTime(issued.expiresAt)
					})
				);
			} catch (error) {
				next(error);
			}
		}
	);

	router.get(
		"/auth/me",
		noStore,
		options.authentication.optional,
		options.authentication.required,
		(req, res) => {
			res.json({ user: req.auth!.user });
		}
	);

	router.post(
		"/auth/logout",
		noStore,
		options.authentication.optional,
		options.authentication.required,
		options.authentication.cookieOrigin,
		async (req, res, next) => {
			try {
				await options.auth.logout(req.auth!.sessionId);
				clearSessionCookie(res, req.secure);
				res.status(204).end();
			} catch (error) {
				next(error);
			}
		}
	);

	return router;
}
