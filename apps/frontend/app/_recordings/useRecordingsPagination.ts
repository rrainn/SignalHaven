"use client";

import type {
	Recording,
	RecordingList,
	RecordingListItem,
	RecordingListQuery,
	RecordingOneOffGroup,
	RecordingSeriesGroup
} from "@signalhaven/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Minimal request options accepted by production and deterministic tests. */
export interface RecordingPageLoadOptions {
	signal?: AbortSignal;
}

/** Injectable server-page loader used by library and series views. */
export type RecordingPageLoader = (
	query: Partial<RecordingListQuery>,
	options: RecordingPageLoadOptions
) => Promise<RecordingList>;

type LoadStatus = "loading" | "refreshing" | "ready" | "error";

interface PaginationState {
	pages: RecordingList[];
	status: LoadStatus;
	error: Error | null;
	loadMoreError: Error | null;
	loadingMore: boolean;
}

interface UseRecordingsPaginationOptions {
	query: Partial<RecordingListQuery>;
	pageSize: number;
	targetPageCount: number;
	loadPage: RecordingPageLoader;
	initialPage?: RecordingList;
}

export interface RecordingsPagination {
	recordings: RecordingListItem[];
	total: number;
	totalSize: number;
	limit: number;
	loadedCount: number;
	pageCount: number;
	seriesGroups: Map<string, RecordingSeriesGroup>;
	oneOffGroup: RecordingOneOffGroup | null;
	status: LoadStatus;
	error: Error | null;
	loadMoreError: Error | null;
	loadingMore: boolean;
	hasMore: boolean;
	loadMore: () => Promise<boolean>;
	refresh: () => Promise<void>;
	removeRecordings: (ids: string[]) => void;
	patchRecordings: (ids: string[], patch: Partial<Recording>) => void;
}

/**
 * Own stable cursor paging and request ordering for recordings consumers.
 * Replacement failures preserve the prior rows, while later-page failures
 * expose a retry state without discarding successful pages.
 */
