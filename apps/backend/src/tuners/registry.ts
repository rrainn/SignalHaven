import { TunerRegistry } from "./provider";
import { hdhomerunFactory } from "./providers/hdhomerun";
import { hlsFactory } from "./providers/hls";
import { iptvFactory } from "./providers/iptv";

/**
 * Builds the default tuner registry with every provider kind shipped with
 * the application registered. Tests construct their own `TunerRegistry`
 * with a mock provider rather than mutating the default registry.
 */
export function createDefaultTunerRegistry(): TunerRegistry {
	return new TunerRegistry([hdhomerunFactory, iptvFactory, hlsFactory]);
}
