"use client";

import type {
	ChannelListItem,
	EventMessage,
	Recording,
	RecordingListItem,
	RecordingListDirection,
	RecordingListSort,
	RecordingPatch,
	RecordingStatus
} from "@signalhaven/shared";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
	Eye,
	Film,
	LayoutGrid,
	List,
	Search,
	Shield,
	SlidersHorizontal,
	Trash2,
	X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import {
	deleteRecording,
	listChannels,
	listRecordings
} from "../../lib/api-client";
import { parseRecordingEvent } from "../../lib/recording-events";
import { useWebSocketEvents } from "../../lib/ws-client";
import { Button } from "../_ui/Button";
import { EmptyState } from "../_ui/EmptyState";
import { IconButton } from "../_ui/IconButton";
import { Input } from "../_ui/Input";
import { PageHeader } from "../_ui/PageHeader";
import { Spinner } from "../_ui/Spinner";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle
} from "../_ui/Modal";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "../_ui/Select";
import { cn } from "../_ui/cn";
import { use24HourClock } from "../_preferences/PreferencesProvider";

import {
	formatBytes,
	groupRecordings,
	initialRecordingsState,
	recordingsReducer,
	type RecordingsGroupBy,
	type RecordingsViewMode
} from "./state";
import {
	defaultRecordingsUrlState,
	RECORDINGS_PAGE_SIZE,
	serializeRecordingsUrlState,
	toRecordingListQuery,
	type RecordingsUrlState
} from "./query-state";
import {
	useRecordingsPagination,
	type RecordingPageLoader
} from "./useRecordingsPagination";
import { buildRecordingFixturePage } from "./fixture-page";
import { useOptimisticRecordingMutations } from "./useOptimisticRecordingMutations";

/**
 * Defer artwork and row controls until results exist so an empty library does
 * not pay their download and parse cost during its first paint.
 */
const RecordingLibraryItem = dynamic(() =>
	import("./RecordingLibraryItem").then(
		({ RecordingLibraryItem }) => RecordingLibraryItem
	)
);

/** Status options surfaced in the filter dropdown. */
const STATUS_OPTIONS: ReadonlyArray<{
	value: RecordingStatus | "all";
	label: string;
}> = [
	{ value: "all", label: "All statuses" },
	{ value: "scheduled", label: "Scheduled" },
	{ value: "recording", label: "Recording" },
	{ value: "completed", label: "Completed" },
	{ value: "failed", label: "Failed" },
	{ value: "cancelled", label: "Cancelled" }
];

/** Stable labels keep selected values visible before dropdown content mounts. */
const SORT_OPTIONS: ReadonlyArray<{
	value: RecordingListSort;
	label: string;
}> = [
	{ value: "scheduledStart", label: "Scheduled date" },
	{ value: "actualStart", label: "Recorded date" },
	{ value: "createdAt", label: "Date added" }
];

const DIRECTION_OPTIONS: ReadonlyArray<{
	value: RecordingListDirection;
	label: string;
}> = [
	{ value: "desc", label: "Newest first" },
	{ value: "asc", label: "Oldest first" }
];

const GROUP_OPTIONS: ReadonlyArray<{
	value: RecordingsGroupBy;
	label: string;
}> = [
	{ value: "none", label: "No grouping" },
	{ value: "series", label: "By series" }
];

export interface RecordingsPageProps {
	/** Optional fixture override used by tests (skips network). */
	initialRecordings?: Array<Recording | RecordingListItem> | undefined;
	/** Optional channel fixtures for the channel filter (skips network). */
	initialChannels?: ChannelListItem[] | undefined;
	/** Parsed URL state supplied by the route entry point. */
	initialUrlState?: RecordingsUrlState | undefined;
	/** Network override for the listing call (used by tests). */
	loadRecordings?: RecordingPageLoader | undefined;
	/** Network override for the channels call (used by tests). */
	loadChannels?: (() => Promise<ChannelListItem[]>) | undefined;
	/** Delete override (defaults to DELETE /api/v1/recordings/:id). */
	onDelete?:
		| ((
				id: string,
				options?: { overrideProtection?: boolean }
		  ) => Promise<void>)
		| undefined;
	/** Patch override used to verify optimistic update and rollback behavior. */
	onPatch?:
		| ((id: string, patch: RecordingPatch) => Promise<Recording>)
		| undefined;
	/** Disable the recording lifecycle subscription in deterministic tests. */
	enableWebSocket?: boolean | undefined;
}

interface RecordingsHeaderProps {
	loadedCount: number;
	limit: number;
	loading?: boolean;
	total: number;
	totalSize: number;
}

/**
 * Keeps the page heading stable while the initial recordings request loads.
 */
