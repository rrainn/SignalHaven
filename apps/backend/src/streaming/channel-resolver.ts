import type { ChannelsRepository } from "../repositories/channels.repository";
import type { TunersService } from "../tuners/tuners.service";

import {
	ChannelNotStreamableError,
	type ResolvedStreamSource,
	type StreamSourceResolver
} from "./streaming.service";

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
		const row = await this.channels.getById(channelId);
		if (!row) {
			throw new ChannelNotStreamableError(
				channelId,
				`Channel ${channelId} not found`
			);
		}
		if (!row.enabled) {
			throw new ChannelNotStreamableError(
				channelId,
				`Channel ${channelId} is disabled`
			);
		}
		const provider = await this.tuners.getProviderById(row.tunerId);

		let providerChannelId = row.providerChannelId ?? row.number;
		try {
			const lineup = await provider.getLineup();
			const match = lineup.find(
				(entry) =>
					entry.channelId === row.providerChannelId ||
					entry.number === row.number
			);
			if (match) {
				providerChannelId = match.channelId;
			}
		} catch {
			// The persisted provider id remains usable if lineup lookup is transiently down.
		}

		const stream = await provider.getStreamUrl(providerChannelId);
		return {
			providerId: row.tunerId,
			providerChannelId,
			upstreamUrl: stream.url
		};
	}
}
