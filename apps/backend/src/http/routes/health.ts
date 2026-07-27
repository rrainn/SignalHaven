import { healthResponseSchema, type HealthResponse } from "@signalhaven/shared";
import { Router } from "express";

import type { HealthRepository } from "../../repositories/health.repository";
import { getVersion } from "../../version";

export function createHealthRouter(healthRepository: HealthRepository): Router {
	const router = Router();

	router.get("/health", async (_req, res, next) => {
		try {
			const dbOk = await healthRepository.isHealthy();
			const body: HealthResponse = {
				status: dbOk ? "ok" : "error",
				version: getVersion(),
				uptime: process.uptime(),
				db: { ok: dbOk }
			};

			// Validate response shape in non-production builds is implicit via types;
			// we still parse to ensure runtime correctness.
			const parsed = healthResponseSchema.parse(body);

			res.status(dbOk ? 200 : 503).json(parsed);
		} catch (error) {
			next(error);
		}
	});

	return router;
}
