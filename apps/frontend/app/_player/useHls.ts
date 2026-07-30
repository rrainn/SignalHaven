"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Loader hook for {@link https://github.com/video-dev/hls.js | hls.js}.
 *
 * The `~100 KB gz` of HLS.js is **only** dynamically `import()`-ed once a
 * `<Player>` component actually mounts (rrainn/SignalHaven#U6-player perf
 * requirement). The player prefers HLS.js when it is supported because its
 * transmuxer accepts streams that Safari's native HLS decoder can reject.
 *
 * The hook returns:
 *   * `Hls`         — the dynamically-loaded class, or `null` while loading.
 *   * `nativeHls`   — `true` when the browser can play `.m3u8` natively.
 *   * `loadError`   — surface for retry UX if the chunk fetch fails.
 */
export type HlsModule = (typeof import("hls.js"))["default"];

export interface UseHlsState {
	Hls: HlsModule | null;
	nativeHls: boolean;
	loadError: Error | null;
	/** Bumps when {@link reload} is invoked; used to force a re-import. */
	attempt: number;
	reload: () => void;
}

/** Detect native HLS support without instantiating any heavy module. */
export function detectNativeHls(): boolean {
	if (typeof document === "undefined") return false;
	const v = document.createElement("video");
	// Safari (desktop + iOS) returns "maybe"/"probably"; everywhere else "".
	return Boolean(v.canPlayType("application/vnd.apple.mpegurl"));
}

/**
 * Load hls.js after the player mounts. Callers use the module's capability
 * check before falling back to native HLS on older Apple platforms.
 */
export function useHls(enabled: boolean = true): UseHlsState {
	const [Hls, setHls] = useState<HlsModule | null>(null);
	const [loadError, setLoadError] = useState<Error | null>(null);
	const [attempt, setAttempt] = useState(0);
	const nativeHlsRef = useRef<boolean | null>(null);
	if (nativeHlsRef.current === null) nativeHlsRef.current = detectNativeHls();
	const nativeHls = nativeHlsRef.current;

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setLoadError(null);
		import("hls.js")
			.then((mod) => {
				if (cancelled) return;
				setHls(() => mod.default);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setLoadError(err instanceof Error ? err : new Error(String(err)));
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, attempt]);

	return {
		Hls,
		nativeHls,
		loadError,
		attempt,
		reload: () => setAttempt((n) => n + 1)
	};
}
