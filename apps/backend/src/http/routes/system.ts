import { systemInfoSchema, systemStatusSchema } from "@signalhaven/shared";
import { Router } from "express";

import type { SystemStatusService } from "../../system/system-status.service";
import { getGitCommit, getVersion } from "../../version";

export function createSystemRouter(
	service: SystemStatusService,
	env: NodeJS.ProcessEnv = process.env
): Router {
	const router = Router();

	router.get("/system/info", (_req, res) => {
		// Build metadata does not depend on the database, so it remains available
		// when users need the About tab for troubleshooting.
		res.setHeader("Cache-Control", "no-store");
		res.json(
			systemInfoSchema.parse({
				version: getVersion(env),
				gitCommit: getGitCommit(env),
				uptime: process.uptime()
			})
		);
	});

	router.get("/system/status", async (_req, res, next) => {
		try {
			const status = await service.getStatus();
			res.json(systemStatusSchema.parse(status));
		} catch (error) {
			next(error);
		}
	});

	return router;
}
