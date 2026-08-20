import {
	TUNER_UNAVAILABLE_ERROR_CODE,
	tunerActivityResponseSchema,
	tunerCreateSchema,
	tunerDiscoveryResponseSchema,
	tunerIdParamSchema,
	tunerListSchema,
	tunerPatchSchema,
	tunerSchema,
	tunerStatusSchema,
	tunerSyncResponseSchema
} from "@signalhaven/shared";
import { Router } from "express";
import { z } from "zod";

import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { TunerUnavailableError } from "../../tuners/tuner-allocator";
import {
	TunerNotFoundError,
	UnsupportedTunerKindError,
	type TunersService
} from "../../tuners/tuners.service";
import type { EpgService } from "../../epg/epg.service";
import type { TunerLineupSyncService } from "../../tuners/tuner-lineup-sync.service";

const tunerChannelLogoParamSchema = z.object({
	id: z.string().uuid(),
	channelId: z.string().min(1).max(128)
});

export function createTunersRouter(
	service: TunersService,
	epgService: EpgService,
	lineupSyncService: TunerLineupSyncService,
	onChannelsChanged?: () => void
): Router {
	const router = Router();

	router.get("/tuners", async (_req, res, next) => {
		try {
			const items = await service.list();
			res.json(tunerListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	router.post(
		"/tuners",
		validate({ body: tunerCreateSchema }),
		async (req, res, next) => {
			try {
				const created = await service.create(req.body);
				try {
					await epgService.ensureTunerSource(created);
				} catch (provisionError) {
					// Tuner persistence already succeeded. Startup reconciliation will
					// retry provisioning, while the log retains the actionable cause.
					req.log?.error(
						{ err: provisionError, tunerId: created.id },
						"Failed to provision tuner guide source"
					);
				}
				res.status(201).json(tunerSchema.parse(created));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post("/tuners/discover", async (_req, res, next) => {
		try {
			const results = await service.discover();
			res.json(tunerDiscoveryResponseSchema.parse({ results }));
		} catch (error) {
			next(error);
		}
	});

	/**
	 * Snapshot of every active tuner lease tracked by the in-process
	 * `TunerAllocator`. Drives the "what's currently using a tuner?" UI and
	 * is the read-side counterpart to the WS `lease.acquired` /
	 * `lease.released` / `lease.preempted` events on the `tuners` topic.
	 */
	router.get("/tuners/activity", (_req, res, next) => {
		try {
			const leases = service.getActivity();
			res.json(tunerActivityResponseSchema.parse({ leases }));
		} catch (error) {
			next(error);
		}
	});

	router.get(
		"/tuners/:id",
		validate({ params: tunerIdParamSchema }),
		async (req, res, next) => {
			try {
				const tuner = await service.getById(req.params["id"] as string);
				res.json(tunerSchema.parse(tuner));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	/**
	 * Live reachability snapshot for a tuner. Delegates to the underlying
	 * provider's `getStatus()` so the Settings UI can render an "online /
	 * unreachable" indicator next to each configured tuner. Failures from
	 * the provider are surfaced as `online: false` rather than a 5xx so
	 * the indicator can render cleanly without a separate error path.
	 */
	router.get(
		"/tuners/:id/status",
		validate({ params: tunerIdParamSchema }),
		async (req, res, next) => {
			try {
				const provider = await service.getProviderById(
					req.params["id"] as string
				);
				let status;
				try {
					status = await provider.getStatus();
				} catch (err) {
					status = {
						online: false,
						message: err instanceof Error ? err.message : "Status check failed",
						checkedAt: new Date().toISOString()
					};
				}
				res.json(tunerStatusSchema.parse(status));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	/**
	 * Proxy a channel logo through our origin so an HTTPS UI can render logos
	 * from playlists that reference HTTP image URLs (mixed-content workaround).
	 * The provider is responsible for caching upstream bytes; we just forward
	 * the body and translate "no logo" / errors into HTTP responses.
	 */
	router.get(
		"/tuners/:id/channels/:channelId/logo",
		validate({ params: tunerChannelLogoParamSchema }),
		async (req, res, next) => {
			try {
				const provider = await service.getProviderById(
					req.params["id"] as string
				);
				if (typeof provider.getLogo !== "function") {
					throw new HttpError(
						404,
						"not_found",
						"Tuner kind does not expose channel logos"
					);
				}
				const channelId = req.params["channelId"] as string;
				const logo = await provider.getLogo(channelId);
				if (!logo) {
					throw new HttpError(404, "not_found", "Logo not available");
				}
				res.setHeader("Content-Type", logo.contentType);
				res.setHeader("Cache-Control", "private, no-store");
				res.setHeader("X-Content-Type-Options", "nosniff");
				res.status(200).send(logo.body);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.patch(
		"/tuners/:id",
		validate({ params: tunerIdParamSchema, body: tunerPatchSchema }),
		async (req, res, next) => {
			try {
				const updated = await service.update(
					req.params["id"] as string,
					req.body
				);
				try {
					await epgService.ensureTunerSource(updated);
				} catch (provisionError) {
					req.log?.error(
						{ err: provisionError, tunerId: updated.id },
						"Failed to reconcile tuner guide source"
					);
				}
				res.json(tunerSchema.parse(updated));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.delete(
		"/tuners/:id",
		validate({ params: tunerIdParamSchema }),
		async (req, res, next) => {
			try {
				await service.delete(req.params["id"] as string);
				onChannelsChanged?.();
				res.status(204).end();
			} catch (error) {
				next(translate(error));
			}
		}
	);

	/**
	 * Sync a tuner's channel lineup into the DB. Fetches the live lineup from
	 * the provider, then upserts channels by `(tunerId, number)`:
	 *   - Inserts channels present in the lineup but not yet persisted.
	 *   - Updates name / logo for channels whose details have changed.
	 *   - Retains missing sources and marks them unavailable after repeated misses.
	 *
	 * Existing channel UUIDs and EPG mappings are preserved so callers are
	 * not disrupted by re-syncing. The manual action always bypasses the
	 * provider's lineup cache.
	 */
	router.post(
		"/tuners/:id/sync",
		validate({ params: tunerIdParamSchema }),
		async (req, res, next) => {
			try {
				const tunerId = req.params["id"] as string;
				const result = await lineupSyncService.syncTuner(tunerId, {
					forceRefresh: true
				});
				res.json(tunerSyncResponseSchema.parse(result));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	return router;
}

function translate(error: unknown): unknown {
	if (error instanceof TunerNotFoundError) {
		return new HttpError(404, "not_found", error.message);
	}
	if (error instanceof UnsupportedTunerKindError) {
		return new HttpError(400, "bad_request", error.message);
	}
	if (error instanceof TunerUnavailableError) {
		return new HttpError(409, TUNER_UNAVAILABLE_ERROR_CODE, error.message, {
			conflicts: error.conflicts
		});
	}
	return error;
}