function RecordingsHeader({
	loadedCount,
	limit,
	loading = false,
	total,
	totalSize
}: RecordingsHeaderProps) {
	return (
		<div className="space-y-4 pb-1 pt-1 md:space-y-5 md:pt-3">
			<PageHeader
				headingId="recordings-heading"
				title="Your recordings"
				description="Everything you’ve saved, ready when you are."
			/>
			{loading ? (
				<p className="text-sm text-secondary" role="status">
					Loading your library…
				</p>
			) : (
				<p
					className="text-sm font-medium text-secondary"
					data-testid="recordings-pagination-summary"
				>
					<span className="text-primary">
						{total} {total === 1 ? "recording" : "recordings"}
					</span>
					<span aria-hidden="true"> · </span>
					{formatBytes(totalSize)} on disk
					<span className="sr-only">
						{` · ${total} total · showing ${loadedCount} · ${limit} per page`}
					</span>
				</p>
			)}
		</div>
	);
}

/**
 * Recordings library screen (rrainn/SignalHaven#U8-recordings).
 *
 * Surfaces the persisted recordings list with grid/list toggle, group
 * by series, filter by status/channel/date, full-text search, and
 * bulk delete (with confirmation). Series groups are clickable and
 * route to `/recordings/series/[seriesRuleId]` for the per-series
 * detail view; individual rows route to `/recordings/[id]` for
 * playback.
 */
