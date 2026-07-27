import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWebSocketEvents } from "../lib/ws-client";

type SocketListener = (event: Event) => void;

/** Minimal controllable WebSocket used to exercise reconnect behavior. */
class FakeWebSocket {
	static readonly instances: FakeWebSocket[] = [];

	private readonly listeners = new Map<string, Set<SocketListener>>();

	constructor(_url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: SocketListener): void {
		const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	send(_message: string): void {}

	close(): void {}

	emit(type: "open" | "close"): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new Event(type));
		}
	}
}

function ReconnectFixture(props: { onReconnect: () => void }) {
	useWebSocketEvents({
		topics: ["recordings"],
		onReconnect: props.onReconnect
	});
	return null;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	FakeWebSocket.instances.length = 0;
});

describe("useWebSocketEvents", () => {
	it("requests reconciliation only after a disconnected socket reconnects", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const onReconnect = vi.fn();
		render(<ReconnectFixture onReconnect={onReconnect} />);

		act(() => FakeWebSocket.instances[0]!.emit("open"));
		expect(onReconnect).not.toHaveBeenCalled();

		act(() => FakeWebSocket.instances[0]!.emit("close"));
		act(() => vi.advanceTimersByTime(500));
		expect(FakeWebSocket.instances).toHaveLength(2);

		act(() => FakeWebSocket.instances[1]!.emit("open"));
		expect(onReconnect).toHaveBeenCalledTimes(1);
	});
});
