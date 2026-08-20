/**
 * HTTP route for `GET /api/v1/epg/grid`.
 *
 * Accepts `from` and `to` ISO 8601 query parameters and returns the
 * full EPG grid payload (channels + intersecting programs with optional
 * recording status annotations) consumed by the frontend guide view.
 */

import {
	epgGridQuerySchema,
	epgGridSchema,
	epgProgramDetailsSchema,
	epgProgramIdParamSchema
} from "@signalhaven/shared";
import { Router } from "express";

import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";
import type { EpgGridService } from "../../epg/epg-grid.service";

export function createEpgGridRouter(service: EpgGridService): Router {
	const router = Router();
	// Recording annotations differ by account even when guide rows are global.
	router.use((_req, res, next) => {
		res.setHeader("Cache-Control", "private, no-store");
		next();
	});

	router.get(
		"/epg/grid",
		validate({ query: epgGridQuerySchema }),
		async (req, res, next) => {
			try {
				const from = new Date(req.query["from"] as string);
				const to = new Date(req.query["to"] as string);

				// Guard against invalid dates sneaking past the schema validation.
				if (isNaN(from.getTime()) || isNaN(to.getTime())) {
					return next(
						new HttpError(400, "bad_request", "Invalid `from` or `to` date")
					);
				}
				if (from >= to) {
					return next(
						new HttpError(
							400,
							"bad_request",
							"`from` must be strictly before `to`"
						)
					);
				}

				const grid = await service.getGrid(from, to, req.auth!.user.id);
				res.json(epgGridSchema.parse(grid));
			} catch (error) {
				next(error);
			}
		}
	);

	router.get(
		"/epg/programs/:id",
		validate({ params: epgProgramIdParamSchema }),
		async (req, res, next) => {
			try {
				const details = await service.getProgram(
					req.params["id"] as string,
					req.auth!.user.id
				);
				if (!details) {
					return next(
						new HttpError(
							404,
							"not_found",
							"Program not found or no longer available"
						)
					);
				}
				res.json(epgProgramDetailsSchema.parse(details));
			} catch (error) {
				next(error);
			}
		}
	);

	return router;
}