export function RecordingsPage(props: RecordingsPageProps) {
	const useFixture = props.initialRecordings !== undefined;
	const router = useRouter();
	const use24Hour = use24HourClock();
	const initialUrlState = props.initialUrlState ?? defaultRecordingsUrlState;

	const [state, dispatch] = useReducer(recordingsReducer, undefined, () => ({
		...initialRecordingsState,
		recordings: [],
		filters: initialUrlState.filters,
		sort: initialUrlState.sort,
		direction: initialUrlState.direction,
		view: initialUrlState.view,
		groupBy: initialUrlState.groupBy
	}));
	const [targetPageCount, setTargetPageCount] = useState(
		initialUrlState.pageCount
	);
	const debouncedSearch = useDebouncedValue(state.filters.search, 250);

	const [channels, setChannels] = useState<ChannelListItem[]>(
		props.initialChannels ?? []
	);
	const [pendingDelete, setPendingDelete] = useState<
		| { kind: "single"; recording: RecordingListItem }
		| { kind: "bulk"; ids: string[] }
		| null
	>(null);
	const [deleting, setDeleting] = useState(false);
	const [actionError, setActionError] = useState<Error | null>(null);

	const serverQuery = useMemo(
		() =>
			toRecordingListQuery({
				filters: { ...state.filters, search: debouncedSearch },
				sort: state.sort,
				direction: state.direction
			}),
		[
			debouncedSearch,
			state.direction,
			state.filters.channelId,
			state.filters.from,
			state.filters.status,
			state.filters.to,
			state.sort
		]
	);
	const loadPage = useCallback<RecordingPageLoader>(
		async (query, options) => {
			if (props.loadRecordings) return props.loadRecordings(query, options);
			if (props.initialRecordings) {
				return buildRecordingFixturePage(props.initialRecordings, query);
			}
			return listRecordings(query, options);
		},
		[props.initialRecordings, props.loadRecordings]
	);
	const initialPage = useMemo(
		() =>
			props.initialRecordings && initialUrlState.pageCount === 1
				? buildRecordingFixturePage(props.initialRecordings, {
						...toRecordingListQuery(initialUrlState),
						limit: RECORDINGS_PAGE_SIZE,
						offset: 0
					})
				: undefined,
		[initialUrlState, props.initialRecordings]
	);
	const pagination = useRecordingsPagination({
		query: serverQuery,
		pageSize: RECORDINGS_PAGE_SIZE,
		targetPageCount,
		loadPage,
		...(initialPage ? { initialPage } : {})
	});

	// A refresh can remove the final page; keep the shareable URL truthful.
	useEffect(() => {
		if (
			pagination.status === "ready" &&
			!pagination.hasMore &&
			pagination.pageCount > 0 &&
			pagination.pageCount < targetPageCount
		) {
			setTargetPageCount(pagination.pageCount);
		}
	}, [
		pagination.hasMore,
		pagination.pageCount,
		pagination.status,
		targetPageCount
	]);

	// Keep the pure selection reducer aligned with the server-owned page rows.
	useEffect(() => {
		dispatch({ type: "set-recordings", recordings: pagination.recordings });
	}, [pagination.recordings]);

	// Channels are independent of the recordings query and can load in parallel.
	useEffect(() => {
		if (useFixture || props.initialChannels !== undefined) return;
		let cancelled = false;
		const load =
			props.loadChannels ?? (async () => (await listChannels()).items);
		void load()
			.then((rows) => {
				if (cancelled) return;
				setChannels(rows);
			})
			.catch((failure: unknown) => {
				if (!cancelled)
					console.warn("Failed to load recording channels", failure);
			});
		return () => {
			cancelled = true;
		};
	}, [props.initialChannels, props.loadChannels, useFixture]);

	// Persist query and page decorations without a server navigation.
	useEffect(() => {
		const query = serializeRecordingsUrlState({
			filters: state.filters,
			sort: state.sort,
			direction: state.direction,
			view: state.view,
			groupBy: state.groupBy,
			pageCount: targetPageCount
		});
		const url = query ? `/recordings?${query}` : "/recordings";
		window.history.replaceState(window.history.state, "", url);
	}, [
		state.direction,
		state.filters,
		state.groupBy,
		state.sort,
		state.view,
		targetPageCount
	]);

	const reconcileRecordings = useCallback(
		() => pagination.refresh(),
		[pagination.refresh]
	);
	const handleRecordingEvent = useCallback(
		(event: EventMessage) => {
			const parsed = parseRecordingEvent(event);
			if (!parsed) return;
			// A bounded requery handles membership, totals, and page fill correctly.
			void pagination.refresh();
		},
		[pagination.refresh]
	);

	useWebSocketEvents({
		topics: ["recordings"],
		enabled: props.enableWebSocket !== false && !useFixture,
		onEvent: handleRecordingEvent,
		onReconnect: reconcileRecordings
	});

	const visible = state.recordings;
	const groups = useMemo(
		() => groupRecordings(visible, state.groupBy),
		[visible, state.groupBy]
	);
	const channelMap = useMemo(() => {
		const m = new Map<string, ChannelListItem>();
		for (const c of channels) m.set(c.id, c);
		return m;
	}, [channels]);

	const applyLocalPatch = useCallback(
		(ids: string[], patch: Partial<Recording>) =>
			dispatch({
				type: "patch-recordings",
				recordingIds: ids,
				patch
			}),
		[]
	);
	const recordingMutations = useOptimisticRecordingMutations({
		recordings: state.recordings,
		apply: applyLocalPatch,
		...(props.onPatch ? { send: props.onPatch } : {})
	});

	const onConfirmDelete = useCallback(
		async (includeProtected = false) => {
			if (!pendingDelete) return;
			setDeleting(true);
			const requestedIds =
				pendingDelete.kind === "single"
					? [pendingDelete.recording.id]
					: pendingDelete.ids;
			const recordings = requestedIds.flatMap((id) => {
				const recording = state.recordings.find((row) => row.id === id);
				return recording ? [recording] : [];
			});
			const targets = includeProtected
				? recordings
				: recordings.filter((recording) => !recording.manuallyProtected);
			const remover =
				props.onDelete ??
				((id: string, options?: { overrideProtection?: boolean }) =>
					deleteRecording(id, options));
			setActionError(null);
			try {
				const results = await Promise.allSettled(
					targets.map((recording) =>
						includeProtected && recording.manuallyProtected
							? remover(recording.id, { overrideProtection: true })
							: remover(recording.id)
					)
				);
				const removedIds: string[] = [];
				const failedIds: string[] = [];
				results.forEach((result, index) => {
					const target = targets[index];
					if (!target) return;
					if (result.status === "fulfilled") removedIds.push(target.id);
					else failedIds.push(target.id);
				});
				if (removedIds.length > 0) {
					pagination.removeRecordings(removedIds);
					dispatch({ type: "remove-recordings", recordingIds: removedIds });
				}
				if (failedIds.length === 0) {
					setPendingDelete(null);
				} else {
					setActionError(
						new Error(
							failedIds.length === 1
								? "The recording could not be deleted."
								: `${failedIds.length} recordings could not be deleted.`
						)
					);
				}
				// Fill the final loaded page and refresh server-owned aggregates.
				if (removedIds.length > 0 && !useFixture) void pagination.refresh();
			} finally {
				setDeleting(false);
			}
		},
		[pagination, pendingDelete, props.onDelete, state.recordings, useFixture]
	);

	const selectionList = useMemo(
		() => Array.from(state.selection),
		[state.selection]
	);
	const selectedRecordings = useMemo(
		() =>
			selectionList.flatMap((id) => {
				const recording = state.recordings.find((row) => row.id === id);
				return recording ? [recording] : [];
			}),
		[selectionList, state.recordings]
	);
	const selectedMutationPending = selectedRecordings.some((recording) =>
		recordingMutations.pendingIds.has(recording.id)
	);
	const pendingDeleteRecordings = useMemo(() => {
		if (!pendingDelete) return [];
		const ids =
			pendingDelete.kind === "single"
				? [pendingDelete.recording.id]
				: pendingDelete.ids;
		return ids.flatMap((id) => {
			const recording = state.recordings.find((row) => row.id === id);
			return recording ? [recording] : [];
		});
	}, [pendingDelete, state.recordings]);
	const protectedDeleteCount = pendingDeleteRecordings.filter(
		(recording) => recording.manuallyProtected
	).length;
	const unprotectedDeleteCount =
		pendingDeleteRecordings.length - protectedDeleteCount;

	const queryPending = state.filters.search !== debouncedSearch;
	const urlState: RecordingsUrlState = {
		filters: state.filters,
		sort: state.sort,
		direction: state.direction,
		view: state.view,
		groupBy: state.groupBy,
		pageCount: targetPageCount
	};
	const serializedState = serializeRecordingsUrlState(urlState);
	const returnPath = serializedState
		? `/recordings?${serializedState}`
		: "/recordings";
	const recordingPath = (id: string) =>
		`/recordings/${id}?returnTo=${encodeURIComponent(returnPath)}`;
	const seriesPath = (id: string) =>
		`/recordings/series/${id}?returnTo=${encodeURIComponent(returnPath)}`;
	const loadNextPage = () => {
		void pagination.loadMore().then((loaded) => {
			if (loaded) setTargetPageCount((count) => count + 1);
		});
	};
	const hasActiveFilters =
		state.filters.search !== "" ||
		state.filters.status !== null ||
		state.filters.channelId !== null ||
		state.filters.from !== null ||
		state.filters.to !== null;
	const clearFilters = () => {
		setTargetPageCount(1);
		dispatch({ type: "clear-filters" });
	};

	// Pagination resolves one render before its rows reach the selection reducer.
	// Keep that handoff in the loading phase so a populated response never looks empty.
	const initialRowsPending =
		pagination.status === "ready" &&
		pagination.loadedCount > 0 &&
		state.recordings.length === 0;
	const initialLoading =
		(pagination.status === "loading" && pagination.loadedCount === 0) ||
		initialRowsPending;

	if (pagination.status === "error" && pagination.loadedCount === 0) {
		return (
			<EmptyState
				data-testid="recordings-error"
				icon={<Film />}
				title="Couldn't load recordings"
				description={pagination.error?.message ?? "Please try again."}
				action={
					<Button onClick={() => void pagination.refresh()}>Try again</Button>
				}
			/>
		);
	}

	return (
		<section
			data-testid="recordings-page"
			className="flex flex-col gap-4"
			aria-labelledby="recordings-heading"
		>
			<RecordingsHeader
				loadedCount={pagination.loadedCount}
				limit={pagination.limit}
				loading={initialLoading}
				total={pagination.total}
				totalSize={pagination.totalSize}
			/>

			<Toolbar
				searchValue={state.filters.search}
				onSearch={(s) => {
					setTargetPageCount(1);
					dispatch({ type: "set-search", search: s });
				}}
				statusValue={state.filters.status ?? "all"}
				onStatus={(v) => {
					setTargetPageCount(1);
					dispatch({
						type: "set-status",
						status: v === "all" ? null : v
					});
				}}
				channelValue={state.filters.channelId ?? "all"}
				channels={channels}
				onChannel={(v) => {
					setTargetPageCount(1);
					dispatch({
						type: "set-channel",
						channelId: v === "all" ? null : v
					});
				}}
				fromValue={state.filters.from ?? ""}
				onFrom={(v) => {
					setTargetPageCount(1);
					dispatch({ type: "set-from", from: v || null });
				}}
				toValue={state.filters.to ?? ""}
				onTo={(v) => {
					setTargetPageCount(1);
					dispatch({ type: "set-to", to: v || null });
				}}
				sort={state.sort}
				direction={state.direction}
				onSort={(sort) => {
					setTargetPageCount(1);
					dispatch({ type: "set-sort", sort });
				}}
				onDirection={(direction) => {
					setTargetPageCount(1);
					dispatch({ type: "set-direction", direction });
				}}
				view={state.view}
				onView={(v) => dispatch({ type: "set-view", view: v })}
				groupBy={state.groupBy}
				onGroupBy={(v) => dispatch({ type: "set-group-by", groupBy: v })}
				onClearFilters={clearFilters}
			/>

			{queryPending || pagination.status === "refreshing" ? (
				<p
					className="text-sm text-secondary"
					role="status"
					data-testid="recordings-refreshing"
				>
					Updating results…
				</p>
			) : null}

			{actionError ||
			recordingMutations.error ||
			(pagination.error && pagination.loadedCount > 0) ? (
				<div
					className="flex items-center justify-between gap-3 rounded-lg border border-danger/40 p-3"
					data-testid="recordings-refresh-error"
				>
					<p className="text-sm text-primary">
						{actionError?.message ??
							recordingMutations.error?.message ??
							pagination.error?.message}
					</p>
					{pagination.error ? (
						<Button variant="outline" onClick={() => void pagination.refresh()}>
							Retry
						</Button>
					) : null}
				</div>
			) : null}

			{selectionList.length > 0 ? (
				<div
					data-testid="recordings-bulk-bar"
					className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2"
				>
					<span className="text-sm text-primary">
						{selectionList.length} selected
					</span>
					<span className="text-xs text-secondary">
						{
							selectedRecordings.filter(
								(recording) => recording.manuallyProtected
							).length
						}{" "}
						protected ·{" "}
						{
							selectedRecordings.filter((recording) => recording.watchedAt)
								.length
						}{" "}
						watched
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => dispatch({ type: "clear-selection" })}
					>
						Clear
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={
							selectedMutationPending ||
							selectedRecordings.every(
								(recording) => recording.manuallyProtected
							)
						}
						onClick={() =>
							void recordingMutations.mutate(
								selectedRecordings
									.filter((recording) => !recording.manuallyProtected)
									.map((recording) => recording.id),
								{ manuallyProtected: true },
								{ manuallyProtected: true }
							)
						}
					>
						<Shield aria-hidden="true" className="h-4 w-4" />
						Protect
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={
							selectedMutationPending ||
							selectedRecordings.every(
								(recording) => !recording.manuallyProtected
							)
						}
						onClick={() =>
							void recordingMutations.mutate(
								selectedRecordings
									.filter((recording) => recording.manuallyProtected)
									.map((recording) => recording.id),
								{ manuallyProtected: false },
								{ manuallyProtected: false }
							)
						}
					>
						Unprotect
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={
							selectedMutationPending ||
							selectedRecordings.every(
								(recording) => recording.watchedAt !== null
							)
						}
						onClick={() =>
							void recordingMutations.mutate(
								selectedRecordings
									.filter((recording) => recording.watchedAt === null)
									.map((recording) => recording.id),
								{ watched: true },
								{ watchedAt: new Date().toISOString() }
							)
						}
					>
						<Eye aria-hidden="true" className="h-4 w-4" />
						Mark watched
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={
							selectedMutationPending ||
							selectedRecordings.every(
								(recording) => recording.watchedAt === null
							)
						}
						onClick={() =>
							void recordingMutations.mutate(
								selectedRecordings
									.filter((recording) => recording.watchedAt !== null)
									.map((recording) => recording.id),
								{ watched: false },
								{ watchedAt: null }
							)
						}
					>
						Mark unwatched
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={selectedMutationPending}
						onClick={() =>
							setPendingDelete({ kind: "bulk", ids: selectionList })
						}
						data-testid="recordings-bulk-delete"
					>
						<Trash2 aria-hidden="true" className="h-4 w-4" />
						Delete selected
					</Button>
				</div>
			) : null}

			{initialLoading ? (
				<div
					data-testid="recordings-loading"
					aria-busy="true"
					className="flex min-h-60 flex-col items-center justify-center gap-3 px-6 text-center"
				>
					<Spinner size="lg" label="Loading recordings" />
					{/* Keep loading feedback visible while the initial library request settles. */}
					<h2 className="text-2xl font-semibold tracking-tight text-primary">
						Loading your recordings
					</h2>
				</div>
			) : visible.length === 0 ? (
				<EmptyRecordingsState
					filtered={hasActiveFilters}
					onBrowseGuide={() => router.push("/guide")}
					onClearFilters={clearFilters}
				/>
			) : state.groupBy === "series" ? (
				<div className="flex flex-col gap-6">
					{groups.map((group) => {
						const completeSeries = group.isSeries
							? pagination.seriesGroups.get(group.key)
							: undefined;
						const title = completeSeries?.title ?? group.label;
						return (
							<section
								key={group.key}
								data-testid={`series-group-${group.key}`}
							>
								<div className="mb-2 flex items-baseline justify-between gap-3">
									{group.isSeries ? (
										<button
											type="button"
											className="text-lg font-semibold text-primary hover:underline"
											onClick={() => router.push(seriesPath(group.key))}
											data-testid={`series-link-${group.key}`}
										>
											{title}
										</button>
									) : (
										<h2 className="text-lg font-semibold text-primary">
											{title}
										</h2>
									)}
									<span className="text-xs text-secondary">
										{group.isSeries
											? (completeSeries?.recordingCount ??
												group.recordings.length)
											: (pagination.oneOffGroup?.recordingCount ??
												group.recordings.length)}{" "}
										items ·{" "}
										{formatBytes(
											group.isSeries
												? (completeSeries?.totalSize ?? group.totalSize)
												: (pagination.oneOffGroup?.totalSize ?? group.totalSize)
										)}
									</span>
								</div>
								<RecordingsList
									view={state.view}
									recordings={group.recordings}
									selection={state.selection}
									channelMap={channelMap}
									use24Hour={use24Hour}
									pendingRecordingIds={recordingMutations.pendingIds}
									onToggleSelect={(id) =>
										dispatch({ type: "toggle-selection", recordingId: id })
									}
									onPlay={(r) => router.push(recordingPath(r.id))}
									onToggleProtected={(recording) =>
										void recordingMutations.mutate(
											[recording.id],
											{ manuallyProtected: !recording.manuallyProtected },
											{ manuallyProtected: !recording.manuallyProtected }
										)
									}
									onToggleWatched={(recording) =>
										void recordingMutations.mutate(
											[recording.id],
											{ watched: recording.watchedAt === null },
											{
												watchedAt:
													recording.watchedAt === null
														? new Date().toISOString()
														: null
											}
										)
									}
									onDeleteOne={(r) =>
										setPendingDelete({ kind: "single", recording: r })
									}
								/>
							</section>
						);
					})}
				</div>
			) : (
				<RecordingsList
					view={state.view}
					recordings={visible}
					selection={state.selection}
					channelMap={channelMap}
					use24Hour={use24Hour}
					pendingRecordingIds={recordingMutations.pendingIds}
					onToggleSelect={(id) =>
						dispatch({ type: "toggle-selection", recordingId: id })
					}
					onPlay={(r) => router.push(recordingPath(r.id))}
					onToggleProtected={(recording) =>
						void recordingMutations.mutate(
							[recording.id],
							{ manuallyProtected: !recording.manuallyProtected },
							{ manuallyProtected: !recording.manuallyProtected }
						)
					}
					onToggleWatched={(recording) =>
						void recordingMutations.mutate(
							[recording.id],
							{ watched: recording.watchedAt === null },
							{
								watchedAt:
									recording.watchedAt === null ? new Date().toISOString() : null
							}
						)
					}
					onDeleteOne={(r) =>
						setPendingDelete({ kind: "single", recording: r })
					}
				/>
			)}

			{pagination.loadMoreError ? (
				<div
					className="flex items-center justify-center gap-3 rounded-lg border border-danger/40 p-3"
					data-testid="recordings-load-more-error"
				>
					<p className="text-sm text-primary">
						{pagination.loadMoreError.message}
					</p>
					<Button variant="outline" onClick={loadNextPage}>
						Retry
					</Button>
				</div>
			) : pagination.hasMore ? (
				<div className="flex justify-center">
					<Button
						variant="outline"
						disabled={pagination.loadingMore}
						aria-busy={pagination.loadingMore}
						data-testid="recordings-load-more"
						onClick={loadNextPage}
					>
						{pagination.loadingMore ? "Loading more…" : "Load more"}
					</Button>
				</div>
			) : pagination.total > 0 ? (
				<p
					className="text-center text-sm text-secondary"
					role="status"
					data-testid="recordings-end"
				>
					All {pagination.total} recordings loaded
				</p>
			) : null}

			<Modal
				open={pendingDelete !== null}
				onOpenChange={(o) => {
					if (!o) setPendingDelete(null);
				}}
			>
				<ModalContent data-testid="recordings-delete-confirm">
					<ModalHeader>
						<ModalTitle>
							{pendingDelete?.kind === "bulk"
								? `Delete ${pendingDelete.ids.length} recordings?`
								: "Delete recording?"}
						</ModalTitle>
						<ModalDescription>
							{protectedDeleteCount > 0
								? `${protectedDeleteCount} selected recording${
										protectedDeleteCount === 1 ? " is" : "s are"
									} protected. Choose whether to keep protected recordings or explicitly override protection.`
								: pendingDelete?.kind === "bulk"
									? "This permanently removes the selected files and their library entries."
									: `This permanently removes "${pendingDelete?.recording.title}" and its file.`}
						</ModalDescription>
						{actionError ? (
							<p className="text-sm text-danger" role="alert">
								{actionError.message}
							</p>
						) : null}
					</ModalHeader>
					<ModalFooter>
						<Button
							variant="outline"
							onClick={() => setPendingDelete(null)}
							disabled={deleting}
						>
							Cancel
						</Button>
						{protectedDeleteCount > 0 && unprotectedDeleteCount > 0 ? (
							<Button
								variant="danger"
								onClick={() => void onConfirmDelete(false)}
								disabled={deleting}
								data-testid="recordings-delete-unprotected-button"
							>
								{deleting
									? "Deleting…"
									: `Delete ${unprotectedDeleteCount} unprotected`}
							</Button>
						) : null}
						<Button
							variant="danger"
							onClick={() => void onConfirmDelete(protectedDeleteCount > 0)}
							disabled={deleting}
							data-testid="recordings-delete-confirm-button"
						>
							{deleting
								? "Deleting…"
								: protectedDeleteCount > 0
									? pendingDeleteRecordings.length === 1
										? "Unprotect & delete"
										: "Delete all, including protected"
									: "Delete"}
						</Button>
					</ModalFooter>
				</ModalContent>
			</Modal>
		</section>
	);
}

