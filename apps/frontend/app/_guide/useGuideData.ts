"use client";

import {
	RECORDING_EVENT,
	type EpgGrid,
	type EventMessage
} from "@signalhaven/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { getEpgGrid } from "../../lib/api-client";
import { GUIDE_INVALIDATE_EVENT } from "../../lib/app-events";
import { parseRecordingEvent } from "../../lib/recording-events";
import { useWebSocketEvents } from "../../lib/ws-client";
import type { ProgramRecordingPatch } from "../_recordings/useProgramRecordingActions";

export type GuideDataStatus = "idle" | "loading" | "ready" | "error";

interface GuideDataState {
	status: GuideDataStatus;
	data: EpgGrid | null;
	error: Error | null;
	/** Window the latest fetch covered (for staleness checks). */
	loadedFrom: number | null;
	loadedTo: number | null;
}

type Action =
	| { type: "loading" }
	| { type: "loaded"; data: EpgGrid }
	| { type: "cancelled" }
	| { type: "error"; error: Error }
	| { type: "patch"; patch: (data: EpgGrid) => EpgGrid };

function reducer(state: GuideDataState, action: Action): GuideDataState {
	switch (action.type) {
		case "loading":
			return { ...state, status: "loading", error: null };
		case "loaded":
			return {
				status: "ready",
				data: action.data,
				error: null,
				loadedFrom: Date.parse(action.data.from),
				loadedTo: Date.parse(action.data.to)
			};
		case "cancelled":
			return {
				...state,
				status: state.data ? "ready" : "idle",
				error: null
			};
		case "error":
			// Keep the last successful window visible through transient failures.
			return { ...state, status: "error", error: action.error };
		case "patch":
			return state.data ? { ...state, data: action.patch(state.data) } : state;
		default:
			return state;
	}
}

/** Recognizes request cancellation across browser and test error realms. */
function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError"
	);
}

export interface UseGuideDataOptions {
	/** Inclusive lower bound of the desired window. */
	windowStart: Date;
	/** Exclusive upper bound. */
	windowEnd: Date;
	/**
	 * Optional payload override — used by tests, the dev preview, and
	 * Storybook to inject a fixture without making a network call.
	 */
	initialData?: EpgGrid | undefined;
	/** Disable the WS subscription (default `true` enables it). */
	liveUpdates?: boolean;
}

/**
 * Loads guide data for the requested window and keeps it live via the WS
 * event bus.
 *
 * Recording lifecycle events update the matching program immediately. A
 * completed EPG refresh reloads only affected two-hour partitions; reconnects
 * reconcile the current window so missed changes do not require a page reload.
 */
