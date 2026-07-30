"use client";

import type { SearchResponse } from "@signalhaven/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, searchAll as defaultSearchAll } from "../../lib/api-client";

/**
 * Stateful global search hook (rrainn/SignalHaven#U10-search).
 *
 * Behaviour required by the spec:
 *   * 200 ms debounce on input — keystrokes within the debounce window
 *     do not produce a network request.
 *   * In-flight cancellation — every new search aborts the previous
 *     request via `AbortController`, so stale responses never overwrite
 *     fresher ones.
 *   * Repeated queries are re-fetched because guide refreshes can remove
 *     a program while the search modal remains open.
 *   * Empty / whitespace `q` — short-circuited locally; nothing is
 *     fetched.
 */

export interface UseGlobalSearchOptions {
	/** Override for tests; defaults to the live `searchAll` client. */
	searchFn?: typeof defaultSearchAll;
	/** Debounce window in ms (default 200). */
	debounceMs?: number;
	/** Per-group cap. Forwarded to the backend; default 10. */
	limit?: number;
}

export interface UseGlobalSearchResult {
	query: string;
	setQuery: (next: string) => void;
	/** Most recent successfully-loaded result (empty groups if no `q` yet). */
	data: SearchResponse;
	loading: boolean;
	error: string | null;
	/** Cancel any in-flight request and reset the input. */
	reset: () => void;
}

const EMPTY_RESULT: SearchResponse = {
	q: "",
	channels: [],
	programs: [],
	recordings: []
};

export function useGlobalSearch(
	options: UseGlobalSearchOptions = {}
): UseGlobalSearchResult {
	const { searchFn = defaultSearchAll, debounceMs = 200, limit } = options;

	const [query, setQuery] = useState("");
	const [data, setData] = useState<SearchResponse>(EMPTY_RESULT);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const abortRef = useRef<AbortController | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancel = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		if (abortRef.current) {
			abortRef.current.abort();
			abortRef.current = null;
		}
	}, []);

	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			cancel();
			setData(EMPTY_RESULT);
			setError(null);
			setLoading(false);
			return;
		}

		// Cancel any in-flight request *and* the pending debounce so the
		// newest keystroke wins.
		cancel();
		setLoading(true);
		setError(null);

		timerRef.current = setTimeout(() => {
			const controller = new AbortController();
			abortRef.current = controller;
			const issued = trimmed;
			const fetchOptions = limit !== undefined ? { limit } : {};
			searchFn(issued, fetchOptions, { signal: controller.signal })
				.then((result) => {
					if (controller.signal.aborted) return;
					setData(result);
					setLoading(false);
				})
				.catch((err: unknown) => {
					if (controller.signal.aborted) return;
					if (err instanceof DOMException && err.name === "AbortError") {
						return;
					}
					if (
						err instanceof ApiError ||
						(err instanceof Error && err.message.length > 0)
					) {
						setError((err as Error).message);
					} else {
						setError("Search failed");
					}
					setLoading(false);
				});
		}, debounceMs);

		return () => {
			// Effect cleanup runs on the next keystroke: clear the timer so a
			// request that hasn't fired yet never does.
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [query, searchFn, debounceMs, limit, cancel]);

	// Cancel everything on unmount so React 18 strict-mode double-mount and
	// closing the modal mid-flight don't leak requests.
	useEffect(() => () => cancel(), [cancel]);

	const reset = useCallback(() => {
		cancel();
		setQuery("");
		setData(EMPTY_RESULT);
		setError(null);
		setLoading(false);
	}, [cancel]);

	return useMemo(
		() => ({ query, setQuery, data, loading, error, reset }),
		[query, data, loading, error, reset]
	);
}
