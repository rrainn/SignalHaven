/**
 * Channel ↔ EPG mapping orchestration (rrainn/SignalHaven E3-mapping).
 *
 * Wraps the pure ranking helpers in `./channel-matching` with database
 * I/O so the HTTP layer and the post-refresh hook can both:
 *   * compute ranked candidates for a single channel (for the UI), and
 *   * persist auto-matches for unmapped channels without ever
 *     overwriting a manual override.
 */

import type { EventBus } from "../events/event-bus";
import type { ChannelEpgMapRepository } from "../repositories/channel-epg-map.repository";
import type {
	ChannelRecord,
	ChannelsRepository
} from "../repositories/channels.repository";
import type {
	EpgChannelRecord,
	EpgChannelsRepository
} from "../repositories/epg-channels.repository";
import type {
	EpgSourceRecord,
	EpgSourcesRepository
} from "../repositories/epg-sources.repository";

import {
	rankEpgCandidates,
	type MatchableChannel,
	type MatchableEpgChannel,
	type RankedEpgCandidate
} from "./channel-matching";

export class ChannelNotFoundError extends Error {
	constructor(id: string) {
		super(`Channel ${id} not found`);
		this.name = "ChannelNotFoundError";
	}
}

export class EpgChannelNotFoundError extends Error {
	constructor(id: string) {
		super(`EPG channel ${id} not found`);
		this.name = "EpgChannelNotFoundError";
	}
}

export interface EpgMatcherOptions {
	channelsRepository: ChannelsRepository;
	epgChannelsRepository: EpgChannelsRepository;
	epgSourcesRepository: EpgSourcesRepository;
	channelEpgMapRepository: ChannelEpgMapRepository;
	bus?: EventBus;
	/** Invalidates cached Guide mappings after persistence changes. */
	onMappingsChanged?: () => void;
}

export interface AutoMatchSummary {
	/** Channels considered (i.e. unmapped or only auto-mapped). */
	considered: number;
	/** Channels for which an auto-match was upserted. */
	matched: number;
}

export class EpgMatcherService {
	private readonly channels: ChannelsRepository;
	private readonly epgChannels: EpgChannelsRepository;
	private readonly epgSources: EpgSourcesRepository;
	private readonly map: ChannelEpgMapRepository;
	private readonly bus: EventBus | undefined;
	private readonly onMappingsChanged: (() => void) | undefined;

	constructor(options: EpgMatcherOptions) {
		this.channels = options.channelsRepository;
		this.epgChannels = options.epgChannelsRepository;
		this.epgSources = options.epgSourcesRepository;
		this.map = options.channelEpgMapRepository;
		this.bus = options.bus;
		this.onMappingsChanged = options.onMappingsChanged;
	}

	/**
	 * Compute ranked EPG candidates for a single channel. Throws
	 * {@link ChannelNotFoundError} if the channel id is unknown.
	 */
	async getCandidates(channelId: string): Promise<RankedEpgCandidate[]> {
		const channel = await this.channels.getById(channelId);
		if (!channel) {
			throw new ChannelNotFoundError(channelId);
		}
		const [epgChannels, epgSources] = await Promise.all([
			this.epgChannels.list(),
			this.epgSources.list()
		]);
		return rankEpgCandidates(
			toMatchableChannel(channel),
			eligibleEpgChannels(channel, epgChannels, epgSources).map(
				toMatchableEpgChannel
			)
		);
	}

	/**
	 * Persist a manual mapping, overriding any existing auto-match. The
	 * `manual` flag is set so subsequent EPG refreshes leave it alone.
	 */
	async setManualMapping(
		channelId: string,
		epgChannelId: string
	): Promise<{ channelId: string; epgChannelId: string; manual: true }> {
		const channel = await this.channels.getById(channelId);
		if (!channel) {
			throw new ChannelNotFoundError(channelId);
		}
		const epgChannel = await this.epgChannels.getById(epgChannelId);
		if (!epgChannel) {
			throw new EpgChannelNotFoundError(epgChannelId);
		}
		const stored = await this.map.upsert(channelId, epgChannelId, true);
		this.onMappingsChanged?.();
		if (this.bus) {
			this.bus.publish({
				topic: "epg",
				event: "mapping.updated",
				data: {
					channelId: stored.channelId,
					epgChannelId: stored.epgChannelId,
					manual: true,
					source: "manual"
				}
			});
		}
		return {
			channelId: stored.channelId,
			epgChannelId: stored.epgChannelId,
			manual: true
		};
	}