export function useGuideData(opts: UseGuideDataOptions): {
	state: GuideDataState;
	refresh: () => Promise<void>;
	updateProgramRecording: (
		programId: string,
		patch: ProgramRecordingPatch
	) => void;
} {
	const [state, dispatch] = useReducer(reducer, {
		status: opts.initialData ? "ready" : "idle",
		data: opts.initialData ?? null,
		error: null,
		loadedFrom: opts.initialData ? Date.parse(opts.initialData.from) : null,
		loadedTo: opts.initialData ? Date.parse(opts.initialData.to) : null
	});

	const fromIso = opts.windowStart.toISOString();
	const toIso = opts.windowEnd.toISOString();
	const hasInitial = Boolean(opts.initialData);
	const activeRequestRef = useRef<AbortController | null>(null);
	const latestRequestIdRef = useRef(0);
	const latestDataRef = useRef<EpgGrid | null>(opts.initialData ?? null);
	const requestedRangeRef = useRef({
		from: Date.parse(fromIso),
		to: Date.parse(toIso)
	});
	requestedRangeRef.current = {
		from: Date.parse(fromIso),
		to: Date.parse(toIso)
	};
	useEffect(() => {
		latestDataRef.current = state.data;
	}, [state.data]);

	/**
	 * Fetch authoritative slices and merge them into the bounded client cache.
	 * A slice replaces programs intersecting its own interval so deleted or
	 * shifted airings do not survive a source refresh.
	 */
	const loadSlices = useCallback(async (slices: readonly GuideSlice[]) => {
		if (slices.length === 0) return;
		const requestId = latestRequestIdRef.current + 1;
		latestRequestIdRef.current = requestId;

		// One owner at a time prevents obsolete windows from consuming bandwidth.
		activeRequestRef.current?.abort();
		const controller = new AbortController();
		activeRequestRef.current = controller;

		dispatch({ type: "loading" });
		try {
			const responses = await Promise.all(
				slices.map((slice) =>
					getEpgGrid(
						{
							from: new Date(slice.from).toISOString(),
							to: new Date(slice.to).toISOString()
						},
						{ signal: controller.signal }
					)
				)
			);
			// Some transports still resolve after abort, so identity is authoritative.
			if (
				controller.signal.aborted ||
				requestId !== latestRequestIdRef.current
			) {
				return;
			}
			let merged = latestDataRef.current;
			for (const response of responses) {
				merged = mergeGuideSlice(merged, response);
			}
			if (!merged) return;
			merged = trimGuideRange(
				merged,
				requestedRangeRef.current.from,
				requestedRangeRef.current.to
			);
			latestDataRef.current = merged;
			dispatch({ type: "loaded", data: merged });
		} catch (err) {
			if (
				controller.signal.aborted ||
				requestId !== latestRequestIdRef.current
			) {
				return;
			}
			if (isAbortError(err)) {
				dispatch({ type: "cancelled" });
				return;
			}
			dispatch({
				type: "error",
				error: err instanceof Error ? err : new Error(String(err))
			});
		} finally {
			if (requestId === latestRequestIdRef.current) {
				activeRequestRef.current = null;
			}
		}
	}, []);

	/** Force the current requested range to be reconciled from the server. */
	const refresh = useCallback(
		() => loadSlices([{ from: Date.parse(fromIso), to: Date.parse(toIso) }]),
		[fromIso, loadSlices, toIso]
	);

	useEffect(() => {
		// Onboarding runs over the already-mounted Guide, so its initial empty
		// response must be reconciled explicitly when setup finishes.
		const handleInvalidation = () => void refresh();
		window.addEventListener(GUIDE_INVALIDATE_EVENT, handleInvalidation);
		return () =>
			window.removeEventListener(GUIDE_INVALIDATE_EVENT, handleInvalidation);
	}, [refresh]);

	useEffect(() => {
		// Skip the initial fetch when the parent injected a fixture (tests).
		if (hasInitial) return;
		const missing = missingGuideSlices(
			latestDataRef.current,
			Date.parse(fromIso),
			Date.parse(toIso)
		);
		void loadSlices(missing);
	}, [fromIso, hasInitial, loadSlices, toIso]);

	useEffect(
		() => () => {
			// Invalidate the identity because abort is advisory to custom transports.
			latestRequestIdRef.current += 1;
			activeRequestRef.current?.abort();
			activeRequestRef.current = null;
		},
		[]
	);

	const updateProgramRecording = useCallback(
		(programId: string, patch: ProgramRecordingPatch) => {
			dispatch({
				type: "patch",
				patch: (data) => ({
					...data,
					programs: data.programs.map((program) =>
						program.id === programId ? { ...program, ...patch } : program
					)
				})
			});
		},
		[]
	);

	// Stash the latest dispatch in a ref so the WS handler stays stable.
	const handlerRef = useRef<(ev: EventMessage) => void>(() => {});
	handlerRef.current = (ev: EventMessage) => {
		const recordingEvent = parseRecordingEvent(ev);
		if (recordingEvent) {
			const programId = recordingEvent.recording.programId;
			if (!programId) return;
			if (recordingEvent.event === RECORDING_EVENT.deleted) {
				void refresh();
				return;
			}
			updateProgramRecording(programId, {
				recordingId: recordingEvent.recording.id,
				recordingStatus: recordingEvent.recording.status
			});
			return;
		}
		if (ev.topic === "epg" && ev.event === "epg.refresh") {
			const payload = ev.data as {
				phase?: unknown;
				affectedFrom?: unknown;
				affectedTo?: unknown;
			};
			if (payload.phase !== "completed") return;
			const affectedFrom = parseEventDate(payload.affectedFrom);
			const affectedTo = parseEventDate(payload.affectedTo);
			if (affectedFrom === null || affectedTo === null) {
				// Older backends do not publish bounds, so correctness requires a
				// one-time reconciliation of the requested range.
				void refresh();
				return;
			}
			void loadSlices(
				partitionGuideRange(
					Math.max(affectedFrom, Date.parse(fromIso)),
					Math.min(affectedTo, Date.parse(toIso))
				)
			);
		}
	};

	useWebSocketEvents({
		topics: ["epg", "recordings"],
		enabled: opts.liveUpdates !== false,
		onEvent: useCallback((ev: EventMessage) => handlerRef.current(ev), []),
		onReconnect: refresh
	});

	return { state, refresh, updateProgramRecording };
}

