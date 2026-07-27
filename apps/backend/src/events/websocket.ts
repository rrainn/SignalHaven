import type { IncomingMessage, Server as HttpServer } from "node:http";

import {
	clientMessageSchema,
	type EventTopic,
	type ServerMessage
} from "@signalhaven/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { type EventBus, type PublishedEvent } from "./event-bus";

export const EVENTS_PATH = "/api/v1/events";

/** Heartbeat ping interval in milliseconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Max queued (not yet flushed) events per client before we drop oldest. */
export const DEFAULT_CLIENT_BUFFER_LIMIT = 256;

/** Threshold (bytes) above which we stop pushing to the socket buffer. */
const DEFAULT_SOCKET_HIGH_WATER_MARK = 1024 * 1024;

export interface AttachEventsWebSocketOptions {
	server: HttpServer;
	bus: EventBus;
	/** Override for tests. */
	heartbeatIntervalMs?: number;
	/** Override for tests. */
	clientBufferLimit?: number;
	/** Override for tests; threshold beyond which we stop draining the outbox. */
	socketHighWaterMark?: number;
	path?: string;
}

interface ClientState {
	socket: WebSocket;
	isAlive: boolean;
	subscriptions: Set<EventTopic>;
	/** Pending pre-serialized payloads waiting for the socket buffer to drain. */
	outbox: string[];
	/** Max queued payloads before oldest are dropped. */
	bufferLimit: number;
	/** Per-socket bufferedAmount threshold above which we pause draining. */
	highWaterMark: number;
}

export interface AttachedWebSocketServer {
	wss: WebSocketServer;
	close: () => Promise<void>;
}

/**
 * Mounts the topic-based WebSocket event bus at `options.path`
 * (defaulting to `/api/v1/events`) on the provided HTTP server.
 *
 * Protocol (JSON, one message per WS frame):
 *   client -> server:
 *     { type: "subscribe",   topics: ["recordings", ...] }
 *     { type: "unsubscribe", topics: ["recordings", ...] }
 *     { type: "ping" }
 *   server -> client:
 *     { type: "ack",   action: "subscribe" | "unsubscribe", topics: [...] }
 *     { type: "event", topic, event, data, ts }
 *     { type: "error", code, message }
 *     { type: "pong" }
 *
 * Heartbeats use the WS-level ping/pong frames every
 * `heartbeatIntervalMs` (default 30s); clients that miss a round-trip are
 * disconnected. Per-client backpressure is bounded: if more than
 * `clientBufferLimit` events queue up, the oldest are dropped first.
 *
 * Performance: the WS layer subscribes to the EventBus once per topic, so a
 * published event is serialized exactly once and the same string is sent to
 * every subscribed client. Topics with zero subscribers are not subscribed
 * to, so publishers short-circuit via `EventBus.hasSubscribers`.
 */