	/**
	 * Walk every channel, and for each one that is currently unmapped (or
	 * only auto-mapped) compute the best candidate and persist it as an
	 * auto-match. Channels with `manual = true` mappings are skipped — the
	 * auto-matcher MUST NOT overwrite them.
	 */
	async autoMatchUnmapped(): Promise<AutoMatchSummary> {
		const [channels, epgChannels, epgSources, mappings] = await Promise.all([
			this.channels.list(),
			this.epgChannels.list(),
			this.epgSources.list(),
			this.map.list()
		]);
		const mappingByChannel = new Map(
			mappings.map((row) => [row.channelId, row])
		);

		const summary: AutoMatchSummary = { considered: 0, matched: 0 };
		let mappingsChanged = false;
		try {
			for (const channel of channels) {
				const existing = mappingByChannel.get(channel.id);
				if (existing?.manual) {
					// Manual override — leave alone.
					continue;
				}
				summary.considered += 1;
				const matchableEpg = eligibleEpgChannels(
					channel,
					epgChannels,
					epgSources
				).map(toMatchableEpgChannel);
				const ranked = rankEpgCandidates(
					toMatchableChannel(channel),
					matchableEpg
				);
				const best = ranked[0];
				if (!best) {
					if (existing) {
						await this.map.deleteByChannelId(channel.id);
						mappingsChanged = true;
					}
					continue;
				}
				if (existing && existing.epgChannelId === best.epgChannel.id) {
					// Already auto-mapped to the same EPG channel; nothing to do.
					continue;
				}
				const stored = await this.map.upsert(
					channel.id,
					best.epgChannel.id,
					false
				);
				mappingsChanged = true;
				summary.matched += 1;
				if (this.bus) {
					this.bus.publish({
						topic: "epg",
						event: "mapping.updated",
						data: {
							channelId: stored.channelId,
							epgChannelId: stored.epgChannelId,
							manual: false,
							source: "auto",
							strategy: best.strategy,
							score: best.score
						}
					});
				}
			}
			return summary;
		} finally {
			// Partial auto-match runs still invalidate rows changed before a failure.
			if (mappingsChanged) {
				this.onMappingsChanged?.();
			}
		}
	}

	/**
	 * Returns every channel together with its mapped EPG channel id (or
	 * `null` when unmapped). Ordered by `sortOrder` ascending, matching
	 * the canonical order used by the guide grid. Used by the
	 * `GET /api/v1/channels` list endpoint to build the full channel-list
	 * response without requiring direct repository access in the HTTP layer.
	 */
	async listChannelsSummary(): Promise<
		{ channel: ChannelRecord; mappedEpgChannelId: string | null }[]
	> {
		const [allChannels, mappings] = await Promise.all([
			this.channels.list(),
			this.map.list()
		]);
		const epgIdByChannelId = new Map(
			mappings.map((m) => [m.channelId, m.epgChannelId])
		);
		const sorted = allChannels.sort((a, b) => a.sortOrder - b.sortOrder);
		return sorted.map((channel) => ({
			channel,
			mappedEpgChannelId: epgIdByChannelId.get(channel.id) ?? null
		}));
	}
}

/**
 * Keeps automatic matching inside a tuner's configured guide. Tuners without
 * an owned source retain compatibility with manually added shared XMLTV feeds.
 */
function eligibleEpgChannels(
	channel: ChannelRecord,
	epgChannels: readonly EpgChannelRecord[],
	epgSources: readonly EpgSourceRecord[]
): EpgChannelRecord[] {
	const enabledSources = epgSources.filter((source) => source.enabled);
	const ownedSourceIds = new Set(
		enabledSources
			.filter((source) => source.tunerId === channel.tunerId)
			.map((source) => source.id)
	);
	const eligibleSourceIds =
		ownedSourceIds.size > 0
			? ownedSourceIds
			: new Set(
					enabledSources
						.filter((source) => source.tunerId === null)
						.map((source) => source.id)
				);
	return epgChannels.filter((epgChannel) =>
		eligibleSourceIds.has(epgChannel.sourceId)
	);
}

function toMatchableChannel(row: ChannelRecord): MatchableChannel {
	return {
		id: row.id,
		number: row.number,
		name: row.name,
		tvgId: row.tvgId ?? null
	};
}

function toMatchableEpgChannel(row: EpgChannelRecord): MatchableEpgChannel {
	return {
		id: row.id,
		sourceId: row.sourceId,
		externalId: row.externalId,
		displayName: row.displayName,
		// Migration backfills aliases; the fallback keeps stale test rows safe.
		displayNames:
			row.displayNames.length > 0 ? row.displayNames : [row.displayName]
	};
}

export type { RankedEpgCandidate, MatchStrategy } from "./channel-matching";