interface GuideSlice {
	from: number;
	to: number;
}

const GUIDE_PARTITION_MS = 2 * 60 * 60 * 1_000;

/** Return only the uncovered edges of a requested Guide window. */
function missingGuideSlices(
	data: EpgGrid | null,
	requestedFrom: number,
	requestedTo: number
): GuideSlice[] {
	if (!data) return [{ from: requestedFrom, to: requestedTo }];
	const loadedFrom = Date.parse(data.from);
	const loadedTo = Date.parse(data.to);
	if (
		!Number.isFinite(loadedFrom) ||
		!Number.isFinite(loadedTo) ||
		loadedFrom >= loadedTo ||
		requestedTo <= loadedFrom ||
		requestedFrom >= loadedTo
	) {
		return [{ from: requestedFrom, to: requestedTo }];
	}
	const slices: GuideSlice[] = [];
	if (requestedFrom < loadedFrom) {
		slices.push({ from: requestedFrom, to: loadedFrom });
	}
	if (requestedTo > loadedTo) {
		slices.push({ from: loadedTo, to: requestedTo });
	}
	return slices;
}

/** Split refresh invalidation into stable two-hour time partitions. */
function partitionGuideRange(from: number, to: number): GuideSlice[] {
	if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [];
	const slices: GuideSlice[] = [];
	let cursor = from;
	while (cursor < to) {
		const partitionEnd =
			(Math.floor(cursor / GUIDE_PARTITION_MS) + 1) * GUIDE_PARTITION_MS;
		const end = Math.min(to, partitionEnd);
		slices.push({ from: cursor, to: end });
		cursor = end;
	}
	return slices;
}

/** Merge an authoritative time slice without duplicating boundary programs. */
function mergeGuideSlice(current: EpgGrid | null, incoming: EpgGrid): EpgGrid {
	if (!current) return incoming;
	const incomingFrom = Date.parse(incoming.from);
	const incomingTo = Date.parse(incoming.to);
	const retainedPrograms = current.programs.filter((program) => {
		const start = Date.parse(program.start);
		const stop = Date.parse(program.stop);
		return start >= incomingTo || stop <= incomingFrom;
	});
	const programsByCell = new Map(
		[...retainedPrograms, ...incoming.programs].map((program) => [
			`${program.channelId}:${program.id}`,
			program
		])
	);
	return {
		from: new Date(
			Math.min(Date.parse(current.from), incomingFrom)
		).toISOString(),
		to: new Date(Math.max(Date.parse(current.to), incomingTo)).toISOString(),
		// Every grid response carries the complete enabled-channel snapshot.
		channels: incoming.channels,
		programs: [...programsByCell.values()]
	};
}

/** Keep the merged cache bounded to the range currently owned by the page. */
function trimGuideRange(data: EpgGrid, from: number, to: number): EpgGrid {
	if (Date.parse(data.from) === from && Date.parse(data.to) === to) return data;
	return {
		...data,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		programs: data.programs.filter((program) => {
			const start = Date.parse(program.start);
			const stop = Date.parse(program.stop);
			return start < to && stop > from;
		})
	};
}

/** Parse optional refresh bounds without trusting WebSocket payloads. */
function parseEventDate(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
