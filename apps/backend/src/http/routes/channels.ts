import {
	channelEpgMappingPutSchema,
	channelEpgMappingSchema,
	channelDiagnosticsSchema,
	channelIdParamSchema,
	channelListSchema,
	channelMergeSchema,
	channelQualitySchema,
	channelSourceParamsSchema,
	epgCandidatesResponseSchema
} from "@signalhaven/shared";
import { Router, type RequestHandler } from "express";

import { RemoteImageProxy } from "../../media/remote-image-proxy";
import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";
import {
	ChannelNotFoundError,
	EpgChannelNotFoundError,
	type EpgMatcherService
} from "../../epg/epg-matcher.service";
import type { TunersService } from "../../tuners/tuners.service";
import { resolvePersistedChannelSource } from "../../streaming/channel-resolver";
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
	requireAdmin: RequestHandler,
	onChannelsChanged?: () => void,
	channelLogoProxy: RemoteImageProxy = new RemoteImageProxy()
): Router {
	const router = Router();

	/**
	 * Full channel list in canonical sort order. Joins channel rows with
	 * their owning tuner (name, kind) and EPG mapping status so the UI
	 * can render the Channels page without extra round-trips.
	 */
	router.get("/channels", async (req, res, next) => {
		try {
			const summary = await channelsRepository.listLogicalChannelSummaries();
			const includeTopology = req.auth?.user.role === "admin";
			const items = summary.map((item) =>
				toChannelListItem(item, includeTopology)
			);
			res.json(channelListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	/** Resolve a logical channel and proxy its provider-owned logo bytes. */
	router.get(
		"/channels/:id/logo",
		validate({ params: channelIdParamSchema }),
		async (req, res, next) => {
			try {
				const channelId = req.params["id"] as string;
				const sourceId = await resolveSourceId(channelsRepository, channelId);
				const channel = await channelsRepository.getById(sourceId);
				if (!channel) throw new ChannelNotFoundError(channelId);
				if (!channel.logoUrl) {
					throw new HttpError(404, "not_found", "Logo not available");
				}
				const logo = await channelLogoProxy.get(channelId, channel.logoUrl);
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

	router.get(
		"/channels/:id/quality",
		requireAdmin,
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

	router.get(
		"/channels/:id/diagnostics",
		requireAdmin,
		validate({ params: channelIdParamSchema }),
		async (req, res, next) => {
			try {
				const channelId = req.params["id"] as string;
				const summaries =
					await channelsRepository.listLogicalChannelSummaries();
				const direct = await channelsRepository.getById(channelId);
				const logicalId = direct?.logicalChannelId ?? channelId;
				const summary = summaries.find((item) => item.channel.id === logicalId);
				if (!summary) throw new ChannelNotFoundError(channelId);

				// Resolve every persisted source independently so one broken fallback
				// does not hide the healthy source coordinates needed for debugging.
				const sources = await Promise.all(
					summary.sources.map(async (source, index) => {
						try {
							const resolved = await resolvePersistedChannelSource(
								source,
								tunersService
							);
							return {
								...toDiagnosticSource(source, index),
								resolvedProviderChannelId: resolved.providerChannelId,
								streamUrl: resolved.upstreamUrl,
								...(resolved.httpHeaders
									? { httpHeaders: resolved.httpHeaders }
									: {}),
								error: null
							};
						} catch (error) {
							return {
								...toDiagnosticSource(source, index),
								resolvedProviderChannelId: null,
								streamUrl: null,
								error: error instanceof Error ? error.message : String(error)
							};
						}
					})
				);

				res.setHeader("Cache-Control", "private, no-store");
				res.json(
					channelDiagnosticsSchema.parse({
						channel: {
							id: summary.channel.id,
							number: summary.channel.number,
							name: summary.channel.name,
							logoUrl: summary.channel.logoUrl ?? null,
							tvgId: summary.sources[0]?.tvgId ?? null,
							enabled: summary.channel.enabled,
							sortOrder: summary.channel.sortOrder,
							mappedEpgChannelId: summary.mappedEpgChannelId
						},
						sources,
						checkedAt: new Date().toISOString()
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post(
		"/channels/merge",
		requireAdmin,
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
				).map((item) => toChannelListItem(item, true));
				res.json(channelListSchema.parse({ items }));
			} catch (error) {
				next(translateGroupingError(error));
			}
		}
	);

	router.post(
		"/channels/:id/sources/:sourceId/split",
		requireAdmin,
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
				).map((item) => toChannelListItem(item, true));
				res.json(channelListSchema.parse({ items }));
			} catch (error) {
				next(translateGroupingError(error));
			}
		}
	);

	router.post(
		"/channels/:id/sources/:sourceId/preferred",
		requireAdmin,
		validate({ params: channelSourceParamsSchema }),
		async (req, res, next) => {
			try {
				await channelsRepository.setPreferredSource(
					req.params["id"] as string,
					req.params["sourceId"] as string
				);
				const items = (
					await channelsRepository.listLogicalChannelSummaries()
				).map((item) => toChannelListItem(item, true));
				res.json(channelListSchema.parse({ items }));
			} catch (error) {
				next(translateGroupingError(error));
			}
		}
	);

	router.get(
		"/channels/:id/epg-candidates",
		requireAdmin,
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
		requireAdmin,
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
	>[number],
	includeTopology = true
) {
	const primary = summary.sources[0];
	const availableSourceCount = summary.sources.filter(
		(source) => source.sourceStatus !== "unavailable" && source.enabled
	).length;
	const item = {
		id: summary.channel.id,
		number: summary.channel.number,
		name: summary.channel.name,
		// Provider URLs may contain credentials or private hostnames.
		logoUrl: summary.channel.logoUrl
			? `/api/v1/channels/${summary.channel.id}/logo`
			: null,
		enabled: summary.channel.enabled,
		sortOrder: summary.channel.sortOrder,
		hasMapping: summary.mappedEpgChannelId !== null,
		// Standard accounts need availability, not the underlying source count.
		availableSourceCount: includeTopology
			? availableSourceCount
			: Math.min(1, availableSourceCount)
	};
	if (!includeTopology) return item;
	return {
		...item,
		tvgId: primary?.tvgId ?? null,
		tunerId: primary?.tunerId ?? summary.channel.id,
		tunerName: primary?.tunerName ?? "No source",
		tunerKind: primary?.tunerKind ?? "hdhomerun",
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
		}))
	};
}

/** Project persisted fields that remain useful even when URL resolution fails. */
function toDiagnosticSource(
	source: Awaited<
		ReturnType<ChannelsRepository["listLogicalChannelSummaries"]>
	>[number]["sources"][number],
	index: number
) {
	return {
		id: source.id,
		tunerId: source.tunerId,
		tunerName: source.tunerName,
		tunerKind: source.tunerKind,
		number: source.number,
		name: source.name,
		logoUrl: source.logoUrl ?? null,
		tvgId: source.tvgId ?? null,
		enabled: source.enabled,
		status: source.sourceStatus,
		priority: source.sourcePriority,
		preferred: index === 0,
		storedProviderChannelId: source.providerChannelId ?? null
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
