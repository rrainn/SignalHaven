import {
	settingsPatchSchema,
	settingsSchema,
	type Settings
} from "@signalhaven/shared";
import { Router } from "express";

import { validate } from "../middleware/validate";
import type { SettingsService } from "../../settings/settings.service";

export function createSettingsRouter(service: SettingsService): Router {
	const router = Router();

	router.get("/settings", async (_req, res, next) => {
		try {
			const current = await service.getAll();
			// Re-parse the response against the schema so any drift between the
			// service and the published contract is caught in tests/dev rather
			// than silently shipped.
			const parsed: Settings = settingsSchema.parse(current);
			res.json(parsed);
		} catch (error) {
			next(error);
		}
	});

	router.patch(
		"/settings",
		validate({ body: settingsPatchSchema }),
		async (req, res, next) => {
			try {
				const updated = await service.patch(req.body);
				res.json(settingsSchema.parse(updated));
			} catch (error) {
				next(error);
			}
		}
	);

	return router;
}
