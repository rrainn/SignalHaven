import type {
	ChannelRecord,
	ChannelsRepository
} from "../repositories/channels.repository";
import {
	TunerNotFoundError,
	type TunersService,
	UnsupportedTunerKindError
} from "../tuners/tuners.service";

import {
	ChannelNotStreamableError,
	type ResolvedStreamSource,
	type StreamSourceResolver
} from "./streaming.service";

/**
 * Resolve one persisted source using the same lineup reconciliation used by
 * live playback. Diagnostics call this helper so the URL they show cannot
 * drift from the URL the streaming pipeline would open.
 */
export async function resolvePersistedChannelSource(
	row: ChannelRecord,
	tuners: TunersService
): Promise<ResolvedStreamSource> {
	const provider = await tuners.getProviderById(row.tunerId);
	let providerChannelId = row.providerChannelId ?? row.number;
	try {
		const lineup = await provider.getLineup();
		const match = lineup.find(
			(entry) =>
				entry.channelId === row.providerChannelId || entry.number === row.number
		);
		if (match) providerChannelId = match.channelId;
	} catch {
		// A stable provider id can remain playable during a lineup outage.
	}
	const stream = await provider.getStreamUrl(providerChannelId);
	return {
		sourceChannelId: row.id,
		providerId: row.tunerId,
		providerChannelId,
		upstreamUrl: stream.url,
		...(stream.httpHeaders ? { httpHeaders: stream.httpHeaders } : {})
	};
}

/**
 * Resolves a persisted `channels.id` UUID into the upstream coordinates the
 * `StreamingService` needs:
 *
 *   1. Look up the channel row to find its tuner and stable provider identity.
 *   2. Hydrate the matching `TunerProvider` via `TunersService`.
 *   3. Prefer the stored provider identity and use the display number only for
 *      legacy rows that have not yet been backfilled by lineup sync.
 *   4. Ask the provider for the playable upstream URL.
 */
export class DefaultChannelStreamResolver implements StreamSourceResolver {
	constructor(
		private readonly channels: ChannelsRepository,
		private readonly tuners: TunersService
	) {}

	async resolve(channelId: string): Promise<ResolvedStreamSource> {
		const [source] = await this.resolveCandidates(channelId);
		if (!source) throw new ChannelNotStreamableError(channelId);
		return source;
	}

	/** Resolve every healthy source in preference order for capacity failover. */
	async resolveCandidates(channelId: string): Promise<ResolvedStreamSource[]> {
		const directSource = await this.channels.getById(channelId);
		const logicalChannelId =
			(await this.channels.getLogicalChannelById(channelId))?.id ??
			directSource?.logicalChannelId;
		if (!logicalChannelId) {
			throw new ChannelNotStreamableError(
				channelId,
				`Channel ${channelId} not found`
			);
		}
		const logicalChannel =
			await this.channels.getLogicalChannelById(logicalChannelId);
		if (!logicalChannel?.enabled) {
			throw new ChannelNotStreamableError(
				channelId,
				`Channel ${channelId} is disabled`
			);
		}
		const sourceRows = (
			await this.channels.listSourcesByLogicalChannelId(logicalChannelId)
		)
			.filter(
				(source) => source.enabled && source.sourceStatus !== "unavailable"
			)
			.sort((left, right) => {
				// Confirmed sources lead temporarily missing ones before preference order applies.
				const statusRank = (status: typeof left.sourceStatus) =>
					status === "active" ? 0 : 1;
				return (
					statusRank(left.sourceStatus) - statusRank(right.sourceStatus) ||
					left.sourcePriority - right.sourcePriority
				);
			});
		if (sourceRows.length === 0) {
			throw new ChannelNotStreamableError(
				channelId,
				`Channel ${channelId} has no available sources`
			);
		}
		const settled = await Promise.allSettled(
			sourceRows.map((row) => resolvePersistedChannelSource(row, this.tuners))
		);
		const candidates = settled.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : []
		);
		if (candidates.length === 0) {
			// Eligible persisted sources exist, so provider failures are operational
			// outages rather than permanent channel configuration errors. Preserve
			// them so scheduled recordings can use their bounded retry policy.
			const failures = settled.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : []
			);
			if (failures.length === 1) {
				const [failure] = failures;
				throw failure instanceof Error ? failure : new Error(String(failure));
			}
			if (
				failures.every(
					(failure) =>
						failure instanceof TunerNotFoundError ||
						failure instanceof UnsupportedTunerKindError
				)
			) {
				// Multiple broken tuner references are still configuration failures.
				throw failures[0];
			}
			const details = failures
				.map((failure) =>
					failure instanceof Error ? failure.message : String(failure)
				)
				.join("; ");
			throw new Error(
				`Every source for channel ${channelId} failed to resolve: ${details}`
			);
		}
		return candidates;
	}
}
