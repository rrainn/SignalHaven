import {
	channelEpgMappingPutSchema,
	channelEpgMappingSchema,
	channelIdParamSchema,
	channelListSchema,
	channelQualitySchema,
	epgCandidatesResponseSchema
} from "@signalhaven/shared";
import { Router } from "express";

import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";
import {
	ChannelNotFoundError,
	EpgChannelNotFoundError,
	type EpgMatcherService
} from "../../epg/epg-matcher.service";
import type { TunersService } from "../../tuners/tuners.service";
import type { ChannelsRepository } from "../../repositories/channels.repository";

/**
 * Routes for the channel list and channel ↔ EPG mapping (rrainn/SignalHaven E3-mapping):
 *   * `GET  /api/v1/channels`                       — full channel list with tuner info and mapping status.
 *   * `GET  /api/v1/channels/:id/epg-candidates`    — ranked candidates.
 *   * `PUT  /api/v1/channels/:id/epg-mapping`       — manual override.
 */
export function createChannelsRouter(
	matcher: EpgMatcherService,
	tunersService: TunersService,
	channelsRepository: ChannelsRepository
): Router {
	const router = Router();

	/**
	 * Full channel list in canonical sort order. Joins channel rows with
	 * their owning tuner (name, kind) and EPG mapping status so the UI
	 * can render the Channels page without extra round-trips.
	 */
	router.get("/channels", async (_req, res, next) => {
		try {
			const [summary, tuners] = await Promise.all([
				matcher.listChannelsSummary(),
				tunersService.list()
			]);
			const tunerById = new Map(tuners.map((t) => [t.id, t]));
			const items = summary.map(({ channel, mappedEpgChannelId }) => {
				const tuner = tunerById.get(channel.tunerId);
				return {
					id: channel.id,
					number: channel.number,
					name: channel.name,
					logoUrl: channel.logoUrl ?? null,
					tvgId: channel.tvgId ?? null,
					tunerId: channel.tunerId,
					tunerName: tuner?.name ?? "",
					tunerKind: tuner?.kind ?? "hdhomerun",
					enabled: channel.enabled,
					sortOrder: channel.sortOrder,
					hasMapping: mappedEpgChannelId !== null
				};
			});
			res.json(channelListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	router.get(
		"/channels/:id/quality",
		validate({ params: channelIdParamSchema }),
		async (req, res, next) => {
			try {
				const channelId = req.params["id"] as string;
				const channel = await channelsRepository.getById(channelId);
				if (!channel) throw new ChannelNotFoundError(channelId);
				const provider = await tunersService.getProviderById(channel.tunerId);
				const metrics = await provider.getChannelQuality?.(
					channel.providerChannelId ?? channel.number
				);
				res.setHeader("Cache-Control", "no-store");
				res.json(
					channelQualitySchema.parse({
						channelId,
						active: Boolean(metrics),
						checkedAt: new Date().toISOString(),
						...(metrics ?? {})
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.get(
		"/channels/:id/epg-candidates",
		validate({ params: channelIdParamSchema }),
		async (req, res, next) => {
			try {
				const channelId = req.params["id"] as string;
				const ranked = await matcher.getCandidates(channelId);
				res.json(
					epgCandidatesResponseSchema.parse({
						channelId,
						candidates: ranked.map((entry) => ({
							epgChannelId: entry.epgChannel.id,
							sourceId: entry.epgChannel.sourceId,
							externalId: entry.epgChannel.externalId,
							displayName: entry.epgChannel.displayName,
							strategy: entry.strategy,
							score: entry.score
						}))
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.put(
		"/channels/:id/epg-mapping",
		validate({
			params: channelIdParamSchema,
			body: channelEpgMappingPutSchema
		}),
		async (req, res, next) => {
			try {
				const channelId = req.params["id"] as string;
				const stored = await matcher.setManualMapping(
					channelId,
					req.body.epgChannelId
				);
				res.json(channelEpgMappingSchema.parse(stored));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	return router;
}

function translate(error: unknown): unknown {
	if (error instanceof ChannelNotFoundError) {
		return new HttpError(404, "not_found", error.message);
	}
	if (error instanceof EpgChannelNotFoundError) {
		return new HttpError(404, "not_found", error.message);
	}
	return error;
}
