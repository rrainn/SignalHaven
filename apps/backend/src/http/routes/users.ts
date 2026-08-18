import {
	userCreateSchema,
	userListSchema,
	userSchema
} from "@signalhaven/shared";
import { Router } from "express";

import type { AuthService } from "../../auth/auth.service";
import { validate } from "../middleware/validate";

export function createUsersRouter(service: AuthService): Router {
	const router = Router();

	router.get("/users", async (_req, res, next) => {
		try {
			res.json(userListSchema.parse({ users: await service.listUsers() }));
		} catch (error) {
			next(error);
		}
	});

	router.post(
		"/users",
		validate({ body: userCreateSchema }),
		async (req, res, next) => {
			try {
				res
					.status(201)
					.json(userSchema.parse(await service.createUser(req.body)));
			} catch (error) {
				next(error);
			}
		}
	);

	return router;
}