export function attachEventsWebSocket(
	options: AttachEventsWebSocketOptions
): AttachedWebSocketServer {
	const {
		server,
		bus,
		heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
		clientBufferLimit = DEFAULT_CLIENT_BUFFER_LIMIT,
		socketHighWaterMark = DEFAULT_SOCKET_HIGH_WATER_MARK,
		path = EVENTS_PATH
	} = options;

	const wss = new WebSocketServer({ server, path });
	const clients = new Map<WebSocket, ClientState>();
	const subscribersByTopic = new Map<EventTopic, Set<ClientState>>();
	const busUnsubscribers = new Map<EventTopic, () => void>();

	const subscribeTopic = (state: ClientState, topic: EventTopic): void => {
		if (state.subscriptions.has(topic)) {
			return;
		}
		state.subscriptions.add(topic);
		let bucket = subscribersByTopic.get(topic);
		if (!bucket) {
			bucket = new Set();
			subscribersByTopic.set(topic, bucket);
			// First subscriber for this topic: register a single bus listener and
			// fan out one serialization to every interested client.
			const off = bus.subscribe(topic, (event: PublishedEvent) => {
				const serialized = JSON.stringify(toEnvelope(event));
				const current = subscribersByTopic.get(topic);
				if (!current) {
					return;
				}
				for (const recipient of current) {
					enqueue(recipient, serialized);
				}
			});
			busUnsubscribers.set(topic, off);
		}
		bucket.add(state);
	};

	const unsubscribeTopic = (state: ClientState, topic: EventTopic): boolean => {
		if (!state.subscriptions.delete(topic)) {
			return false;
		}
		const bucket = subscribersByTopic.get(topic);
		if (!bucket) {
			return true;
		}
		bucket.delete(state);
		if (bucket.size === 0) {
			subscribersByTopic.delete(topic);
			const off = busUnsubscribers.get(topic);
			if (off) {
				busUnsubscribers.delete(topic);
				off();
			}
		}
		return true;
	};

	wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
		const state: ClientState = {
			socket,
			isAlive: true,
			subscriptions: new Set(),
			outbox: [],
			bufferLimit: clientBufferLimit,
			highWaterMark: socketHighWaterMark
		};
		clients.set(socket, state);

		socket.on("pong", () => {
			state.isAlive = true;
		});

		socket.on("message", (raw: RawData) => {
			handleClientMessage(state, raw, subscribeTopic, unsubscribeTopic);
		});

		const cleanup = (): void => {
			for (const topic of [...state.subscriptions]) {
				unsubscribeTopic(state, topic);
			}
			state.outbox.length = 0;
			clients.delete(socket);
		};

		socket.on("close", cleanup);

		socket.on("error", () => {
			try {
				socket.terminate();
			} catch {
				// ignore
			}
		});
	});

	const heartbeat = setInterval(() => {
		for (const state of clients.values()) {
			if (!state.isAlive) {
				try {
					state.socket.terminate();
				} catch {
					// ignore
				}
				continue;
			}
			state.isAlive = false;
			try {
				state.socket.ping();
			} catch {
				try {
					state.socket.terminate();
				} catch {
					// ignore
				}
			}
		}
	}, heartbeatIntervalMs);
	if (typeof heartbeat.unref === "function") {
		heartbeat.unref();
	}

	wss.on("close", () => {
		clearInterval(heartbeat);
	});

	const close = async (): Promise<void> => {
		clearInterval(heartbeat);
		for (const off of busUnsubscribers.values()) {
			off();
		}
		busUnsubscribers.clear();
		subscribersByTopic.clear();
		for (const state of clients.values()) {
			try {
				state.socket.terminate();
			} catch {
				// ignore
			}
		}
		clients.clear();
		await new Promise<void>((resolve, reject) => {
			wss.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	};

	return { wss, close };
}

function handleClientMessage(
	state: ClientState,
	raw: RawData,
	subscribeTopic: (state: ClientState, topic: EventTopic) => void,
	unsubscribeTopic: (state: ClientState, topic: EventTopic) => boolean
): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString());
	} catch {
		sendServerMessage(state, {
			type: "error",
			code: "invalid_json",
			message: "Message must be valid JSON"
		});
		return;
	}

	const result = clientMessageSchema.safeParse(parsed);
	if (!result.success) {
		sendServerMessage(state, {
			type: "error",
			code: "invalid_message",
			message: "Unrecognized or malformed message"
		});
		return;
	}

	const message = result.data;
	switch (message.type) {
		case "subscribe": {
			for (const topic of message.topics) {
				subscribeTopic(state, topic);
			}
			sendServerMessage(state, {
				type: "ack",
				action: "subscribe",
				topics: [...message.topics]
			});
			return;
		}
		case "unsubscribe": {
			const removed: EventTopic[] = [];
			for (const topic of message.topics) {
				if (unsubscribeTopic(state, topic)) {
					removed.push(topic);
				}
			}
			sendServerMessage(state, {
				type: "ack",
				action: "unsubscribe",
				topics: removed
			});
			return;
		}
		case "ping": {
			sendServerMessage(state, { type: "pong" });
			return;
		}
	}
}

function toEnvelope(event: PublishedEvent): ServerMessage {
	return {
		type: "event",
		topic: event.topic,
		event: event.event,
		data: event.data,
		ts: new Date().toISOString()
	};
}

function sendServerMessage(state: ClientState, message: ServerMessage): void {
	enqueue(state, JSON.stringify(message));
}

function enqueue(state: ClientState, serialized: string): void {
	if (state.socket.readyState !== WebSocket.OPEN) {
		return;
	}

	// Backpressure: drop oldest queued events if buffer exceeds limit.
	state.outbox.push(serialized);
	while (state.outbox.length > state.bufferLimit) {
		state.outbox.shift();
	}

	flushOutbox(state);
}

function flushOutbox(state: ClientState): void {
	while (
		state.outbox.length > 0 &&
		state.socket.readyState === WebSocket.OPEN &&
		state.socket.bufferedAmount < state.highWaterMark
	) {
		const next = state.outbox.shift();
		if (next === undefined) {
			return;
		}
		try {
			state.socket.send(next, (err) => {
				if (!err && state.outbox.length > 0) {
					flushOutbox(state);
				}
			});
		} catch {
			// If send throws synchronously, drop the message; the close/error
			// handler will tear down the client.
			return;
		}
	}
}