export function useRecordingsPagination(
	options: UseRecordingsPaginationOptions
): RecordingsPagination {
	const [state, setState] = useState<PaginationState>(() => ({
		pages: options.initialPage ? [options.initialPage] : [],
		status: options.initialPage ? "ready" : "loading",
		error: null,
		loadMoreError: null,
		loadingMore: false
	}));
	const activeRequest = useRef(0);
	const controller = useRef<AbortController | null>(null);
	const skipInitialLoad = useRef(Boolean(options.initialPage));
	const targetPageCount = useRef(options.targetPageCount);
	targetPageCount.current = options.targetPageCount;
	const queryKey = JSON.stringify(options.query);

	const replacePages = useCallback(async (): Promise<void> => {
		const request = ++activeRequest.current;
		controller.current?.abort();
		const nextController = new AbortController();
		controller.current = nextController;
		setState((current) => ({
			...current,
			status: current.pages.length > 0 ? "refreshing" : "loading",
			error: null,
			loadMoreError: null,
			loadingMore: false
		}));

		try {
			const pages: RecordingList[] = [];
			const seenCursors = new Set<string>();
			let cursor: string | undefined;
			let offset = 0;
			for (let index = 0; index < targetPageCount.current; index += 1) {
				const page = await options.loadPage(
					{
						...options.query,
						limit: options.pageSize,
						offset,
						...(cursor ? { cursor } : {})
					},
					{ signal: nextController.signal }
				);
				pages.push(page);
				offset += page.items.length;
				cursor = page.nextCursor ?? undefined;
				if (cursor && seenCursors.has(cursor)) {
					throw new Error("Recordings pagination cursor repeated");
				}
				if (cursor) seenCursors.add(cursor);
				if (!cursor) break;
			}
			if (nextController.signal.aborted || request !== activeRequest.current) {
				return;
			}
			setState({
				pages,
				status: "ready",
				error: null,
				loadMoreError: null,
				loadingMore: false
			});
		} catch (failure) {
			if (nextController.signal.aborted || request !== activeRequest.current) {
				return;
			}
			const error = toError(failure, "Failed to load recordings");
			setState((current) => ({
				...current,
				status: current.pages.length > 0 ? "ready" : "error",
				error,
				loadingMore: false
			}));
		}
	}, [options.loadPage, options.pageSize, options.query]);

	useEffect(() => {
		if (skipInitialLoad.current) {
			skipInitialLoad.current = false;
			return;
		}
		void replacePages();
		return () => controller.current?.abort();
		// queryKey intentionally captures the serialized primitive query.
	}, [queryKey, replacePages]);

	const recordings = useMemo(
		() => mergePageRecordings(state.pages),
		[state.pages]
	);
	const metadata = state.pages[state.pages.length - 1];
	const groupMetadata = useMemo(
		() => mergeGroupMetadata(state.pages),
		[state.pages]
	);

	const loadMore = useCallback(async (): Promise<boolean> => {
		const lastPage = state.pages[state.pages.length - 1];
		if (
			state.loadingMore ||
			!lastPage?.nextCursor ||
			state.status === "loading"
		) {
			return false;
		}
		const request = ++activeRequest.current;
		controller.current?.abort();
		const nextController = new AbortController();
		controller.current = nextController;
		setState((current) => ({
			...current,
			loadingMore: true,
			loadMoreError: null
		}));
		try {
			const page = await options.loadPage(
				{
					...options.query,
					limit: options.pageSize,
					offset: recordings.length,
					cursor: lastPage.nextCursor
				},
				{ signal: nextController.signal }
			);
			if (
				page.nextCursor &&
				state.pages.some((existing) => existing.nextCursor === page.nextCursor)
			) {
				throw new Error("Recordings pagination cursor repeated");
			}
			if (nextController.signal.aborted || request !== activeRequest.current) {
				return false;
			}
			setState((current) => ({
				...current,
				pages: [...current.pages, page],
				status: "ready",
				loadingMore: false,
				loadMoreError: null,
				error: null
			}));
			return true;
		} catch (failure) {
			if (nextController.signal.aborted || request !== activeRequest.current) {
				return false;
			}
			setState((current) => ({
				...current,
				loadingMore: false,
				loadMoreError: toError(failure, "Failed to load more recordings")
			}));
			return false;
		}
	}, [
		options.loadPage,
		options.pageSize,
		options.query,
		recordings.length,
		state.loadingMore,
		state.pages,
		state.status
	]);

	const removeRecordings = useCallback((ids: string[]) => {
		const removed = new Set(ids);
		setState((current) => {
			const existing = mergePageRecordings(current.pages).filter((row) =>
				removed.has(row.id)
			);
			const removedSize = existing.reduce(
				(total, row) => total + (row.fileSize ?? 0),
				0
			);
			return {
				...current,
				pages: current.pages.map((page) => ({
					...page,
					items: page.items.filter((row) => !removed.has(row.id)),
					total: Math.max(0, page.total - existing.length),
					totalSize: Math.max(0, page.totalSize - removedSize),
					seriesGroups: page.seriesGroups.map((group) => {
						const groupRows = existing.filter(
							(row) => row.seriesRuleId === group.seriesRuleId
						);
						return {
							...group,
							recordingCount: Math.max(
								0,
								group.recordingCount - groupRows.length
							),
							totalSize: Math.max(
								0,
								group.totalSize -
									groupRows.reduce(
										(total, row) => total + (row.fileSize ?? 0),
										0
									)
							)
						};
					}),
					oneOffGroup: page.oneOffGroup
						? reconcileOneOffGroup(page.oneOffGroup, existing)
						: null
				}))
			};
		});
	}, []);

	/** Merge acknowledged or optimistic fields without dropping list metadata. */
	const patchRecordings = useCallback(
		(ids: string[], patch: Partial<Recording>) => {
			const changed = new Set(ids);
			setState((current) => ({
				...current,
				pages: current.pages.map((page) => ({
					...page,
					items: page.items.map((recording) =>
						changed.has(recording.id) ? { ...recording, ...patch } : recording
					)
				}))
			}));
		},
		[]
	);

	return {
		recordings,
		total: metadata?.total ?? 0,
		totalSize: metadata?.totalSize ?? 0,
		limit: metadata?.limit ?? options.pageSize,
		loadedCount: recordings.length,
		pageCount: state.pages.length,
		seriesGroups: groupMetadata.seriesGroups,
		oneOffGroup: groupMetadata.oneOffGroup,
		status: state.status,
		error: state.error,
		loadMoreError: state.loadMoreError,
		loadingMore: state.loadingMore,
		hasMore: Boolean(metadata?.nextCursor),
		loadMore,
		refresh: replacePages,
		removeRecordings,
		patchRecordings
	};
}

/** Reconcile the complete one-off aggregate after an acknowledged deletion. */
function reconcileOneOffGroup(
	group: RecordingOneOffGroup,
	removedRows: Recording[]
): RecordingOneOffGroup {
	const oneOffRows = removedRows.filter((row) => row.seriesRuleId === null);
	return {
		recordingCount: Math.max(0, group.recordingCount - oneOffRows.length),
		totalSize: Math.max(
			0,
			group.totalSize -
				oneOffRows.reduce((total, row) => total + (row.fileSize ?? 0), 0)
		)
	};
}

function mergePageRecordings(pages: RecordingList[]): RecordingListItem[] {
	const seen = new Set<string>();
	const rows: RecordingListItem[] = [];
	for (const page of pages) {
		for (const row of page.items) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			rows.push(row);
		}
	}
	return rows;
}

function mergeGroupMetadata(pages: RecordingList[]): {
	seriesGroups: Map<string, RecordingSeriesGroup>;
	oneOffGroup: RecordingOneOffGroup | null;
} {
	const seriesGroups = new Map<string, RecordingSeriesGroup>();
	let oneOffGroup: RecordingOneOffGroup | null = null;
	for (const page of pages) {
		for (const group of page.seriesGroups) {
			seriesGroups.set(group.seriesRuleId, group);
		}
		if (page.oneOffGroup) oneOffGroup = page.oneOffGroup;
	}
	return { seriesGroups, oneOffGroup };
}

function toError(failure: unknown, fallback: string): Error {
	return failure instanceof Error ? failure : new Error(fallback);
}
