"use client";

import type {
	ChannelListItem,
	Recording,
	RecordingListItem,
	RecordingPatch
} from "@signalhaven/shared";
import { useRouter } from "next/navigation";
import { ArrowLeft, Film } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
	buildRecordingArtworkUrl,
	deleteRecording,
	listChannels,
	listRecordings
} from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { EmptyState } from "../_ui/EmptyState";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle
} from "../_ui/Modal";
import { Spinner } from "../_ui/Spinner";
import { use24HourClock } from "../_preferences/PreferencesProvider";

import { buildRecordingFixturePage } from "./fixture-page";
import { RecordingArtwork } from "./RecordingArtwork";
import { RecordingLibraryItem } from "./RecordingLibraryItem";
import { RECORDINGS_PAGE_SIZE, safeRecordingsReturnPath } from "./query-state";
import { formatBytes } from "./state";
import {
	useRecordingsPagination,
	type RecordingPageLoader
} from "./useRecordingsPagination";
import { useOptimisticRecordingMutations } from "./useOptimisticRecordingMutations";

export interface SeriesDetailPageProps {
	/** Series rule id from the URL segment. */
	seriesRuleId: string;
	/** Safe library path restored by the Back action. */
	returnTo?: string | undefined;
	/** Number of cursor pages restored from the URL. */
	initialPageCount?: number | undefined;
	/** Test seam: pre-populated recordings (skips network). */
	initialRecordings?: Array<Recording | RecordingListItem> | undefined;
	/** Test seam: pre-populated channels (skips network). */
	initialChannels?: ChannelListItem[] | undefined;
	/** Test seam: override the paginated listing call. */
	loadRecordings?: RecordingPageLoader | undefined;
	/** Test seam: override the channels call. */
	loadChannels?: (() => Promise<ChannelListItem[]>) | undefined;
	/** Test seam: override the deletion call. */
	onDelete?:
		| ((
				id: string,
				options?: { overrideProtection?: boolean }
		  ) => Promise<void>)
		| undefined;
	/** Test seam: override protection and watched-state patches. */
	onPatch?:
		| ((id: string, patch: RecordingPatch) => Promise<Recording>)
		| undefined;
}

/**
 * Paginated per-series detail backed by the dedicated seriesRuleId filter.
 * Counts and disk size come from full-query metadata, not the loaded episodes.
 */
