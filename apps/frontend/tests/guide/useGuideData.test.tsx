import type { EpgGrid } from "@signalhaven/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGuideData } from "../../app/_guide/useGuideData";
import { getEpgGrid } from "../../lib/api-client";
import { useWebSocketEvents } from "../../lib/ws-client";

vi.mock("../../lib/api-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/api-client")>();
	return { ...actual, getEpgGrid: vi.fn() };
});

vi.mock("../../lib/ws-client", () => ({
	useWebSocketEvents: vi.fn(() => "closed")
}));

const getEpgGridMock = vi.mocked(getEpgGrid);
const useWebSocketEventsMock = vi.mocked(useWebSocketEvents);

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

/** Keeps request completion under test control so races stay deterministic. */
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** Builds a small identifiable payload without involving fixture randomness. */
function guideData(from: Date, to: Date, channelName: string): EpgGrid {
	return {
		from: from.toISOString(),
		to: to.toISOString(),
		channels: [
			{
				id: "00000000-0000-4000-8000-000000000001",
				number: "1.1",
				name: channelName,
				logoUrl: null,
				hasMapping: true
			}
		],
		programs: []
	};
}

beforeEach(() => {
	getEpgGridMock.mockReset();
	useWebSocketEventsMock.mockReset();
	useWebSocketEventsMock.mockReturnValue("closed");
});

