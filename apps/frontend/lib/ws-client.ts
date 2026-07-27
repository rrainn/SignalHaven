"use client";

import {
	serverMessageSchema,
	type EventMessage,
	type EventTopic
} from "@signalhaven/shared";
import { useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "./api-client";

/**
 * Minimal client for the WS event bus mounted at `/api/v1/events`.
 *
 * - Subscribes to the requested topics on `open`.
 * - Re-subscribes after reconnect.
 * - Validates inbound messages against the shared {@link serverMessageSchema}.
 *
 * Designed to stay tiny — one socket per consumer is fine while we have a
 * single live consumer (the onboarding wizard). Long-lived screens should
 * eventually multiplex through a shared provider; that is out of scope here.
 */

export type WsClientStatus = "connecting" | "open" | "closed";

export type WsClientOptions = {
	topics: EventTopic[];
	onEvent?: (event: EventMessage) => void;
	/** Called after a disconnected socket successfully reconnects. */
	onReconnect?: (() => void) | undefined;
	/** When false, the socket is not opened (e.g. during SSR or tests). */
	enabled?: boolean;
	/**
	 * Optional override of the WS URL. When omitted we resolve it from
	 * {@link API_BASE_URL} (or the current page origin in the browser).
	 */
	url?: string | undefined;
};

function resolveWsUrl(override?: string): string {
	if (override) return override;
	// Same-origin in the browser; deliberately no-op when window is missing
	// (SSR / tests without jsdom). Callers gate connect with `enabled`.
	const base =
		API_BASE_URL ||
		(typeof window !== "undefined" ? window.location.origin : "");
	if (!base) return "/api/v1/events";
	const httpUrl = new URL("/api/v1/events", base);
	httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
	return httpUrl.toString();
}

/**
 * Open a WS connection to the SignalHaven event bus and pipe matching events into
 * the supplied callback. The hook reconnects with linear backoff (capped at
 * 5 seconds) and tears the socket down on unmount.
 */
export function useWebSocketEvents(options: WsClientOptions): WsClientStatus {
	const { topics, onEvent, onReconnect, enabled = true, url } = options;
	const [status, setStatus] = useState<WsClientStatus>(
		enabled ? "connecting" : "closed"
	);

	// Keep the latest callback / topic list in refs so we don't need to tear
	// the socket down whenever a parent re-renders with a new function.
	const onEventRef = useRef(onEvent);
	onEventRef.current = onEvent;
	const onReconnectRef = useRef(onReconnect);
	onReconnectRef.current = onReconnect;
	const topicsKey = topics.slice().sort().join(",");

	useEffect(() => {
		if (!enabled) {
			setStatus("closed");
			return;
		}
		if (typeof WebSocket === "undefined") {
			setStatus("closed");
			return;
		}

		let socket: WebSocket | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let attempt = 0;
		let cancelled = false;
		let openedOnce = false;

		const connect = () => {
			setStatus("connecting");
			try {
				socket = new WebSocket(resolveWsUrl(url));
			} catch {
				scheduleReconnect();
				return;
			}

			socket.addEventListener("open", () => {
				const reconnected = openedOnce;
				openedOnce = true;
				attempt = 0;
				setStatus("open");
				socket?.send(
					JSON.stringify({ type: "subscribe", topics: topicsKey.split(",") })
				);
				if (reconnected) onReconnectRef.current?.();
			});

			socket.addEventListener("message", (ev) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(ev.data));
				} catch {
					return;
				}
				const result = serverMessageSchema.safeParse(parsed);
				if (!result.success) return;
				if (result.data.type === "event") {
					onEventRef.current?.(result.data);
				}
			});

			socket.addEventListener("close", () => {
				setStatus("closed");
				if (!cancelled) scheduleReconnect();
			});

			// Errors trigger a `close`; no extra handling required.
			socket.addEventListener("error", () => {
				try {
					socket?.close();
				} catch {
					// Already closed; ignore.
				}
			});
		};

		const scheduleReconnect = () => {
			if (cancelled) return;
			attempt += 1;
			const delay = Math.min(5000, 500 * attempt);
			reconnectTimer = setTimeout(connect, delay);
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			try {
				socket?.close();
			} catch {
				// Already closed during teardown; ignore.
			}
		};
	}, [enabled, topicsKey, url]);

	return status;
}
