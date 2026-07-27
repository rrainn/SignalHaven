import {
	hlsConfigSchema,
	type Tuner,
	type TunerCapabilities,
	type TunerDiscoveryResult,
	type TunerLineupChannel,
	type TunerStatus,
	type TunerStreamOptions,
	type TunerStreamUrl
} from "@signalhaven/shared";

import type { TunerProvider, TunerProviderFactory } from "../provider";

/**
 * Generic single-stream HLS provider: one configured `.m3u8` URL maps to a
 * single virtual channel. Useful for ad-hoc IP cameras or one-off live
 * streams where M3U/IPTV would be overkill.
 */
class HlsProvider implements TunerProvider {
	readonly kind = "hls" as const;
	readonly id: string;
	private readonly url: string;
	private readonly channelName: string;

	constructor(row: Tuner) {
		const config = hlsConfigSchema.parse(row.config);
		this.id = row.id;
		this.url = config.url;
		this.channelName = config.channelName ?? row.name;
	}

	getCapabilities(): TunerCapabilities {
		return { supportsTranscoding: false, concurrentStreams: 1 };
	}

	async getLineup(): Promise<TunerLineupChannel[]> {
		return [
			{
				channelId: "1",
				number: "1",
				name: this.channelName
			}
		];
	}

	async getStreamUrl(
		_channelId: string,
		_options?: TunerStreamOptions
	): Promise<TunerStreamUrl> {
		return { url: this.url };
	}

	async getStatus(): Promise<TunerStatus> {
		return { online: true, checkedAt: new Date().toISOString() };
	}
}

export const hlsFactory: TunerProviderFactory = {
	kind: "hls",
	create(row) {
		return new HlsProvider(row);
	},
	async discover(): Promise<TunerDiscoveryResult[]> {
		return [];
	}
};