describe("useGuideData request ordering", () => {
	it("fetches and merges only a newly requested edge", async () => {
		const windowStart = new Date("2026-06-01T12:00:00.000Z");
		const initialEnd = new Date("2026-06-01T18:00:00.000Z");
		const expandedEnd = new Date("2026-06-01T20:00:00.000Z");
		getEpgGridMock
			.mockResolvedValueOnce(guideData(windowStart, initialEnd, "Initial"))
			.mockResolvedValueOnce(guideData(initialEnd, expandedEnd, "Expanded"));

		const { result, rerender } = renderHook(
			({ windowEnd }) =>
				useGuideData({ windowStart, windowEnd, liveUpdates: false }),
			{ initialProps: { windowEnd: initialEnd } }
		);
		await waitFor(() => expect(result.current.state.status).toBe("ready"));

		rerender({ windowEnd: expandedEnd });
		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(2));
		expect(getEpgGridMock).toHaveBeenLastCalledWith(
			{ from: initialEnd.toISOString(), to: expandedEnd.toISOString() },
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		await waitFor(() =>
			expect(result.current.state.loadedTo).toBe(expandedEnd.getTime())
		);
		expect(result.current.state.loadedFrom).toBe(windowStart.getTime());
	});

	it("refreshes only affected two-hour partitions from EPG events", async () => {
		const windowStart = new Date("2026-06-01T12:00:00.000Z");
		const windowEnd = new Date("2026-06-01T18:00:00.000Z");
		const affectedFrom = new Date("2026-06-01T14:00:00.000Z");
		const affectedTo = new Date("2026-06-01T16:00:00.000Z");
		getEpgGridMock
			.mockResolvedValueOnce(guideData(windowStart, windowEnd, "Initial"))
			.mockResolvedValueOnce(
				guideData(affectedFrom, affectedTo, "Refreshed partition")
			);

		renderHook(() => useGuideData({ windowStart, windowEnd }));
		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(1));
		const subscription =
			useWebSocketEventsMock.mock.calls[
				useWebSocketEventsMock.mock.calls.length - 1
			]?.[0];
		expect(subscription).toBeDefined();
		act(() => {
			if (!subscription?.onEvent) throw new Error("Missing event callback");
			subscription.onEvent({
				type: "event",
				topic: "epg",
				event: "epg.refresh",
				data: {
					phase: "completed",
					sourceId: "10000000-0000-4000-8000-000000000001",
					affectedFrom: affectedFrom.toISOString(),
					affectedTo: affectedTo.toISOString()
				},
				ts: "2026-06-01T16:00:00.000Z"
			});
		});

		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(2));
		expect(getEpgGridMock).toHaveBeenLastCalledWith(
			{ from: affectedFrom.toISOString(), to: affectedTo.toISOString() },
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it("reconciles the current range when onboarding invalidates the guide", async () => {
		const windowStart = new Date("2026-06-01T12:00:00.000Z");
		const windowEnd = new Date("2026-06-01T18:00:00.000Z");
		getEpgGridMock
			.mockResolvedValueOnce({
				from: windowStart.toISOString(),
				to: windowEnd.toISOString(),
				channels: [],
				programs: []
			})
			.mockResolvedValueOnce(guideData(windowStart, windowEnd, "Imported"));

		const { result } = renderHook(() =>
			useGuideData({ windowStart, windowEnd, liveUpdates: false })
		);
		await waitFor(() => expect(result.current.state.status).toBe("ready"));
		expect(result.current.state.data?.channels).toHaveLength(0);

		act(() => {
			window.dispatchEvent(new Event("signalhaven:guide-invalidate"));
		});

		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(result.current.state.data?.channels[0]?.name).toBe("Imported")
		);
	});

	it("aborts the previous request when the requested range changes", async () => {
		const firstRequest = deferred<EpgGrid>();
		const secondRequest = deferred<EpgGrid>();
		getEpgGridMock
			.mockReturnValueOnce(firstRequest.promise)
			.mockReturnValueOnce(secondRequest.promise);
		const firstStart = new Date("2026-06-01T12:00:00.000Z");
		const firstEnd = new Date("2026-06-01T18:00:00.000Z");
		const secondStart = new Date("2026-06-02T12:00:00.000Z");
		const secondEnd = new Date("2026-06-02T18:00:00.000Z");

		const { rerender } = renderHook(
			({ windowStart, windowEnd }) =>
				useGuideData({ windowStart, windowEnd, liveUpdates: false }),
			{
				initialProps: {
					windowStart: firstStart,
					windowEnd: firstEnd
				}
			}
		);

		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(1));
		const firstSignal = getEpgGridMock.mock.calls[0]?.[1]?.signal;
		expect(firstSignal).toBeInstanceOf(AbortSignal);
		expect(firstSignal?.aborted).toBe(false);

		rerender({ windowStart: secondStart, windowEnd: secondEnd });

		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(2));
		expect(firstSignal?.aborted).toBe(true);
		expect(getEpgGridMock).toHaveBeenNthCalledWith(
			2,
			{
				from: secondStart.toISOString(),
				to: secondEnd.toISOString()
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it("does not let a late stale response overwrite the latest range", async () => {
		const staleRequest = deferred<EpgGrid>();
		const latestRequest = deferred<EpgGrid>();
		getEpgGridMock
			.mockReturnValueOnce(staleRequest.promise)
			.mockReturnValueOnce(latestRequest.promise);
		const staleStart = new Date("2026-06-01T12:00:00.000Z");
		const staleEnd = new Date("2026-06-01T18:00:00.000Z");
		const latestStart = new Date("2026-06-02T12:00:00.000Z");
		const latestEnd = new Date("2026-06-02T18:00:00.000Z");
		const staleData = guideData(staleStart, staleEnd, "Stale range");
		const latestData = guideData(latestStart, latestEnd, "Latest range");

		const { result, rerender } = renderHook(
			({ windowStart, windowEnd }) =>
				useGuideData({ windowStart, windowEnd, liveUpdates: false }),
			{
				initialProps: {
					windowStart: staleStart,
					windowEnd: staleEnd
				}
			}
		);

		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(1));
		rerender({ windowStart: latestStart, windowEnd: latestEnd });
		await waitFor(() => expect(getEpgGridMock).toHaveBeenCalledTimes(2));

		await act(async () => {
			latestRequest.resolve(latestData);
			await latestRequest.promise;
		});
		expect(result.current.state.data?.channels[0]?.name).toBe("Latest range");

		// Simulate a transport that resolves even after its signal was aborted.
		await act(async () => {
			staleRequest.resolve(staleData);
			await staleRequest.promise;
		});

		expect(result.current.state.data?.channels[0]?.name).toBe("Latest range");
		expect(result.current.state.loadedFrom).toBe(latestStart.getTime());
		expect(result.current.state.loadedTo).toBe(latestEnd.getTime());
	});

	it("retains existing guide data when a refresh fails", async () => {
		const windowStart = new Date("2026-06-01T12:00:00.000Z");
		const windowEnd = new Date("2026-06-01T18:00:00.000Z");
		const existingData = guideData(windowStart, windowEnd, "Existing data");
		const refreshError = new Error("Refresh failed");
		getEpgGridMock
			.mockResolvedValueOnce(existingData)
			.mockRejectedValueOnce(refreshError);

		const { result } = renderHook(() =>
			useGuideData({ windowStart, windowEnd, liveUpdates: false })
		);

		await waitFor(() => expect(result.current.state.status).toBe("ready"));
		await act(async () => {
			await result.current.refresh();
		});

		expect(result.current.state.data).toBe(existingData);
		expect(result.current.state.loadedFrom).toBe(windowStart.getTime());
		expect(result.current.state.loadedTo).toBe(windowEnd.getTime());
		expect(result.current.state.error).toBe(refreshError);
	});

	it("applies the same latest-request protection to repeated refreshes", async () => {
		const windowStart = new Date("2026-06-01T12:00:00.000Z");
		const windowEnd = new Date("2026-06-01T18:00:00.000Z");
		const initialData = guideData(windowStart, windowEnd, "Initial data");
		const olderRefresh = deferred<EpgGrid>();
		const latestRefresh = deferred<EpgGrid>();
		getEpgGridMock
			.mockResolvedValueOnce(initialData)
			.mockReturnValueOnce(olderRefresh.promise)
			.mockReturnValueOnce(latestRefresh.promise);
		const { result } = renderHook(() =>
			useGuideData({ windowStart, windowEnd, liveUpdates: false })
		);

		await waitFor(() => expect(result.current.state.status).toBe("ready"));

		let olderRefreshPromise!: Promise<void>;
		let latestRefreshPromise!: Promise<void>;
		act(() => {
			olderRefreshPromise = result.current.refresh();
			latestRefreshPromise = result.current.refresh();
		});

		expect(getEpgGridMock).toHaveBeenCalledTimes(3);
		const olderSignal = getEpgGridMock.mock.calls[1]?.[1]?.signal;
		const latestSignal = getEpgGridMock.mock.calls[2]?.[1]?.signal;
		expect(olderSignal).toBeInstanceOf(AbortSignal);
		expect(olderSignal?.aborted).toBe(true);
		expect(latestSignal?.aborted).toBe(false);

		await act(async () => {
			latestRefresh.resolve(
				guideData(windowStart, windowEnd, "Latest refresh")
			);
			await latestRefreshPromise;
		});
		expect(result.current.state.data?.channels[0]?.name).toBe("Latest refresh");

		await act(async () => {
			olderRefresh.resolve(guideData(windowStart, windowEnd, "Older refresh"));
			await olderRefreshPromise;
		});
		expect(result.current.state.data?.channels[0]?.name).toBe("Latest refresh");
	});
});