export function SeriesDetailPage(props: SeriesDetailPageProps) {
	const useFixture = props.initialRecordings !== undefined;
	const router = useRouter();
	const use24Hour = use24HourClock();
	const [targetPageCount, setTargetPageCount] = useState(
		Math.max(1, props.initialPageCount ?? 1)
	);
	const [channels, setChannels] = useState<ChannelListItem[]>(
		props.initialChannels ?? []
	);
	const [pendingDelete, setPendingDelete] = useState<RecordingListItem | null>(
		null
	);
	const [deleting, setDeleting] = useState(false);
	const [actionError, setActionError] = useState<Error | null>(null);
	const returnTo = safeRecordingsReturnPath(props.returnTo);
	const query = useMemo(
		() => ({
			seriesRuleId: props.seriesRuleId,
			sort: "scheduledStart" as const,
			direction: "desc" as const
		}),
		[props.seriesRuleId]
	);
	const loadPage = useCallback<RecordingPageLoader>(
		async (pageQuery, options) => {
			if (props.loadRecordings) {
				return props.loadRecordings(pageQuery, options);
			}
			if (props.initialRecordings) {
				return buildRecordingFixturePage(props.initialRecordings, pageQuery);
			}
			return listRecordings(pageQuery, options);
		},
		[props.initialRecordings, props.loadRecordings]
	);
	const initialPage = useMemo(
		() =>
			props.initialRecordings && targetPageCount === 1
				? buildRecordingFixturePage(props.initialRecordings, {
						...query,
						limit: RECORDINGS_PAGE_SIZE,
						offset: 0
					})
				: undefined,
		[props.initialRecordings, query, targetPageCount]
	);
	const pagination = useRecordingsPagination({
		query,
		pageSize: RECORDINGS_PAGE_SIZE,
		targetPageCount,
		loadPage,
		...(initialPage ? { initialPage } : {})
	});
	const recordingMutations = useOptimisticRecordingMutations({
		recordings: pagination.recordings,
		apply: pagination.patchRecordings,
		...(props.onPatch ? { send: props.onPatch } : {})
	});

	// A refresh can remove the final page; keep the return URL truthful.
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

	useEffect(() => {
		if (useFixture || props.initialChannels !== undefined) return;
		let cancelled = false;
		const load =
			props.loadChannels ?? (async () => (await listChannels()).items);
		void load()
			.then((rows) => {
				if (!cancelled) setChannels(rows);
			})
			.catch((failure: unknown) => {
				if (!cancelled) {
					console.warn("Failed to load series channels", failure);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [props.initialChannels, props.loadChannels, useFixture]);

	// Keep the loaded-page count in the URL so playback navigation can return.
	useEffect(() => {
		const params = new URLSearchParams();
		if (targetPageCount > 1) params.set("pages", String(targetPageCount));
		if (returnTo !== "/recordings") params.set("returnTo", returnTo);
		const suffix = params.toString();
		window.history.replaceState(
			window.history.state,
			"",
			`/recordings/series/${props.seriesRuleId}${suffix ? `?${suffix}` : ""}`
		);
	}, [props.seriesRuleId, returnTo, targetPageCount]);

	const channelMap = useMemo(() => {
		const map = new Map<string, ChannelListItem>();
		for (const channel of channels) map.set(channel.id, channel);
		return map;
	}, [channels]);
	const seriesTitle =
		pagination.seriesGroups.get(props.seriesRuleId)?.title ??
		pagination.recordings[0]?.title ??
		"Series";
	const seriesSelfPath = useMemo(() => {
		const params = new URLSearchParams({ returnTo });
		if (targetPageCount > 1) {
			params.set("pages", String(targetPageCount));
		}
		return `/recordings/series/${props.seriesRuleId}?${params.toString()}`;
	}, [props.seriesRuleId, returnTo, targetPageCount]);
	const loadNextPage = () => {
		void pagination.loadMore().then((loaded) => {
			if (loaded) setTargetPageCount((count) => count + 1);
		});
	};

	const onConfirmDelete = useCallback(async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		setActionError(null);
		const remover =
			props.onDelete ??
			((id: string, options?: { overrideProtection?: boolean }) =>
				deleteRecording(id, options));
		try {
			if (pendingDelete.manuallyProtected) {
				await remover(pendingDelete.id, { overrideProtection: true });
			} else {
				await remover(pendingDelete.id);
			}
			pagination.removeRecordings([pendingDelete.id]);
			setPendingDelete(null);
			// Production refresh fills the page and updates full-series totals.
			if (!useFixture) void pagination.refresh();
		} catch (failure) {
			setActionError(
				failure instanceof Error ? failure : new Error("Delete failed")
			);
		} finally {
			setDeleting(false);
		}
	}, [pagination, pendingDelete, props.onDelete, useFixture]);

	if (pagination.status === "loading" && pagination.loadedCount === 0) {
		return (
			<div
				data-testid="series-detail-loading"
				className="flex items-center justify-center p-12"
			>
				<Spinner aria-label="Loading series" />
			</div>
		);
	}

	if (pagination.status === "error" && pagination.loadedCount === 0) {
		return (
			<EmptyState
				data-testid="series-detail-error"
				icon={<Film />}
				title="Couldn't load series"
				description={pagination.error?.message ?? "Please try again."}
				action={
					<Button onClick={() => void pagination.refresh()}>Try again</Button>
				}
			/>
		);
	}

	if (pagination.total === 0) {
		return (
			<EmptyState
				data-testid="series-detail-empty"
				icon={<Film />}
				title="Series unavailable"
				description="This series may have been deleted, or it hasn't produced any recordings yet."
				action={
					<Button variant="ghost" onClick={() => router.push(returnTo)}>
						Back to library
					</Button>
				}
			/>
		);
	}

	return (
		<section
			data-testid="series-detail-page"
			className="mx-auto flex max-w-4xl flex-col gap-4"
		>
			<div>
				<Button variant="ghost" size="sm" onClick={() => router.push(returnTo)}>
					<ArrowLeft aria-hidden="true" className="h-4 w-4" />
					Back to library
				</Button>
			</div>

			<header className="flex flex-col gap-4 sm:flex-row">
				<RecordingArtwork
					src={
						pagination.recordings[0]?.metadata?.artworkUrl
							? buildRecordingArtworkUrl(pagination.recordings[0].id)
							: null
					}
					title={seriesTitle}
					className="aspect-video w-full rounded-lg sm:w-56"
					priority
				/>
				<div className="flex min-w-0 flex-col justify-end gap-1">
					<h1
						data-testid="series-title"
						className="text-2xl font-semibold text-primary"
					>
						{seriesTitle}
					</h1>
					<p data-testid="series-summary" className="text-sm text-secondary">
						{pagination.total} episode
						{pagination.total === 1 ? "" : "s"} ·{" "}
						{formatBytes(pagination.totalSize)} on disk
						{` · showing ${pagination.loadedCount} · ${pagination.limit} per page`}
					</p>
				</div>
			</header>

			{pagination.status === "refreshing" ? (
				<p role="status" className="text-sm text-secondary">
					Updating episodes…
				</p>
			) : null}

			{actionError ||
			recordingMutations.error ||
			(pagination.error && pagination.loadedCount > 0) ? (
				<div
					data-testid="series-action-error"
					className="flex items-center justify-between gap-3 rounded-lg border border-danger/40 p-3"
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

			<ul
				data-testid="series-episodes"
				className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border"
			>
				{pagination.recordings.map((recording) => {
					return (
						<li
							key={recording.id}
							data-testid={`series-episode-${recording.id}`}
						>
							<RecordingLibraryItem
								mode="list"
								recording={recording}
								channel={channelMap.get(recording.channelId) ?? null}
								selectable={false}
								pending={recordingMutations.pendingIds.has(recording.id)}
								use24Hour={use24Hour}
								onOpen={() =>
									router.push(
										`/recordings/${recording.id}?returnTo=${encodeURIComponent(seriesSelfPath)}`
									)
								}
								onDelete={() => setPendingDelete(recording)}
								onToggleProtected={() =>
									void recordingMutations.mutate(
										[recording.id],
										{
											manuallyProtected: !recording.manuallyProtected
										},
										{
											manuallyProtected: !recording.manuallyProtected
										}
									)
								}
								onToggleWatched={() =>
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
							/>
						</li>
					);
				})}
			</ul>

			{pagination.loadMoreError ? (
				<div
					data-testid="series-load-more-error"
					className="flex items-center justify-center gap-3 rounded-lg border border-danger/40 p-3"
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
						data-testid="series-load-more"
						onClick={loadNextPage}
					>
						{pagination.loadingMore ? "Loading more…" : "Load more"}
					</Button>
				</div>
			) : (
				<p
					role="status"
					data-testid="series-end"
					className="text-center text-sm text-secondary"
				>
					All {pagination.total} episodes loaded
				</p>
			)}

			<Modal
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
			>
				<ModalContent data-testid="series-delete-confirm">
					<ModalHeader>
						<ModalTitle>Delete episode?</ModalTitle>
						<ModalDescription>
							{pendingDelete?.manuallyProtected
								? `“${pendingDelete.title}” is protected. Continuing explicitly overrides protection and permanently removes its file.`
								: `This permanently removes “${pendingDelete?.title}” and its file.`}
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
						<Button
							variant="danger"
							onClick={() => void onConfirmDelete()}
							disabled={deleting}
							data-testid="series-delete-confirm-button"
						>
							{deleting
								? "Deleting…"
								: pendingDelete?.manuallyProtected
									? "Unprotect & delete"
									: "Delete"}
						</Button>
					</ModalFooter>
				</ModalContent>
			</Modal>
		</section>
	);
}
