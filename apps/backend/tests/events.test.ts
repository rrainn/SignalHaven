import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import test from "node:test";

import { WebSocket } from "ws";

import { EventBus } from "../src/events/event-bus";
import {
	attachEventsWebSocket,
	EVENTS_PATH,
	type AttachedWebSocketServer
} from "../src/events/websocket";

interface Harness {
	server: Server;
	events: AttachedWebSocketServer;
	bus: EventBus;
	url: string;
}

async function startHarness(
	options: {
		heartbeatIntervalMs?: number;
		clientBufferLimit?: number;
		socketHighWaterMark?: number;
	} = {}
): Promise<Harness> {
	const bus = new EventBus();
	const server = createServer((_req, res) => {
		res.statusCode = 404;
		res.end();
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const attachOptions: Parameters<typeof attachEventsWebSocket>[0] = {
		server,
		bus
	};
	if (options.heartbeatIntervalMs !== undefined) {
		attachOptions.heartbeatIntervalMs = options.heartbeatIntervalMs;
	}
	if (options.clientBufferLimit !== undefined) {
		attachOptions.clientBufferLimit = options.clientBufferLimit;
	}
	if (options.socketHighWaterMark !== undefined) {
		attachOptions.socketHighWaterMark = options.socketHighWaterMark;
	}
	const events = attachEventsWebSocket(attachOptions);
	const address = server.address() as AddressInfo;
	const url = `ws://127.0.0.1:${address.port}${EVENTS_PATH}`;
	return { server, events, bus, url };
}

async function stopHarness(h: Harness): Promise<void> {
	await h.events.close();
	await new Promise<void>((resolve, reject) => {
		h.server.close((err) => (err ? reject(err) : resolve()));
	});
}

function openClient(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

interface QueuedMessages {
	next(
		predicate?: (msg: Record<string, unknown>) => boolean
	): Promise<Record<string, unknown>>;
	all(): Record<string, unknown>[];
	close(): void;
}

function collect(ws: WebSocket): QueuedMessages {
	const buffer: Record<string, unknown>[] = [];
	const waiters: Array<{
		resolve: (v: Record<string, unknown>) => void;
		predicate: (msg: Record<string, unknown>) => boolean;
	}> = [];

	const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
		const text = typeof data === "string" ? data : data.toString();
		const msg = JSON.parse(text) as Record<string, unknown>;
		for (let i = 0; i < waiters.length; i++) {
			const w = waiters[i];
			if (w && w.predicate(msg)) {
				waiters.splice(i, 1);
				w.resolve(msg);
				return;
			}
		}
		buffer.push(msg);
	};

	ws.on("message", onMessage);

	return {
		async next(predicate = () => true) {
			for (let i = 0; i < buffer.length; i++) {
				const msg = buffer[i];
				if (msg && predicate(msg)) {
					buffer.splice(i, 1);
					return msg;
				}
			}
			return new Promise<Record<string, unknown>>((resolve) => {
				waiters.push({ resolve, predicate });
			});
		},
		all() {
			return [...buffer];
		},
		close() {
			ws.off("message", onMessage);
		}
	};
}

function closeClient(ws: WebSocket): Promise<void> {
	return new Promise((resolve) => {
		if (ws.readyState === WebSocket.CLOSED) {
			resolve();
			return;
		}
		ws.once("close", () => resolve());
		ws.close();
	});
}

test("subscribe -> publish -> receive; unsubscribe stops delivery", async () => {
	const h = await startHarness();
	try {
		const ws = await openClient(h.url);
		const messages = collect(ws);

		ws.send(JSON.stringify({ type: "subscribe", topics: ["recordings"] }));
		const ack = await messages.next((m) => m.type === "ack");
		assert.equal(ack.action, "subscribe");
		assert.deepEqual(ack.topics, ["recordings"]);

		h.bus.publish({
			topic: "recordings",
			event: "started",
			data: { id: "rec-1" }
		});

		const event = await messages.next((m) => m.type === "event");
		assert.equal(event.topic, "recordings");
		assert.equal(event.event, "started");
		assert.deepEqual(event.data, { id: "rec-1" });
		assert.equal(typeof event.ts, "string");

		ws.send(JSON.stringify({ type: "unsubscribe", topics: ["recordings"] }));
		const unsubAck = await messages.next(
			(m) => m.type === "ack" && m.action === "unsubscribe"
		);
		assert.deepEqual(unsubAck.topics, ["recordings"]);

		h.bus.publish({
			topic: "recordings",
			event: "completed",
			data: { id: "rec-1" }
		});

		// Give the server a tick; we should NOT see another event.
		await new Promise((r) => setTimeout(r, 50));
		const remaining = messages.all().filter((m) => m.type === "event");
		assert.deepEqual(remaining, []);

		messages.close();
		await closeClient(ws);
	} finally {
		await stopHarness(h);
	}
});

test("events to topics with zero subscribers are not broadcast and bus skips work", async () => {
	const h = await startHarness();
	try {
		// Nobody subscribed; publish should be a no-op (no listeners).
		assert.equal(h.bus.hasSubscribers("tuners"), false);
		h.bus.publish({ topic: "tuners", event: "noise", data: {} });

		const ws = await openClient(h.url);
		const messages = collect(ws);
		ws.send(JSON.stringify({ type: "subscribe", topics: ["tuners"] }));
		await messages.next((m) => m.type === "ack");

		assert.equal(h.bus.hasSubscribers("tuners"), true);

		h.bus.publish({ topic: "tuners", event: "online", data: { id: "t1" } });
		const evt = await messages.next((m) => m.type === "event");
		assert.equal(evt.event, "online");

		messages.close();
		await closeClient(ws);
	} finally {
		await stopHarness(h);
	}
});

test("invalid messages return a typed error frame and do not close socket", async () => {
	const h = await startHarness();
	try {
		const ws = await openClient(h.url);
		const messages = collect(ws);

		ws.send("not-json");
		const err1 = await messages.next((m) => m.type === "error");
		assert.equal(err1.code, "invalid_json");

		ws.send(JSON.stringify({ type: "bogus" }));
		const err2 = await messages.next((m) => m.type === "error");
		assert.equal(err2.code, "invalid_message");

		// Socket should still be usable.
		ws.send(JSON.stringify({ type: "ping" }));
		const pong = await messages.next((m) => m.type === "pong");
		assert.equal(pong.type, "pong");

		messages.close();
		await closeClient(ws);
	} finally {
		await stopHarness(h);
	}
});

test("heartbeat disconnects clients that miss pong replies", async () => {
	const h = await startHarness({ heartbeatIntervalMs: 50 });
	try {
		// Connect with autoPong disabled so the client never replies to pings.
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const sock = new WebSocket(h.url, { autoPong: false });
			sock.once("open", () => resolve(sock));
			sock.once("error", reject);
		});

		const closed = new Promise<void>((resolve) => {
			ws.once("close", () => resolve());
		});

		// First interval marks alive=false and sends a ping; second interval
		// sees no pong was received and terminates the socket.
		await closed;
	} finally {
		await stopHarness(h);
	}
});

