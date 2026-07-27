import {
	epgRefreshResultSchema,
	epgSourceCreateSchema,
	epgSourceIdParamSchema,
	epgSourceListSchema,
	epgSourcePatchSchema,
	epgSourceSchema,
	type EpgSource
} from "@signalhaven/shared";
import { Router } from "express";

import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";
import {
	EpgRefreshFailedError,
	EpgSourceNotFoundError,
	UnsupportedEpgKindError,
	type EpgService,
	type EpgSourceRecord
} from "../../epg/epg.service";

function toApi(row: EpgSourceRecord): EpgSource {
	return epgSourceSchema.parse({
		id: row.id,
		kind: row.kind,
		name: row.name,
		// DeviceAuth is a rotating credential and must never cross the API.
		url: row.kind === "hdhomerun_guide" ? null : row.url,
		filePath: row.filePath,
		tunerId: row.tunerId,
		refreshIntervalMinutes: row.refreshIntervalMinutes,
		timezone: row.timezone,
		enabled: row.enabled,
		lastRefreshAt: row.lastRefreshAt ? row.lastRefreshAt.toISOString() : null,
		lastRefreshStatus: row.lastRefreshStatus,
		lastRefreshError: row.lastRefreshError,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	});
}

export function createEpgRouter(service: EpgService): Router {
	const router = Router();

	router.get("/epg/sources", async (_req, res, next) => {
		try {
			const items = (await service.list()).map(toApi);
			res.json(epgSourceListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	router.post(
		"/epg/sources",
		validate({ body: epgSourceCreateSchema }),
		async (req, res, next) => {
			try {
				const created = await service.create({
					kind: req.body.kind,
					name: req.body.name,
					url: req.body.url ?? null,
					filePath: req.body.filePath ?? null,
					tunerId: req.body.tunerId ?? null,
					refreshIntervalMinutes: req.body.refreshIntervalMinutes,
					timezone: req.body.timezone ?? null,
					enabled: req.body.enabled
				});
				res.status(201).json(toApi(created));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.get(
		"/epg/sources/:id",
		validate({ params: epgSourceIdParamSchema }),
		async (req, res, next) => {
			try {
				const row = await service.getById(req.params["id"] as string);
				res.json(toApi(row));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.patch(
		"/epg/sources/:id",
		validate({
			params: epgSourceIdParamSchema,
			body: epgSourcePatchSchema
		}),
		async (req, res, next) => {
			try {
				const updated = await service.update(
					req.params["id"] as string,
					req.body
				);
				res.json(toApi(updated));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.delete(
		"/epg/sources/:id",
		validate({ params: epgSourceIdParamSchema }),
		async (req, res, next) => {
			try {
				await service.delete(req.params["id"] as string);
				res.status(204).end();
			} catch (error) {
				next(translate(error));
			}
		}
	);

	/**
	 * Manually trigger a refresh for the given source. Returns import
	 * counts on success; progress is also published incrementally on the
	 * `epg` WS topic under event `epg.refresh`.
	 */
	router.post(
		"/epg/sources/:id/refresh",
		validate({ params: epgSourceIdParamSchema }),
		async (req, res, next) => {
			try {
				const result = await service.refresh(req.params["id"] as string);
				res.status(202).json(
					epgRefreshResultSchema.parse({
						channelsSeen: result.channelsSeen,
						programsSeen: result.programsSeen,
						channelsUpserted: result.channelsUpserted,
						programsUpserted: result.programsUpserted,
						programsInserted: result.programsInserted,
						programsChanged: result.programsChanged,
						programsUnchanged: result.programsUnchanged,
						programsPruned: result.programsPruned,
						durationMs: result.durationMs
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	return router;
}

function translate(error: unknown): unknown {
	if (error instanceof EpgSourceNotFoundError) {
		return new HttpError(404, "not_found", error.message);
	}
	if (error instanceof UnsupportedEpgKindError) {
		return new HttpError(400, "bad_request", error.message);
	}
	if (error instanceof EpgRefreshFailedError) {
		return new HttpError(502, "epg_refresh_failed", error.message);
	}
	return error;
}
