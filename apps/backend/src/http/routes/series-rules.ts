import {
	recordingConflictListSchema,
	seriesRuleCreateSchema,
	seriesRuleIdParamSchema,
	seriesRuleListSchema,
	seriesRulePatchSchema,
	seriesRuleSchema
} from "@signalhaven/shared";
import { Router } from "express";

import {
	SeriesRuleLimitError,
	type SeriesRuleRecord
} from "../../repositories/series-rules.repository";
import type { SeriesRulesService } from "../../series/series-rules.service";
import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";

/** Convert a DB row into the public, JSON-serialisable shape. */
function toPublicSeriesRule(row: SeriesRuleRecord): {
	id: string;
	title: string;
	channelId: string | null;
	epgChannelId: string | null;
	keepCount: number;
	episodePolicy: SeriesRuleRecord["episodePolicy"];
	newOnly: boolean;
	priority: number;
	retentionDays: number | null;
	createdAt: string;
	updatedAt: string;
} {
	return {
		id: row.id,
		title: row.title,
		channelId: row.channelId,
		epgChannelId: row.epgChannelId,
		keepCount: row.keepCount,
		episodePolicy: row.episodePolicy,
		newOnly: row.episodePolicy !== "all",
		priority: row.priority,
		retentionDays: row.retentionDays,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}

export function createSeriesRulesRouter(service: SeriesRulesService): Router {
	const router = Router();
	router.use((_req, res, next) => {
		res.setHeader("Cache-Control", "private, no-store");
		next();
	});

	router.get("/series-rules", async (req, res, next) => {
		try {
			const items = (await service.list(req.auth!.user.id)).map(
				toPublicSeriesRule
			);
			res.json(seriesRuleListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	router.post(
		"/series-rules",
		validate({ body: seriesRuleCreateSchema }),
		async (req, res, next) => {
			try {
				const body = req.body as {
					title: string;
					channelId?: string | null;
					epgChannelId?: string | null;
					keepCount: number;
					episodePolicy?: SeriesRuleRecord["episodePolicy"];
					newOnly?: boolean;
					priority: number;
					retentionDays?: number | null;
				};
				const created = await service.create({
					userId: req.auth!.user.id,
					title: body.title,
					channelId: body.channelId ?? null,
					epgChannelId: body.epgChannelId ?? null,
					keepCount: body.keepCount,
					episodePolicy:
						body.episodePolicy ?? (body.newOnly ? "confirmed_new" : "all"),
					priority: body.priority,
					retentionDays: body.retentionDays ?? null
				});
				res
					.status(201)
					.json(seriesRuleSchema.parse(toPublicSeriesRule(created)));
			} catch (error) {
				next(
					error instanceof SeriesRuleLimitError
						? new HttpError(429, error.code, error.message)
						: error
				);
			}
		}
	);

	router.get(
		"/series-rules/:id",
		validate({ params: seriesRuleIdParamSchema }),
		async (req, res, next) => {
			try {
				const row = await service.getById(
					req.params["id"] as string,
					req.auth!.user.id
				);
				if (!row) {
					throw new HttpError(404, "not_found", "Series rule not found");
				}
				res.json(seriesRuleSchema.parse(toPublicSeriesRule(row)));
			} catch (error) {
				next(error);
			}
		}
	);

	router.patch(
		"/series-rules/:id",
		validate({
			params: seriesRuleIdParamSchema,
			body: seriesRulePatchSchema
		}),
		async (req, res, next) => {
			try {
				const updated = await service.update(
					req.params["id"] as string,
					req.body as Parameters<SeriesRulesService["update"]>[1],
					req.auth!.user.id
				);
				if (!updated) {
					throw new HttpError(404, "not_found", "Series rule not found");
				}
				res.json(seriesRuleSchema.parse(toPublicSeriesRule(updated)));
			} catch (error) {
				next(error);
			}
		}
	);

	router.delete(
		"/series-rules/:id",
		validate({ params: seriesRuleIdParamSchema }),
		async (req, res, next) => {
			try {
				const ok = await service.delete(
					req.params["id"] as string,
					req.auth!.user.id
				);
				if (!ok) {
					throw new HttpError(404, "not_found", "Series rule not found");
				}
				res.status(204).end();
			} catch (error) {
				next(error);
			}
		}
	);

	/**
	 * Conflicts surfaced by the most recent series-rule evaluation
	 * passes. Backed by an in-memory ring buffer that's reset across
	 * restarts (durability is intentionally weak — clients are expected
	 * to also subscribe to the WS `recordings` topic for real-time
	 * updates).
	 */
	router.get("/recordings/conflicts", (req, res, next) => {
		try {
			const items = service.getConflicts(req.auth!.user.id);
			res.json(recordingConflictListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	return router;
}
