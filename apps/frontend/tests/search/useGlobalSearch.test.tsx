import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SearchResponse } from "@signalhaven/shared";

import { useGlobalSearch } from "../../app/_search/useGlobalSearch";

function emptyResult(q: string): SearchResponse {
	return { q, channels: [], programs: [], recordings: [] };
}

describe("useGlobalSearch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("debounces input by 200ms by default and only fires the latest query", async () => {
		const searchFn = vi.fn(async (q: string) => emptyResult(q));
		const { result } = renderHook(() => useGlobalSearch({ searchFn }));

		act(() => result.current.setQuery("a"));
		act(() => result.current.setQuery("ab"));
		act(() => result.current.setQuery("abc"));

		expect(searchFn).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(199);
		});
		expect(searchFn).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(1);
		});
		// Only the last query is sent — earlier debounce timers were cleared.
		expect(searchFn).toHaveBeenCalledTimes(1);
		expect(searchFn).toHaveBeenCalledWith(
			"abc",
			{},
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it("aborts the in-flight request when a new query is issued", async () => {
		const observed: AbortSignal[] = [];
		let resolveFirst: (value: SearchResponse) => void = () => {};
		const searchFn = vi.fn(
			(
				q: string,
				_opts?: { limit?: number },
				init?: { signal?: AbortSignal | null }
			) => {
				if (init?.signal) observed.push(init.signal);
				if (observed.length === 1) {
					return new Promise<SearchResponse>((resolve) => {
						resolveFirst = resolve;
					});
				}
				return Promise.resolve(emptyResult(q));
			}
		) as unknown as typeof import("../../lib/api-client").searchAll;
		const { result } = renderHook(() => useGlobalSearch({ searchFn }));

		act(() => result.current.setQuery("first"));
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		expect(searchFn).toHaveBeenCalledTimes(1);
		expect(observed[0]?.aborted).toBe(false);

		// New keystroke before the first request resolves: it must abort.
		act(() => result.current.setQuery("second"));
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		expect(observed[0]?.aborted).toBe(true);
		expect(searchFn).toHaveBeenCalledTimes(2);

		// Resolving the aborted request must not overwrite state with stale data.
		await act(async () => {
			resolveFirst({
				...emptyResult("first"),
				channels: [
					{
						kind: "channel",
						id: "00000000-0000-4000-8000-000000000001",
						number: "1.1",
						name: "Stale",
						logoUrl: null,
						score: 1
					}
				]
			});
		});
		expect(result.current.data.channels).toEqual([]);
	});

	it("returns cached results synchronously for repeated queries", async () => {
		const cached: SearchResponse = {
			q: "abc",
			channels: [
				{
					kind: "channel",
					id: "00000000-0000-4000-8000-000000000001",
					number: "1",
					name: "Cached",
					logoUrl: null,
					score: 1
				}
			],
			programs: [],
			recordings: []
		};
		const searchFn = vi.fn(async () => cached);
		const { result } = renderHook(() => useGlobalSearch({ searchFn }));

		act(() => result.current.setQuery("abc"));
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		// Allow any pending microtasks (the awaited fetch promise) to
		// settle while staying on fake timers.
		await act(async () => {
			await Promise.resolve();
		});
		expect(searchFn).toHaveBeenCalledTimes(1);
		expect(result.current.data.channels[0]?.name).toBe("Cached");

		// Different query, then back to "abc" — must NOT issue a second fetch.
		act(() => result.current.setQuery("xyz"));
		act(() => result.current.setQuery("abc"));
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(searchFn).toHaveBeenCalledTimes(1);
		expect(result.current.data.channels[0]?.name).toBe("Cached");
	});

	it("clears state and never issues a request for empty / whitespace input", async () => {
		const searchFn = vi.fn(async (q: string) => emptyResult(q));
		const { result } = renderHook(() => useGlobalSearch({ searchFn }));

		act(() => result.current.setQuery("   "));
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(searchFn).not.toHaveBeenCalled();
		expect(result.current.data).toEqual(emptyResult(""));
		expect(result.current.loading).toBe(false);
	});
});