/**
 * Debounce only the server query; the controlled search input remains
 * responsive and stale requests are independently aborted by the pager.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebounced(value), delayMs);
		return () => window.clearTimeout(timer);
	}, [delayMs, value]);
	return debounced;
}

/* ── Subcomponents ───────────────────────────────────────────────── */

interface ToolbarProps {
	searchValue: string;
	onSearch: (s: string) => void;
	statusValue: RecordingStatus | "all";
	onStatus: (v: RecordingStatus | "all") => void;
	channelValue: string;
	channels: ChannelListItem[];
	onChannel: (v: string) => void;
	fromValue: string;
	onFrom: (v: string) => void;
	toValue: string;
	onTo: (v: string) => void;
	sort: RecordingListSort;
	direction: RecordingListDirection;
	onSort: (sort: RecordingListSort) => void;
	onDirection: (direction: RecordingListDirection) => void;
	view: RecordingsViewMode;
	onView: (v: RecordingsViewMode) => void;
	groupBy: RecordingsGroupBy;
	onGroupBy: (v: RecordingsGroupBy) => void;
	onClearFilters: () => void;
}

function Toolbar(props: ToolbarProps) {
	const [filtersOpen, setFiltersOpen] = useState(false);
	const channelLabel =
		props.channelValue === "all"
			? "All channels"
			: (props.channels.find((channel) => channel.id === props.channelValue)
					?.name ?? "All channels");
	const hasActiveFilters =
		props.searchValue !== "" ||
		props.statusValue !== "all" ||
		props.channelValue !== "all" ||
		props.fromValue !== "" ||
		props.toValue !== "";

	return (
		<div
			data-testid="recordings-toolbar"
			className="overflow-hidden rounded-xl border border-border bg-surface/70 shadow-sm"
		>
			<div className="flex items-center gap-2 p-3 md:p-4">
				<label className="min-w-0 flex-1">
					<span className="sr-only">Search recordings</span>
					<div className="relative">
						<Search
							aria-hidden="true"
							className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted"
						/>
						<Input
							data-testid="recordings-search"
							type="search"
							size="lg"
							placeholder="Search recordings"
							className="border-0 bg-surface-muted/70 pl-10 shadow-none focus-visible:ring-offset-0"
							value={props.searchValue}
							onChange={(e) => props.onSearch(e.target.value)}
						/>
					</div>
				</label>

				<Button
					variant="outline"
					className="shrink-0 sm:hidden"
					aria-controls="recordings-filter-controls"
					aria-expanded={filtersOpen}
					onClick={() => setFiltersOpen((open) => !open)}
				>
					<SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
					Filters
				</Button>
			</div>

			<div
				id="recordings-filter-controls"
				data-mobile-open={filtersOpen ? "true" : "false"}
				className={cn(
					"border-t border-border",
					filtersOpen ? "block" : "hidden",
					"sm:block"
				)}
			>
				<div className="flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center md:p-4">
					<span className="mr-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
						Filter
					</span>

					<label>
						<span className="sr-only">Status</span>
						<Select
							value={props.statusValue}
							onValueChange={(v) =>
								props.onStatus(v as RecordingStatus | "all")
							}
						>
							<SelectTrigger
								data-testid="recordings-filter-status"
								className="w-full sm:w-[9.5rem]"
							>
								<SelectValue>
									{STATUS_OPTIONS.find(
										(option) => option.value === props.statusValue
									)?.label ?? "All statuses"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{STATUS_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<label>
						<span className="sr-only">Channel</span>
						<Select value={props.channelValue} onValueChange={props.onChannel}>
							<SelectTrigger
								data-testid="recordings-filter-channel"
								className="w-full sm:w-[11.5rem]"
							>
								<SelectValue>{channelLabel}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All channels</SelectItem>
								{props.channels.map((c) => (
									<SelectItem key={c.id} value={c.id}>
										{c.number} {c.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<fieldset className="flex min-w-0 items-center gap-2">
						<legend className="sr-only">Recording date range</legend>
						<label className="min-w-0 flex-1 sm:flex-none">
							<span className="sr-only">From date</span>
							<Input
								data-testid="recordings-filter-from"
								type="date"
								value={props.fromValue.slice(0, 10)}
								onChange={(e) => props.onFrom(e.target.value)}
								className="min-w-0 sm:w-[9.5rem]"
							/>
						</label>
						<span className="text-xs text-muted" aria-hidden="true">
							to
						</span>
						<label className="min-w-0 flex-1 sm:flex-none">
							<span className="sr-only">To date</span>
							<Input
								data-testid="recordings-filter-to"
								type="date"
								value={props.toValue.slice(0, 10)}
								onChange={(e) => props.onTo(e.target.value)}
								className="min-w-0 sm:w-[9.5rem]"
							/>
						</label>
					</fieldset>

					<Button
						variant="ghost"
						size="sm"
						onClick={props.onClearFilters}
						disabled={!hasActiveFilters}
						data-testid="recordings-clear-filters"
						aria-label="Clear filters"
						className="self-start text-secondary sm:self-auto"
					>
						<X aria-hidden="true" className="h-4 w-4" />
						Clear filters
					</Button>
				</div>

				<div className="flex flex-col gap-2 border-t border-border/70 bg-surface-muted/30 p-3 sm:flex-row sm:flex-wrap sm:items-center md:p-4">
					<span className="mr-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
						Arrange
					</span>

					<label>
						<span className="sr-only">Sort recordings</span>
						<Select
							value={props.sort}
							onValueChange={(value) =>
								props.onSort(value as RecordingListSort)
							}
						>
							<SelectTrigger
								data-testid="recordings-sort"
								className="w-full sm:w-[10.5rem]"
							>
								<SelectValue>
									{SORT_OPTIONS.find((option) => option.value === props.sort)
										?.label ?? "Scheduled date"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{SORT_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<label>
						<span className="sr-only">Sort order</span>
						<Select
							value={props.direction}
							onValueChange={(value) =>
								props.onDirection(value as RecordingListDirection)
							}
						>
							<SelectTrigger
								data-testid="recordings-direction"
								className="w-full sm:w-[9.5rem]"
							>
								<SelectValue>
									{DIRECTION_OPTIONS.find(
										(option) => option.value === props.direction
									)?.label ?? "Newest first"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{DIRECTION_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<label>
						<span className="sr-only">Group recordings</span>
						<Select
							value={props.groupBy}
							onValueChange={(v) => props.onGroupBy(v as RecordingsGroupBy)}
						>
							<SelectTrigger
								data-testid="recordings-group-by"
								className="w-full sm:w-[9.5rem]"
							>
								<SelectValue>
									{GROUP_OPTIONS.find(
										(option) => option.value === props.groupBy
									)?.label ?? "No grouping"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{GROUP_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<div
						role="group"
						aria-label="Recording view"
						className="flex w-fit overflow-hidden rounded-md border border-border bg-surface"
					>
						<IconButton
							data-testid="recordings-view-grid"
							aria-label="Grid view"
							aria-pressed={props.view === "grid"}
							onClick={() => props.onView("grid")}
							className={cn(
								"rounded-none",
								props.view === "grid" && "bg-surface-muted"
							)}
						>
							<LayoutGrid aria-hidden="true" className="h-4 w-4" />
						</IconButton>
						<IconButton
							data-testid="recordings-view-list"
							aria-label="List view"
							aria-pressed={props.view === "list"}
							onClick={() => props.onView("list")}
							className={cn(
								"rounded-none",
								props.view === "list" && "bg-surface-muted"
							)}
						>
							<List aria-hidden="true" className="h-4 w-4" />
						</IconButton>
					</div>
				</div>
			</div>
		</div>
	);
}

interface EmptyRecordingsStateProps {
	filtered: boolean;
	onBrowseGuide: () => void;
	onClearFilters: () => void;
}

/**
 * Give an empty library a useful next step while keeping filtered-zero states
 * compact and easy to recover from.
 */
function EmptyRecordingsState({
	filtered,
	onBrowseGuide,
	onClearFilters
}: EmptyRecordingsStateProps) {
	if (filtered) {
		return (
			<div
				data-testid="recordings-empty"
				className="flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-12 text-center"
			>
				<Search aria-hidden="true" className="h-8 w-8 text-muted" />
				<h2 className="text-lg font-semibold text-primary">No matches found</h2>
				<p className="max-w-md text-sm leading-6 text-secondary">
					Try a different search or clear your filters to see the full library.
				</p>
				<Button variant="outline" onClick={onClearFilters} className="mt-2">
					Clear filters
				</Button>
			</div>
		);
	}

	return (
		<div
			data-testid="recordings-empty"
			className="flex min-h-60 flex-col items-center justify-center px-6 py-5 text-center"
		>
			{/* Reuse the bundled icon so the post-fetch empty state has no image request. */}
			<div
				aria-hidden="true"
				className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent"
			>
				<Film className="h-6 w-6" />
			</div>
			<h2 className="text-xl font-semibold tracking-tight text-primary md:text-2xl">
				Your library is ready
			</h2>
			<p className="mt-2 max-w-xl text-sm leading-6 text-secondary md:text-base">
				Recordings you schedule will appear here automatically.
			</p>
			<Button size="lg" onClick={onBrowseGuide} className="mt-4">
				Browse the guide
			</Button>
		</div>
	);
}

interface RecordingsListProps {
	view: RecordingsViewMode;
	recordings: RecordingListItem[];
	selection: ReadonlySet<string>;
	pendingRecordingIds: ReadonlySet<string>;
	channelMap: Map<string, ChannelListItem>;
	use24Hour: boolean;
	onToggleSelect: (id: string) => void;
	onPlay: (recording: RecordingListItem) => void;
	onDeleteOne: (recording: RecordingListItem) => void;
	onToggleProtected: (recording: RecordingListItem) => void;
	onToggleWatched: (recording: RecordingListItem) => void;
}

function RecordingsList(props: RecordingsListProps) {
	if (props.view === "grid") {
		return (
			<ul
				data-testid="recordings-grid"
				className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
			>
				{props.recordings.map((r) => (
					<li key={r.id}>
						<RecordingLibraryItem
							mode="grid"
							recording={r}
							channel={props.channelMap.get(r.channelId) ?? null}
							selected={props.selection.has(r.id)}
							pending={props.pendingRecordingIds.has(r.id)}
							use24Hour={props.use24Hour}
							onToggleSelect={() => props.onToggleSelect(r.id)}
							onOpen={() => props.onPlay(r)}
							onDelete={() => props.onDeleteOne(r)}
							onToggleProtected={() => props.onToggleProtected(r)}
							onToggleWatched={() => props.onToggleWatched(r)}
						/>
					</li>
				))}
			</ul>
		);
	}

	return (
		<ul
			data-testid="recordings-list"
			className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border"
		>
			{props.recordings.map((r) => (
				<li key={r.id}>
					<RecordingLibraryItem
						mode="list"
						recording={r}
						channel={props.channelMap.get(r.channelId) ?? null}
						selected={props.selection.has(r.id)}
						pending={props.pendingRecordingIds.has(r.id)}
						use24Hour={props.use24Hour}
						onToggleSelect={() => props.onToggleSelect(r.id)}
						onOpen={() => props.onPlay(r)}
						onDelete={() => props.onDeleteOne(r)}
						onToggleProtected={() => props.onToggleProtected(r)}
						onToggleWatched={() => props.onToggleWatched(r)}
					/>
				</li>
			))}
		</ul>
	);
}