test("backpressure drops oldest queued events when limit exceeded", async () => {
	const h = await startHarness({
		clientBufferLimit: 5,
		socketHighWaterMark: 1024
	});
	try {
		const ws = await openClient(h.url);
		const messages = collect(ws);

		ws.send(JSON.stringify({ type: "subscribe", topics: ["epg"] }));
		await messages.next((m) => m.type === "ack");

		// Pause the underlying socket so the server cannot drain its send buffer.
		ws.pause();

		// Publish far more than the buffer limit, with payloads big enough to
		// overflow the per-socket high water mark on the very first event.
		const padding = "x".repeat(64 * 1024);
		for (let i = 0; i < 50; i++) {
			h.bus.publish({ topic: "epg", event: "refresh", data: { i, padding } });
		}

		// Resume to drain. The newest event (i=49) must always survive; we
		// expect strictly fewer than 50 events because oldest were dropped.
		ws.resume();

		let last = -1;
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
			const events = messages.all().filter((m) => m.type === "event");
			if (events.length > 0) {
				const newest = events[events.length - 1] as { data: { i: number } };
				if (newest.data.i === 49 && newest.data.i === last) {
					break;
				}
				last = newest.data.i;
			}
		}

		const events = messages.all().filter((m) => m.type === "event");
		assert.ok(
			events.length > 0,
			`expected to receive at least one event, got ${events.length}`
		);
		assert.ok(
			events.length < 50,
			`expected oldest events to be dropped, got ${events.length}/50`
		);
		const newest = events[events.length - 1] as {
			data: { i: number };
		};
		assert.equal(newest.data.i, 49, "newest event must always be delivered");

		messages.close();
		await closeClient(ws);
	} finally {
		await stopHarness(h);
	}
});

test("two clients on same topic share a single bus subscription", async () => {
	const h = await startHarness();
	try {
		const a = await openClient(h.url);
		const b = await openClient(h.url);
		const ma = collect(a);
		const mb = collect(b);

		a.send(JSON.stringify({ type: "subscribe", topics: ["tuners"] }));
		b.send(JSON.stringify({ type: "subscribe", topics: ["tuners"] }));
		await ma.next((m) => m.type === "ack");
		await mb.next((m) => m.type === "ack");

		h.bus.publish({ topic: "tuners", event: "online", data: { id: "t1" } });

		const eventA = await ma.next((m) => m.type === "event");
		const eventB = await mb.next((m) => m.type === "event");
		// Same payload (and same `ts`, which proves a single shared serialization).
		assert.deepEqual(eventA, eventB);

		// After both unsubscribe, the bus should report no subscribers.
		a.send(JSON.stringify({ type: "unsubscribe", topics: ["tuners"] }));
		b.send(JSON.stringify({ type: "unsubscribe", topics: ["tuners"] }));
		await ma.next((m) => m.type === "ack" && m.action === "unsubscribe");
		await mb.next((m) => m.type === "ack" && m.action === "unsubscribe");
		// Allow microtask queue to flush the bus unsubscribe callback.
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.bus.hasSubscribers("tuners"), false);

		ma.close();
		mb.close();
		await Promise.all([closeClient(a), closeClient(b)]);
	} finally {
		await stopHarness(h);
	}
});
