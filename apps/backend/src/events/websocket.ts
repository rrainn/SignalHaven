import type { IncomingMessage, Server as HttpServer } from "node:http";

import {
	clientMessageSchema,
	type EventTopic,
	type ServerMessage
} from "@signalhaven/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { type EventBus, type PublishedEvent } from "./event-bus";
import type { AuthPrincipal } from "../auth/auth.service";

export const EVENTS_PATH = "/api/v1/events";

/** Heartbeat ping interval in milliseconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Max queued (not yet flushed) events per client before we drop oldest. */
export const DEFAULT_CLIENT_BUFFER_LIMIT = 256;
/** Client control frames are tiny; cap input well below the ws default. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
/** Multi-tab allowance without permitting one session to exhaust sockets. */
export const DEFAULT_CONNECTIONS_PER_SESSION = 8;
export const DEFAULT_CONNECTIONS_PER_USER = 16;
export const DEFAULT_CONNECTIONS_PER_ADDRESS = 32;
/** Process-wide guard for file descriptors and heartbeat authentication work. */
export const DEFAULT_TOTAL_CONNECTIONS = 256;
/** A count limit alone is unsafe when event payloads have variable size. */
export const DEFAULT_CLIENT_BUFFER_BYTES = 256 * 1024;

/** Threshold (bytes) above which we stop pushing to the socket buffer. */
const DEFAULT_SOCKET_HIGH_WATER_MARK = 1024 * 1024;

export interface AttachEventsWebSocketOptions {
	server: HttpServer;
	bus: EventBus;
	/** Override for tests. */
	heartbeatIntervalMs?: number;
	/** Override for tests. */
	clientBufferLimit?: number;
	/** Override for tests; maximum queued serialized bytes per client. */
	clientBufferBytes?: number;
	/** Override for tests; maximum inbound frame size. */
	maxPayloadBytes?: number;
	/** Override for tests; concurrent sockets sharing one session. */
	connectionsPerSession?: number;
	connectionsPerUser?: number;
	connectionsPerAddress?: number;
	/** Override for tests; process-wide authenticated sockets. */
	maxConnections?: number;
	/** Override for tests; threshold beyond which we stop draining the outbox. */
	socketHighWaterMark?: number;
	path?: string;
	/** Authentication runs before the WebSocket upgrade is accepted. */
	authenticate: (request: IncomingMessage) => Promise<AuthPrincipal | null>;
}

