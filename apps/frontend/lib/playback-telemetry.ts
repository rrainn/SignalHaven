import type { PlaybackTelemetryEvent } from "@signalhaven/shared";

/** Send bounded QoE observations without letting telemetry interrupt playback. */
export function reportPlaybackTelemetry(event: PlaybackTelemetryEvent): void {
	void fetch("/api/v1/playback/telemetry", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
		keepalive: true
	}).catch(() => undefined);
}
