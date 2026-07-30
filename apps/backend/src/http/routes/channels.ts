import {
	channelEpgMappingPutSchema,
	channelEpgMappingSchema,
	channelIdParamSchema,
	channelListSchema,
	channelMergeSchema,
	channelQualitySchema,
	channelSourceParamsSchema,
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
import {
	ChannelGroupingError,
	type ChannelsRepository
} from "../../repositories/channels.repository";

/**
 * Routes for the channel list and channel ↔ EPG mapping (rrainn/SignalHaven E3-mapping):
 *   * `GET  /api/v1/channels`                       — full channel list with tuner info and mapping status.
 *   * `GET  /api/v1/channels/:id/epg-candidates`    — ranked candidates.
 *   * `PUT  /api/v1/channels/:id/epg-mapping`       — manual override.
 */
export function createChannelsRouter(
	matcher: EpgMatcherService,
	tunersService: TunersService,
	channelsRepository: ChannelsRepository,
	onChannelsChanged?: () => void
): Router {
	const router = Router();

	/**
	 * Full channel list in canonical sort order. Joins channel rows with
	 * their owning tuner (name, kind) and EPG mapping status so the UI
	 * can render the Channels page without extra round-trips.
	 */
	router.get("/channels", async (_req, res, next) => {
		try {
			const summary = await channelsRepository.listLogicalChannelSummaries();
			const items = summary.map(toChannelListItem);
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
				const sourceId = await resolveSourceId(channelsRepository, channelId);
				const channel = await channelsRepository.getById(sourceId);
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

	router.post(
		"/channels/merge",
		validate({ body: channelMergeSchema }),
		async (req, res, next) => {
			try {
				await channelsRepository.mergeLogicalChannels(
					req.body.channelIds,
					req.body.primaryChannelId
				);
				onChannelsChanged?.();
				const items = (
					await channelsRepository.listLogicalChannelSummaries()
				).map(toChannelListItem);
				res.json(channelListSchema.parse({ items }));
			} catch (error) {
				next(translateGroupingError(error));
			}
		}
	);

	router.post(
		"/channels/:id/sources/:sourceId/split",
		validate({ params: channelSourceParamsSchema }),
		async (req, res, next) => {
			try {
				await channelsRepository.splitSource(
					req.params["id"] as string,
					req.params["sourceId"] as string
				);
				onChannelsChanged?.();
				const items = (
					await channelsRepository.listLogicalChannelSummaries()
				).map(toChannelListItem);
				res.json(channelListSchema.parse({ items }));
			} catch (error) {
				next(translateGroupingError(error));
			}
		}
	);

	router.post(
		"/channels/:id/sources/:sourceId/preferred",
		validate({ params: channelSourceParamsSchema }),
		async (req, res, next) => {
			try {
				await channelsRepository.setPreferredSource(
					req.params["id"] as string,
					req.params["sourceId"] as string
				);
				const items = (
					await channelsRepository.listLogicalChannelSummaries()
				).map(toChannelListItem);
				res.json(channelListSchema.parse({ items }));
			} catch (error) {
				next(translateGroupingError(error));
			}
		}
	);

	router.get(
		"/channels/:id/epg-candidates",
		validate({ params: channelIdParamSchema }),
		async (req, res, next) => {
			try {
				const channelId = req.params["id"] as string;
				const sourceId = await resolveSourceId(channelsRepository, channelId);
				const ranked = await matcher.getCandidates(sourceId);
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
				const sourceId = await resolveSourceId(channelsRepository, channelId);
				const stored = await matcher.setManualMapping(
					sourceId,
					req.body.epgChannelId
				);
				res.json(channelEpgMappingSchema.parse({ ...stored, channelId }));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	return router;
}

/** Resolve a logical id to its preferred physical source for source-scoped APIs. */
async function resolveSourceId(
	repository: ChannelsRepository,
	channelId: string
): Promise<string> {
	const logical = await repository.getLogicalChannelById(channelId);
	if (!logical) {
		const direct = await repository.getById(channelId);
		if (direct) return direct.id;
		throw new ChannelNotFoundError(channelId);
	}
	const sources = await repository.listSourcesByLogicalChannelId(channelId);
	const source =
		sources.find((candidate) => candidate.sourceStatus === "active") ??
		sources.find((candidate) => candidate.sourceStatus === "missing") ??
		sources[0];
	if (!source) throw new ChannelNotFoundError(channelId);
	return source.id;
}

/** Preserve the primary-source fields consumed by existing filters and diagnostics. */
function toChannelListItem(
	summary: Awaited<
		ReturnType<ChannelsRepository["listLogicalChannelSummaries"]>
	>[number]
) {
	const primary = summary.sources[0];
	return {
		id: summary.channel.id,
		number: summary.channel.number,
		name: summary.channel.name,
		logoUrl: summary.channel.logoUrl ?? null,
		tvgId: primary?.tvgId ?? null,
		tunerId: primary?.tunerId ?? summary.channel.id,
		tunerName: primary?.tunerName ?? "No source",
		tunerKind: primary?.tunerKind ?? "hdhomerun",
		enabled: summary.channel.enabled,
		sortOrder: summary.channel.sortOrder,
		hasMapping: summary.mappedEpgChannelId !== null,
		sources: summary.sources.map((source, index) => ({
			id: source.id,
			tunerId: source.tunerId,
			tunerName: source.tunerName,
			tunerKind: source.tunerKind,
			number: source.number,
			name: source.name,
			status: source.sourceStatus,
			priority: source.sourcePriority,
			preferred: index === 0
		})),
		availableSourceCount: summary.sources.filter(
			(source) => source.sourceStatus !== "unavailable" && source.enabled
		).length
	};
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

/** Grouping failures are actionable validation conflicts, not server faults. */
function translateGroupingError(error: unknown): unknown {
	if (error instanceof ChannelGroupingError) {
		return new HttpError(409, "channel_group_conflict", error.message);
	}
	return error;
}
