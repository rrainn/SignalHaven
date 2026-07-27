import type { EventTopic } from "@signalhaven/shared";

/**
 * Map of topic -> event payload type. Modules add entries to this interface
 * via TypeScript declaration merging when they introduce new event types,
 * giving us compile-time safety on `publish()` / `subscribe()`.
 *
 * NOTE: Concrete payload types are intentionally left as `unknown` here so
 * this module stays decoupled from any feature module. Publishers should
 * augment this interface to declare their own payload shapes.
 */
export interface EventPayloadMap {
	recordings: unknown;
	tuners: unknown;
	epg: unknown;
	jobs: unknown;
	settings: unknown;
}

export type AnyEventPayload = EventPayloadMap[EventTopic];

export interface PublishedEvent<TTopic extends EventTopic = EventTopic> {
	topic: TTopic;
	/** Free-form discriminator within a topic (e.g. "started", "progress"). */
	event: string;
	data: EventPayloadMap[TTopic];
}

export type EventListener<TTopic extends EventTopic = EventTopic> = (
	event: PublishedEvent<TTopic>
) => void;

/**
 * Typed in-process pub/sub. Any module can publish to a topic; the WebSocket
 * layer is just one subscriber. We intentionally avoid Node's EventEmitter so
 * we can offer a strongly typed API and a `hasSubscribers` predicate that the
 * WS fan-out uses to skip serialization for topics with no listeners.
 */
export class EventBus {
	private readonly listeners = new Map<EventTopic, Set<EventListener>>();

	subscribe<TTopic extends EventTopic>(
		topic: TTopic,
		listener: EventListener<TTopic>
	): () => void {
		let set = this.listeners.get(topic);
		if (!set) {
			set = new Set();
			this.listeners.set(topic, set);
		}
		set.add(listener as EventListener);
		return () => {
			const current = this.listeners.get(topic);
			if (!current) {
				return;
			}
			current.delete(listener as EventListener);
			if (current.size === 0) {
				this.listeners.delete(topic);
			}
		};
	}

	hasSubscribers(topic: EventTopic): boolean {
		const set = this.listeners.get(topic);
		return set !== undefined && set.size > 0;
	}

	publish<TTopic extends EventTopic>(event: PublishedEvent<TTopic>): void {
		const set = this.listeners.get(event.topic);
		if (!set || set.size === 0) {
			return;
		}
		// Snapshot listeners so unsubscribes during dispatch don't skip peers.
		for (const listener of [...set]) {
			try {
				(listener as EventListener<TTopic>)(event);
			} catch {
				// Listener errors must not break the bus or starve other subscribers.
			}
		}
	}

	/** Test/teardown helper. */
	clear(): void {
		this.listeners.clear();
	}
}

let defaultBus: EventBus | undefined;

export function getEventBus(): EventBus {
	if (!defaultBus) {
		defaultBus = new EventBus();
	}
	return defaultBus;
}
