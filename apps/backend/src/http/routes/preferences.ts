import {
	userPreferencesPatchSchema,
	userPreferencesSchema
} from "@signalhaven/shared";
import { Router } from "express";

import type { UserPreferencesService } from "../../settings/user-preferences.service";
import { validate } from "../middleware/validate";

export function createPreferencesRouter(
	service: UserPreferencesService
): Router {
	const router = Router();

	router.get("/preferences", async (req, res, next) => {
		try {
			res.setHeader("Cache-Control", "private, no-store");
			res.json(
				userPreferencesSchema.parse(await service.getAll(req.auth!.user.id))
			);
		} catch (error) {
			next(error);
		}
	});

	router.patch(
		"/preferences",
		validate({ body: userPreferencesPatchSchema }),
		async (req, res, next) => {
			try {
				res.setHeader("Cache-Control", "private, no-store");
				res.json(
					userPreferencesSchema.parse(
						await service.patch(req.auth!.user.id, req.body)
					)
				);
			} catch (error) {
				next(error);
			}
		}
	);

	return router;
}