interface ClientState {
	socket: WebSocket;
	isAlive: boolean;
	subscriptions: Set<EventTopic>;
	/** Pending pre-serialized payloads waiting for the socket buffer to drain. */
	outbox: string[];
	outboxBytes: number;
	/** Max queued payloads before oldest are dropped. */
	bufferLimit: number;
	bufferBytes: number;
	/** Per-socket bufferedAmount threshold above which we pause draining. */
	highWaterMark: number;
	principal: AuthPrincipal;
	request: IncomingMessage;
	address: string;
	authenticationInFlight: boolean;
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
		clientBufferBytes = DEFAULT_CLIENT_BUFFER_BYTES,
		maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
		connectionsPerSession = DEFAULT_CONNECTIONS_PER_SESSION,
		connectionsPerUser = DEFAULT_CONNECTIONS_PER_USER,
		connectionsPerAddress = DEFAULT_CONNECTIONS_PER_ADDRESS,
		maxConnections = DEFAULT_TOTAL_CONNECTIONS,
		socketHighWaterMark = DEFAULT_SOCKET_HIGH_WATER_MARK,
		path = EVENTS_PATH
	} = options;

	const authenticatedRequests = new WeakMap<IncomingMessage, AuthPrincipal>();
	const rejectedRequests = new WeakSet<IncomingMessage>();
	const pendingReservationPrincipals = new WeakMap<
		IncomingMessage,
		AuthPrincipal
	>();
	const pendingReservationAddresses = new WeakMap<IncomingMessage, string>();
	const clients = new Map<WebSocket, ClientState>();
	const connectionsBySession = new Map<string, number>();
	const connectionsByUser = new Map<string, number>();
	const connectionsByAddress = new Map<string, number>();
	const pendingBySession = new Map<string, number>();
	const pendingByUser = new Map<string, number>();
	const pendingByAddress = new Map<string, number>();
	const pendingAuthenticationsByAddress = new Map<string, number>();
	const pendingReservations = new WeakSet<IncomingMessage>();
	let pendingConnectionTotal = 0;
	let pendingAuthenticationTotal = 0;

	/** Release a pre-upgrade reservation exactly once, including aborted handshakes. */
	const releasePendingReservation = (request: IncomingMessage): void => {
		if (!pendingReservations.delete(request)) return;
		const principal = pendingReservationPrincipals.get(request);
		if (!principal) return;
		const address = pendingReservationAddresses.get(request) ?? "unknown";
		pendingReservationPrincipals.delete(request);
		pendingReservationAddresses.delete(request);
		decrement(pendingBySession, principal.sessionId);
		decrement(pendingByUser, principal.user.id);
		decrement(pendingByAddress, address);
		pendingConnectionTotal = Math.max(0, pendingConnectionTotal - 1);
	};
	const wss = new WebSocketServer({
		server,
		path,
		maxPayload: maxPayloadBytes,
		verifyClient: (info, done) => {
			const address = clientAddress(info.req);
			const pendingAuthenticationCount =
				pendingAuthenticationsByAddress.get(address) ?? 0;
			// Bound authentication work before awaiting the database-backed session lookup.
			if (
				pendingAuthenticationCount >= connectionsPerAddress ||
				pendingAuthenticationTotal >= maxConnections
			) {
				done(false, 429, "Connection limit reached");
				return;
			}
			pendingAuthenticationsByAddress.set(
				address,
				pendingAuthenticationCount + 1
			);
			pendingAuthenticationTotal += 1;
			void options
				.authenticate(info.req)
				.then((principal) => {
					if (!principal) {
						// Complete the upgrade so browser clients can observe close 4401.
						rejectedRequests.add(info.req);
						done(true);
						return;
					}
					const sessionCount =
						(connectionsBySession.get(principal.sessionId) ?? 0) +
						(pendingBySession.get(principal.sessionId) ?? 0);
					const userCount =
						(connectionsByUser.get(principal.user.id) ?? 0) +
						(pendingByUser.get(principal.user.id) ?? 0);
					const addressCount =
						(connectionsByAddress.get(address) ?? 0) +
						(pendingByAddress.get(address) ?? 0);
					if (
						clients.size + pendingConnectionTotal >= maxConnections ||
						sessionCount >= connectionsPerSession ||
						userCount >= connectionsPerUser ||
						addressCount >= connectionsPerAddress
					) {
						done(false, 429, "Connection limit reached");
						return;
					}
					pendingBySession.set(
						principal.sessionId,
						(pendingBySession.get(principal.sessionId) ?? 0) + 1
					);
					pendingByUser.set(
						principal.user.id,
						(pendingByUser.get(principal.user.id) ?? 0) + 1
					);
					pendingByAddress.set(
						address,
						(pendingByAddress.get(address) ?? 0) + 1
					);
					pendingConnectionTotal += 1;
					authenticatedRequests.set(info.req, principal);
					pendingReservationPrincipals.set(info.req, principal);
					pendingReservationAddresses.set(info.req, address);
					pendingReservations.add(info.req);
					info.req.socket.once("close", () =>
						releasePendingReservation(info.req)
					);
					if (info.req.socket.destroyed) {
						// The peer may disappear while database authentication is pending.
						releasePendingReservation(info.req);
						done(false, 400, "Connection closed");
						return;
					}
					done(true);
				})
				.catch(() => {
					rejectedRequests.add(info.req);
					done(true);
				})
				.finally(() => {
					decrement(pendingAuthenticationsByAddress, address);
					pendingAuthenticationTotal = Math.max(
						0,
						pendingAuthenticationTotal - 1
					);
				});
		}
	});
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
					if (!canReceiveEvent(recipient.principal, event)) continue;
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

	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const principal = authenticatedRequests.get(req);
		if (!principal || rejectedRequests.has(req)) {
			rejectedRequests.delete(req);
			socket.close(4401, "Authentication required");
			return;
		}
		// Preserve the admission-time address so socket teardown cannot move the
		// connection into the shared "unknown" counter after Node clears the peer.
		const address = pendingReservationAddresses.get(req) ?? clientAddress(req);
		releasePendingReservation(req);
		authenticatedRequests.delete(req);
		const sessionConnections =
			connectionsBySession.get(principal.sessionId) ?? 0;
		const userConnections = connectionsByUser.get(principal.user.id) ?? 0;
		const addressConnections = connectionsByAddress.get(address) ?? 0;
		if (clients.size >= maxConnections) {
			socket.close(4429, "Connection limit reached");
			return;
		}
		connectionsBySession.set(principal.sessionId, sessionConnections + 1);
		connectionsByUser.set(principal.user.id, userConnections + 1);
		connectionsByAddress.set(address, addressConnections + 1);
		const state: ClientState = {
			socket,
			isAlive: true,
			subscriptions: new Set(),
			outbox: [],
			outboxBytes: 0,
			bufferLimit: clientBufferLimit,
			bufferBytes: clientBufferBytes,
			highWaterMark: socketHighWaterMark,
			principal,
			request: req,
			address,
			authenticationInFlight: false
		};
		clients.set(socket, state);

		socket.on("pong", () => {
			state.isAlive = true;
		});

		socket.on("message", (raw: RawData) => {
			handleClientMessage(state, raw, subscribeTopic, unsubscribeTopic);
		});

		let cleaned = false;
		const cleanup = (): void => {
			if (cleaned) return;
			cleaned = true;
			for (const topic of [...state.subscriptions]) {
				unsubscribeTopic(state, topic);
			}
			state.outbox.length = 0;
			state.outboxBytes = 0;
			clients.delete(socket);
			decrement(connectionsBySession, state.principal.sessionId);
			decrement(connectionsByUser, state.principal.user.id);
			decrement(connectionsByAddress, state.address);
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
			if (!state.authenticationInFlight) {
				state.authenticationInFlight = true;
				void options
					.authenticate(state.request)
					.then((principal) => {
						if (!principal) {
							state.socket.close(4401, "Session expired");
							return;
						}
						state.principal = principal;
					})
					.catch(() => state.socket.close(4401, "Session expired"))
					.finally(() => {
						state.authenticationInFlight = false;
					});
			}
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
		connectionsBySession.clear();
		connectionsByUser.clear();
		connectionsByAddress.clear();
		pendingBySession.clear();
		pendingByUser.clear();
		pendingByAddress.clear();
		pendingAuthenticationsByAddress.clear();
		pendingConnectionTotal = 0;
		pendingAuthenticationTotal = 0;
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

/** Direct peer address is safe because forwarded headers are not trusted here. */
function clientAddress(request: IncomingMessage): string {
	return request.socket.remoteAddress ?? "unknown";
}

function decrement(counts: Map<string, number>, key: string): void {
	const next = (counts.get(key) ?? 1) - 1;
	if (next > 0) counts.set(key, next);
	else counts.delete(key);
}

/** Privileged topics fail closed when an older publisher lacks an audience. */
function canReceiveEvent(
	principal: AuthPrincipal,
	event: PublishedEvent
): boolean {
	if (
		(event.topic === "tuners" || event.topic === "jobs") &&
		principal.user.role !== "admin"
	) {
		return false;
	}
	// EPG source/mapping/progress payloads contain machine topology and diagnostics.
	// Standard users receive only explicit role-scoped guide refresh signals.
	if (
		event.topic === "epg" &&
		principal.user.role !== "admin" &&
		event.audience?.role !== "user"
	) {
		return false;
	}
	if (event.audience?.role && event.audience.role !== principal.user.role) {
		return false;
	}
	if (event.audience?.userId && event.audience.userId !== principal.user.id) {
		return false;
	}
	// Global settings reveal machine configuration; explicit user audiences are preferences.
	if (
		event.topic === "settings" &&
		!event.audience?.userId &&
		principal.user.role !== "admin"
	) {
		return false;
	}
	// Unscoped recording events are legacy/admin diagnostics, never user fan-out.
	if (
		event.topic === "recordings" &&
		!event.audience &&
		principal.user.role !== "admin"
	) {
		return false;
	}
	return true;
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

	const bytes = Buffer.byteLength(serialized);
	if (bytes > state.bufferBytes) return;
	// Backpressure: drop oldest queued events until both limits fit.
	state.outbox.push(serialized);
	state.outboxBytes += bytes;
	while (
		state.outbox.length > state.bufferLimit ||
		state.outboxBytes > state.bufferBytes
	) {
		const removed = state.outbox.shift();
		if (removed !== undefined) {
			state.outboxBytes -= Buffer.byteLength(removed);
		}
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
		state.outboxBytes -= Buffer.byteLength(next);
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
