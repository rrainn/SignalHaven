import type {
	Tuner,
	TunerCapabilities,
	TunerDiscoveryResult,
	TunerKind,
	TunerLineupChannel,
	TunerStatus,
	TunerStreamOptions,
	TunerStreamUrl
} from "@signalhaven/shared";

/**
 * Common abstraction over every tuner backend (HDHomeRun, IPTV/M3U,
 * generic HLS, ...). The rest of the system (recordings, EPG, streaming)
 * depends only on this surface so adding a new tuner kind is a matter of
 * implementing it and registering a factory with `TunerRegistry`.
 *
 * Implementations are expected to be cheap to construct (heavy network
 * work belongs in the methods below, not the constructor) so the registry
 * can hydrate one per DB row at startup.
 */
export interface TunerProvider {
	/** Stable id of the persisted tuner row this instance was hydrated from. */
	readonly id: string;
	/** Discriminator matching `tunerKindSchema`. */
	readonly kind: TunerKind;

	/** Returns this provider's static capabilities. */
	getCapabilities(): TunerCapabilities;

	/** Returns the channel lineup advertised by the tuner. */
	getLineup(): Promise<TunerLineupChannel[]>;

	/** Invalidates any cached lineup before an explicit or scheduled import. */
	refreshLineup?(): void;

	/**
	 * Resolves a playable stream URL for the given channel id (as returned
	 * by `getLineup()`). Options are advisory; providers may ignore unknown
	 * fields.
	 */
	getStreamUrl(
		channelId: string,
		options?: TunerStreamOptions
	): Promise<TunerStreamUrl>;

	/** Live status (online/offline + optional message). */
	getStatus(): Promise<TunerStatus>;

	/** Best-effort RF metrics for an actively tuned channel, when supported. */
	getChannelQuality?(
		channelNumber: string
	): Promise<TunerChannelQuality | null>;

	/**
	 * Optional guide endpoint resolver. Providers with rotating credentials
	 * must fetch a fresh credential on every call and must never persist it.
	 */
	getGuideUrl?(): Promise<string>;

	/**
	 * Optional: fetch the channel logo so the API layer can re-serve it from
	 * the same origin as the UI (avoiding mixed-content issues when the
	 * playlist references HTTP image URLs from an HTTPS UI). Returns `null`
	 * when the channel has no logo or the upstream fetch failed; callers
	 * should treat both as "no logo available". Providers without remote
	 * logos may omit this method entirely.
	 */
	getLogo?(channelId: string): Promise<TunerLogo | null>;
}

/** Provider-neutral signal measurements exposed to advanced diagnostics. */
export interface TunerChannelQuality {
	tunerIndex: number;
	lock?: string;
	signalStrengthPercent?: number;
	signalQualityPercent?: number;
	symbolQualityPercent?: number;
	networkRateMbps?: number;
}

/** Bytes + metadata returned by {@link TunerProvider.getLogo}. */
export interface TunerLogo {
	body: Buffer;
	contentType: string;
	/** Suggested `Cache-Control: max-age` value, in seconds. */
	cacheMaxAgeSeconds: number;
}

/**
 * Per-kind factory + discovery entry point.
 *
 * Discovery is exposed on the factory rather than the provider instance
 * because it does not require an existing DB row.
 */
export interface TunerProviderFactory {
	readonly kind: TunerKind;
	/**
	 * Hydrate a provider instance from a persisted tuner row. The factory is
	 * responsible for narrowing `row.config` to its own shape; throwing on
	 * malformed config keeps a corrupted row from poisoning the registry.
	 */
	create(row: Tuner): TunerProvider;
	/** Auto-discover candidate tuners of this kind. */
	discover(): Promise<TunerDiscoveryResult[]>;
}

/**
 * Maps tuner `kind` -> factory and hydrates `TunerProvider` instances from
 * persisted rows. The registry is intentionally tiny: storage,
 * lifecycle, and event publishing live one layer up in `TunersService`.
 */
export class TunerRegistry {
	private readonly factories = new Map<TunerKind, TunerProviderFactory>();

	constructor(factories: TunerProviderFactory[] = []) {
		for (const factory of factories) {
			this.register(factory);
		}
	}

	register(factory: TunerProviderFactory): void {
		this.factories.set(factory.kind, factory);
	}

	has(kind: TunerKind): boolean {
		return this.factories.has(kind);
	}

	kinds(): TunerKind[] {
		return [...this.factories.keys()];
	}

	/** Hydrate a single provider from a DB row. Throws on unknown kind. */
	fromRow(row: Tuner): TunerProvider {
		const factory = this.factories.get(row.kind);
		if (!factory) {
			throw new Error(`No tuner provider registered for kind "${row.kind}"`);
		}
		return factory.create(row);
	}

	/**
	 * Run discovery against every registered factory and merge the results.
	 * Failures from individual factories are surfaced via the optional
	 * `onError` callback rather than aborting the whole sweep so one broken
	 * provider can't hide candidates from healthy ones.
	 */
	async discover(
		onError?: (kind: TunerKind, error: unknown) => void
	): Promise<TunerDiscoveryResult[]> {
		const settled = await Promise.all(
			[...this.factories.values()].map(async (factory) => {
				try {
					return await factory.discover();
				} catch (error) {
					if (onError) {
						onError(factory.kind, error);
					}
					return [] as TunerDiscoveryResult[];
				}
			})
		);

		return settled.flat();
	}
}
