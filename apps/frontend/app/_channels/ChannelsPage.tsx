"use client";

import type {
	ChannelListItem,
	ChannelQuality,
	ChannelSource,
	EventMessage,
	Tuner
} from "@signalhaven/shared";
import {
	Eye,
	EyeOff,
	ChevronDown,
	Combine,
	GripVertical,
	Radio,
	Search,
	Star,
	Tv,
	Unlink,
	X
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState
} from "react";

import {
	buildChannelLogoUrl,
	formatClientError,
	getChannelQuality,
	listChannels,
	listTuners,
	mergeChannels,
	preferChannelSource,
	splitChannelSource,
	updateSettings
} from "../../lib/api-client";
import { useAdvancedModeOptional } from "../_advanced/AdvancedModeProvider";
import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
import { IconButton } from "../_ui/IconButton";
import { Input } from "../_ui/Input";
import { PageHeader } from "../_ui/PageHeader";
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
import { Spinner } from "../_ui/Spinner";
import { ChannelLogo } from "../_ui/ChannelLogo";
import { cn } from "../_ui/cn";
import { SmartLink } from "../_layout/SmartLink";
import { usePreferencesOptional } from "../_preferences/PreferencesProvider";
import { useWebSocketEvents } from "../../lib/ws-client";

import {
	channelsReducer,
	groupChannels,
	initialChannelsState,
	selectVisibleChannels,
	type ChannelsGroupBy,
	type ChannelsPrefs,
	type ChannelsSort,
	type ChannelsVisibility
} from "./state";

export interface ChannelsPageProps {
	/**
	 * Optional fixture override used by tests + the dev preview. When
	 * provided, no network requests are made.
	 */
	initialChannels?: ChannelListItem[] | undefined;
	/** Optional initial preferences (defaults to empty). */
	initialPrefs?: ChannelsPrefs | undefined;
	/**
	 * Persistence hook for tests. Defaults to `updateSettings({ channels })`.
	 * Returning a rejected promise surfaces a toast in the UI.
	 */
	persistPrefs?: ((prefs: ChannelsPrefs) => Promise<void>) | undefined;
	/** Mutation seams keep the grouping workflow testable without network calls. */
	mergeGroups?:
		| ((
				channelIds: string[],
				primaryChannelId: string
		  ) => Promise<ChannelListItem[]>)
		| undefined;
	splitSource?:
		| ((channelId: string, sourceId: string) => Promise<ChannelListItem[]>)
		| undefined;
	preferSource?:
		| ((channelId: string, sourceId: string) => Promise<ChannelListItem[]>)
		| undefined;
}

/** Keep initial DOM work predictable even for provider lineups with thousands of channels. */
const CHANNEL_RENDER_BATCH_SIZE = 100;

/**
 * Channels list screen (U5-channels).
 *
 * Sources its data from the channels list endpoint + the settings API,
 * then layers user-driven sort/filter/favorite/hide/manual-order state
 * via {@link channelsReducer}. All preference mutations write through
 * to `settings.channels` so the same prefs apply across devices.
 */
export function ChannelsPage(props: ChannelsPageProps) {
	const useFixture = Boolean(props.initialChannels);
	const preferences = usePreferencesOptional();
	const advancedMode = useAdvancedModeOptional();

	const [state, dispatch] = useReducer(channelsReducer, undefined, () => ({
		...initialChannelsState,
		channels: props.initialChannels ?? [],
		prefs:
			props.initialPrefs ??
			preferences?.settings.channels ??
			initialChannelsState.prefs
	}));

	const [tuners, setTuners] = useState<Tuner[]>([]);
	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
		useFixture ? "ready" : "idle"
	);
	const [error, setError] = useState<Error | null>(null);
	const [persistenceError, setPersistenceError] = useState<string | null>(null);
	const [renderLimit, setRenderLimit] = useState(CHANNEL_RENDER_BATCH_SIZE);
	const [mergeOpen, setMergeOpen] = useState(false);
	const [mergePrimaryId, setMergePrimaryId] = useState<string | null>(null);
	const [groupingPending, setGroupingPending] = useState(false);
	const [groupingError, setGroupingError] = useState<string | null>(null);
	const lastPrefsRef = useRef<ChannelsPrefs | null>(state.prefs);
	const pendingSaveCountRef = useRef(0);

	useEffect(() => {
		if (props.initialPrefs || !preferences) return;
		if (
			pendingSaveCountRef.current > 0 &&
			lastPrefsRef.current &&
			!samePrefs(lastPrefsRef.current, preferences.settings.channels)
		) {
			// An earlier queued response must not replace a newer local edit.
			return;
		}
		lastPrefsRef.current = preferences.settings.channels;
		dispatch({ type: "set-prefs", prefs: preferences.settings.channels });
	}, [preferences, props.initialPrefs]);

	// ── Initial fetch ──────────────────────────────────────────────────
	useEffect(() => {
		if (useFixture) return;
		let cancelled = false;
		async function load() {
			setStatus("loading");
			try {
				const [channelsRes, tunersRes] = await Promise.all([
					listChannels(),
					listTuners()
				]);
				if (cancelled) return;
				dispatch({ type: "set-channels", channels: channelsRes.items });
				setRenderLimit(CHANNEL_RENDER_BATCH_SIZE);
				setTuners(tunersRes.items);
				setStatus("ready");
			} catch (err) {
				if (cancelled) return;
				setError(err instanceof Error ? err : new Error(String(err)));
				setStatus("error");
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [useFixture]);

	// Keep an open channel list aligned with background tuner imports.
	useWebSocketEvents({
		topics: ["tuners"],
		enabled: !useFixture,
		onEvent: useCallback((event: EventMessage) => {
			if (event.event !== "lineup.synced" && event.event !== "deleted") return;
			void Promise.all([listChannels(), listTuners()])
				.then(([channelsRes, tunersRes]) => {
					dispatch({ type: "set-channels", channels: channelsRes.items });
					setRenderLimit(CHANNEL_RENDER_BATCH_SIZE);
					setTuners(tunersRes.items);
				})
				.catch((cause: unknown) => {
					setError(cause instanceof Error ? cause : new Error(String(cause)));
				});
		}, [])
	});

	// ── Persistence ────────────────────────────────────────────────────
	// Persist prefs (favorites/hidden/order) on every change. Skips the
	// initial render so we never send a write the user didn't make.
	const saveAppPreferences = preferences?.saveSettings;
	const persistPrefs = useCallback(
		(prefs: ChannelsPrefs): Promise<void> => {
			if (props.persistPrefs) return props.persistPrefs(prefs);
			if (saveAppPreferences) {
				return saveAppPreferences({ channels: prefs }).then(() => undefined);
			}
			return updateSettings({ channels: prefs }).then(() => undefined);
		},
		[props.persistPrefs, saveAppPreferences]
	);
	useEffect(() => {
		if (status !== "ready") return;
		// Skip when prefs are unchanged from the last write (and on first
		// render, where `lastPrefsRef.current` is the initial prefs).
		if (lastPrefsRef.current && samePrefs(lastPrefsRef.current, state.prefs)) {
			return;
		}
		lastPrefsRef.current = state.prefs;
		setPersistenceError(null);
		pendingSaveCountRef.current += 1;
		void persistPrefs(state.prefs)
			.then(() => setPersistenceError(null))
			.catch((err: unknown) => {
				console.error("[channels] failed to persist preferences", err);
				setPersistenceError(
					"Could not save channel preferences. Your changes may not survive a reload."
				);
			})
			.finally(() => {
				pendingSaveCountRef.current = Math.max(
					0,
					pendingSaveCountRef.current - 1
				);
			});
	}, [state.prefs, status, persistPrefs]);

	// ── Selectors ──────────────────────────────────────────────────────
	const visible = useMemo(() => selectVisibleChannels(state), [state]);
	const renderedVisible = useMemo(
		() => visible.slice(0, renderLimit),
		[renderLimit, visible]
	);
	const groups = useMemo(
		() => groupChannels(renderedVisible, state.groupBy),
		[renderedVisible, state.groupBy]
	);
	const favoriteIds = useMemo(
		() => new Set(state.prefs.favorites),
		[state.prefs.favorites]
	);
	const hiddenIds = useMemo(
		() => new Set(state.prefs.hidden),
		[state.prefs.hidden]
	);

	const visibleIds = useMemo(() => visible.map((c) => c.id), [visible]);
	const allSelected =
		visibleIds.length > 0 && visibleIds.every((id) => state.selection.has(id));
	const someSelected = state.selection.size > 0;
	const selectedChannels = useMemo(
		() => state.channels.filter((channel) => state.selection.has(channel.id)),
		[state.channels, state.selection]
	);

	const onToggleSelectAll = useCallback(() => {
		if (allSelected) dispatch({ type: "clear-selection" });
		else dispatch({ type: "select-all", channelIds: visibleIds });
	}, [allSelected, visibleIds]);

	const applyGroupingResult = useCallback((channels: ChannelListItem[]) => {
		dispatch({ type: "set-channels", channels });
		dispatch({ type: "clear-selection" });
		setRenderLimit(CHANNEL_RENDER_BATCH_SIZE);
	}, []);

	const handleMerge = useCallback(async () => {
		if (!mergePrimaryId || selectedChannels.length < 2) return;
		setGroupingPending(true);
		setGroupingError(null);
		try {
			const ids = selectedChannels.map((channel) => channel.id);
			const channels = props.mergeGroups
				? await props.mergeGroups(ids, mergePrimaryId)
				: (
						await mergeChannels({
							channelIds: ids,
							primaryChannelId: mergePrimaryId
						})
					).items;
			dispatch({
				type: "set-prefs",
				prefs: mergeChannelPreferences(state.prefs, ids, mergePrimaryId)
			});
			applyGroupingResult(channels);
			setMergeOpen(false);
		} catch (failure) {
			setGroupingError(
				formatClientError(
					failure,
					"Channels could not be merged. Review the selected sources and try again.",
					Boolean(advancedMode?.enabled)
				)
			);
		} finally {
			setGroupingPending(false);
		}
	}, [
		applyGroupingResult,
		advancedMode?.enabled,
		mergePrimaryId,
		props,
		selectedChannels,
		state.prefs
	]);

	const handleSplitSource = useCallback(
		async (channelId: string, sourceId: string) => {
			setGroupingPending(true);
			setGroupingError(null);
			try {
				const channels = props.splitSource
					? await props.splitSource(channelId, sourceId)
					: (await splitChannelSource(channelId, sourceId)).items;
				applyGroupingResult(channels);
			} catch (failure) {
				setGroupingError(
					formatClientError(
						failure,
						"This source could not be separated. Try again after the current channel update finishes.",
						false
					)
				);
			} finally {
				setGroupingPending(false);
			}
		},
		[applyGroupingResult, props]
	);

	const handlePreferSource = useCallback(
		async (channelId: string, sourceId: string) => {
			setGroupingPending(true);
			setGroupingError(null);
			try {
				const channels = props.preferSource
					? await props.preferSource(channelId, sourceId)
					: (await preferChannelSource(channelId, sourceId)).items;
				applyGroupingResult(channels);
			} catch (failure) {
				setGroupingError(
					formatClientError(
						failure,
						"The preferred source could not be changed.",
						false
					)
				);
			} finally {
				setGroupingPending(false);
			}
		},
		[applyGroupingResult, props]
	);

	// ── Drag state ─────────────────────────────────────────────────────
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropTargetId, setDropTargetId] = useState<string | null>(null);

	const onDragStart = useCallback((channelId: string) => {
		setDragId(channelId);
	}, []);
	const onDragEnd = useCallback(() => {
		setDragId(null);
		setDropTargetId(null);
	}, []);
	const onDropOn = useCallback(
		(targetId: string | null) => {
			if (!dragId) return;
			dispatch({ type: "reorder", channelId: dragId, beforeId: targetId });
			setDragId(null);
			setDropTargetId(null);
		},
		[dragId]
	);

	return (
		<section className="space-y-4" aria-labelledby="channels-heading">
			<PageHeader
				headingId="channels-heading"
				title="Channels"
				description="Sort, filter, and organize your channel lineup. Drag to reorder; use the star to favorite and the eye to hide."
			/>

			<ChannelsToolbar
				search={state.filters.search}
				onSearch={(value) => dispatch({ type: "set-search", search: value })}
				sort={state.sort}
				onSort={(value) => dispatch({ type: "set-sort", sort: value })}
				groupBy={state.groupBy}
				onGroupBy={(value) =>
					dispatch({ type: "set-group-by", groupBy: value })
				}
				visibility={state.filters.visibility}
				onVisibility={(value) =>
					dispatch({ type: "set-visibility", visibility: value })
				}
				tunerId={state.filters.tunerId}
				onTuner={(value) => dispatch({ type: "set-tuner", tunerId: value })}
				tuners={tuners}
				sourceTuners={uniqueTuners(state.channels)}
			/>

			{persistenceError ? (
				<p role="alert" className="text-sm text-danger">
					{persistenceError}
				</p>
			) : null}
			{groupingError ? (
				<p role="alert" className="text-sm text-danger">
					{groupingError}
				</p>
			) : null}

			{someSelected ? (
				<BulkActionBar
					count={state.selection.size}
					canMerge={state.selection.size >= 2}
					onMerge={() => {
						const first = selectedChannels[0];
						setMergePrimaryId(first?.id ?? null);
						setGroupingError(null);
						setMergeOpen(true);
					}}
					onUnselect={() => dispatch({ type: "clear-selection" })}
					onHide={() =>
						dispatch({
							type: "bulk-hide",
							channelIds: Array.from(state.selection)
						})
					}
					onUnhide={() =>
						dispatch({
							type: "bulk-unhide",
							channelIds: Array.from(state.selection)
						})
					}
				/>
			) : null}

			{status === "loading" ? (
				<div className="flex h-40 items-center justify-center text-secondary">
					<Spinner aria-label="Loading channels" />
				</div>
			) : status === "error" ? (
				<EmptyState
					icon={<Tv aria-hidden="true" />}
					title="Couldn't load channels"
					description={error?.message ?? "Please try again later."}
				/>
			) : visible.length === 0 ? (
				<EmptyState
					icon={<Tv aria-hidden="true" />}
					title="No channels match"
					description={
						state.channels.length === 0
							? "Configure tuners from Settings to populate the channel list."
							: "Adjust the filters to see channels."
					}
				/>
			) : (
				<div className="space-y-4" data-testid="channels-list">
					{state.groupBy === "tuner" ? null : (
						<SelectAllRow
							total={visibleIds.length}
							allSelected={allSelected}
							onToggle={onToggleSelectAll}
						/>
					)}
					{groups.map((group) => (
						<Card key={group.key}>
							{state.groupBy === "tuner" ? (
								<CardHeader>
									<CardTitle>{group.label}</CardTitle>
								</CardHeader>
							) : null}
							{/* Channel rows are edge-to-edge, so the card should not restore
                  its default desktop padding below the final row. */}
							<CardContent className="p-0 sm:p-0">
								<ul role="list" className="divide-y divide-border">
									{group.channels.map((channel) => (
										<ChannelRow
											key={channel.id}
											channel={channel}
											isFavorite={favoriteIds.has(channel.id)}
											isHidden={hiddenIds.has(channel.id)}
											isSelected={state.selection.has(channel.id)}
											isDragging={dragId === channel.id}
											isDropTarget={dropTargetId === channel.id}
											reorderable={state.sort === "manual"}
											onToggleFavorite={() =>
												dispatch({
													type: "toggle-favorite",
													channelId: channel.id
												})
											}
											onToggleHidden={() =>
												dispatch({
													type: "toggle-hidden",
													channelId: channel.id
												})
											}
											onToggleSelection={() =>
												dispatch({
													type: "toggle-selection",
													channelId: channel.id
												})
											}
											onDragStart={() => onDragStart(channel.id)}
											onDragEnd={onDragEnd}
											onDragOver={() => setDropTargetId(channel.id)}
											onDrop={() => onDropOn(channel.id)}
											onPreferSource={(sourceId) =>
												void handlePreferSource(channel.id, sourceId)
											}
											onSplitSource={(sourceId) =>
												void handleSplitSource(channel.id, sourceId)
											}
											groupingPending={groupingPending}
										/>
									))}
								</ul>
							</CardContent>
						</Card>
					))}
					<div className="flex flex-col items-center gap-2">
						<p
							className="text-xs text-secondary"
							data-testid="channels-render-summary"
							aria-live="polite"
						>
							Showing {renderedVisible.length.toLocaleString()} of{" "}
							{visible.length.toLocaleString()} channels
						</p>
						{renderedVisible.length < visible.length ? (
							<Button
								variant="secondary"
								data-testid="channels-load-more"
								onClick={() =>
									setRenderLimit((current) =>
										Math.min(
											current + CHANNEL_RENDER_BATCH_SIZE,
											visible.length
										)
									)
								}
							>
								Show more channels
							</Button>
						) : null}
					</div>
					{dragId !== null ? (
						<div
							data-testid="drop-tail"
							className={cn(
								"rounded border border-dashed border-border px-3 py-2 text-center text-xs text-secondary",
								dropTargetId === null && "bg-surface-muted"
							)}
							onDragOver={(e) => {
								e.preventDefault();
								setDropTargetId(null);
							}}
							onDrop={(e) => {
								e.preventDefault();
								onDropOn(null);
							}}
						>
							Drop here to move to the end
						</div>
					) : null}
				</div>
			)}

			<MergeChannelsDialog
				open={mergeOpen}
				onOpenChange={setMergeOpen}
				channels={selectedChannels}
				primaryChannelId={mergePrimaryId}
				onPrimaryChange={setMergePrimaryId}
				onConfirm={() => void handleMerge()}
				pending={groupingPending}
				error={groupingError}
			/>
		</section>
	);
}

/* ── Toolbar ─────────────────────────────────────────────────────── */

interface ChannelsToolbarProps {
	search: string;
	onSearch: (value: string) => void;
	sort: ChannelsSort;
	onSort: (value: ChannelsSort) => void;
	groupBy: ChannelsGroupBy;
	onGroupBy: (value: ChannelsGroupBy) => void;
	visibility: ChannelsVisibility;
	onVisibility: (value: ChannelsVisibility) => void;
	tunerId: string | null;
	onTuner: (value: string | null) => void;
	tuners: Tuner[];
	/** Tuners observed in the channel list — used as a fallback when the
	 * `/tuners` endpoint hasn't loaded yet. */
	sourceTuners: { id: string; name: string }[];
}

function ChannelsToolbar(props: ChannelsToolbarProps) {
	const tunerOptions = useMemo(() => {
		const map = new Map<string, string>();
		for (const t of props.sourceTuners) map.set(t.id, t.name);
		for (const t of props.tuners) map.set(t.id, t.name);
		return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
	}, [props.tuners, props.sourceTuners]);

	return (
		<div
			className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center"
			data-testid="channels-toolbar"
		>
			<div className="relative md:max-w-sm md:flex-1">
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary"
				/>
				<Input
					type="search"
					aria-label="Search channels"
					placeholder="Search by name or number"
					className="pl-9"
					value={props.search}
					onChange={(e) => props.onSearch(e.currentTarget.value)}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<ToolbarSelect
					label="Sort"
					value={props.sort}
					onValueChange={(v) => props.onSort(v as ChannelsSort)}
					options={[
						{ value: "canonical", label: "Default" },
						{ value: "number", label: "Number" },
						{ value: "name", label: "Name" },
						{ value: "favorites-first", label: "Favorites first" },
						{ value: "manual", label: "Preferred order" }
					]}
				/>
				<ToolbarSelect
					label="Group"
					value={props.groupBy}
					onValueChange={(v) => props.onGroupBy(v as ChannelsGroupBy)}
					options={[
						{ value: "none", label: "None" },
						{ value: "tuner", label: "Tuner" }
					]}
				/>
				<ToolbarSelect
					label="Show"
					value={props.visibility}
					onValueChange={(v) => props.onVisibility(v as ChannelsVisibility)}
					options={[
						{ value: "all", label: "All" },
						{ value: "favorites", label: "Favorites only" },
						{ value: "hidden", label: "Hidden only" }
					]}
				/>
				<ToolbarSelect
					label="Tuner"
					value={props.tunerId ?? "__all__"}
					onValueChange={(v) => props.onTuner(v === "__all__" ? null : v)}
					options={[
						{ value: "__all__", label: "All tuners" },
						...tunerOptions.map((t) => ({ value: t.id, label: t.name }))
					]}
				/>
			</div>
		</div>
	);
}

interface ToolbarSelectProps {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	options: { value: string; label: string }[];
}

function ToolbarSelect(props: ToolbarSelectProps) {
	return (
		<label className="flex items-center gap-2 text-xs text-secondary">
			<span>{props.label}</span>
			<Select value={props.value} onValueChange={props.onValueChange}>
				<SelectTrigger
					aria-label={props.label}
					className="h-8 min-w-[7rem] text-xs"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{props.options.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</label>
	);
}

/* ── Bulk action bar ───────────────────────────────────────────── */

interface BulkActionBarProps {
	count: number;
	canMerge: boolean;
	onUnselect: () => void;
	onMerge: () => void;
	onHide: () => void;
	onUnhide: () => void;
}

function BulkActionBar(props: BulkActionBarProps) {
	return (
		<div
			role="toolbar"
			aria-label="Bulk actions"
			data-testid="bulk-action-bar"
			className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2"
		>
			<span className="text-sm text-primary">{props.count} selected</span>
			<div className="ml-auto flex flex-wrap items-center gap-2">
				<Button
					variant="secondary"
					size="sm"
					disabled={!props.canMerge}
					onClick={props.onMerge}
				>
					<Combine aria-hidden="true" className="h-4 w-4" />
					Merge sources
				</Button>
				<Button variant="secondary" size="sm" onClick={props.onUnhide}>
					<Eye aria-hidden="true" className="h-4 w-4" />
					Unhide
				</Button>
				<Button variant="secondary" size="sm" onClick={props.onHide}>
					<EyeOff aria-hidden="true" className="h-4 w-4" />
					Hide
				</Button>
				<IconButton
					aria-label="Clear selection"
					variant="ghost"
					size="sm"
					onClick={props.onUnselect}
				>
					<X aria-hidden="true" className="h-4 w-4" />
				</IconButton>
			</div>
		</div>
	);
}

/* ── Select-all row ────────────────────────────────────────────── */

interface SelectAllRowProps {
	total: number;
	allSelected: boolean;
	onToggle: () => void;
}

function SelectAllRow(props: SelectAllRowProps) {
	return (
		<label className="flex w-fit cursor-pointer items-center gap-3 px-2 text-xs text-secondary">
			<input
				type="checkbox"
				aria-label="Select all matching channels"
				checked={props.allSelected}
				onChange={props.onToggle}
				className="h-4 w-4 cursor-pointer"
			/>
			<span>
				Select all {props.total.toLocaleString()} matching channel
				{props.total === 1 ? "" : "s"}
			</span>
		</label>
	);
}

/* ── Channel row ───────────────────────────────────────────────── */

interface ChannelRowProps {
	channel: ChannelListItem;
	isFavorite: boolean;
	isHidden: boolean;
	isSelected: boolean;
	isDragging: boolean;
	isDropTarget: boolean;
	reorderable: boolean;
	onToggleFavorite: () => void;
	onToggleHidden: () => void;
	onToggleSelection: () => void;
	onDragStart: () => void;
	onDragEnd: () => void;
	onDragOver: () => void;
	onDrop: () => void;
	onPreferSource: (sourceId: string) => void;
	onSplitSource: (sourceId: string) => void;
	groupingPending: boolean;
}

/**
 * Long-press threshold (ms) before a touch press becomes a drag-reorder
 * gesture. 400ms is short enough to feel responsive but long enough to
 * avoid mis-triggering during normal vertical scrolling — it's the same
 * range used by Material Design's drag handles and by iOS sortable
 * lists. Any pointer movement before the timer elapses cancels the
 * pending drag-start so taps and scrolls fall through cleanly.
 */
const LONG_PRESS_MS = 400;

function ChannelRow(props: ChannelRowProps) {
	const {
		channel,
		isFavorite,
		isHidden,
		isSelected,
		isDragging,
		isDropTarget,
		reorderable
	} = props;
	const advancedMode = useAdvancedModeOptional();
	const [quality, setQuality] = useState<ChannelQuality | null>(null);
	const [qualityLoading, setQualityLoading] = useState(false);
	const [qualityError, setQualityError] = useState<string | null>(null);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const sources = channel.sources ?? [];
	const availableSourceCount =
		channel.availableSourceCount ??
		sources.filter((source) => source.status !== "unavailable").length;

	// Long-press → drag for touch devices. On desktop the native HTML5
	// dragstart fires immediately; touch needs a hold so taps still scroll.
	const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [touchDragArmed, setTouchDragArmed] = useState(false);

	const clearLongPress = useCallback(() => {
		if (longPressTimer.current !== null) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
	}, []);
	useEffect(() => () => clearLongPress(), [clearLongPress]);

	const handleTouchStart = useCallback(() => {
		if (!reorderable) return;
		clearLongPress();
		longPressTimer.current = setTimeout(() => {
			setTouchDragArmed(true);
			props.onDragStart();
		}, LONG_PRESS_MS);
	}, [clearLongPress, props, reorderable]);

	const handleTouchMove = useCallback(
		(e: React.TouchEvent<HTMLButtonElement>) => {
			if (!touchDragArmed) {
				// Treat any movement before the long-press fires as a scroll
				// and cancel the pending drag-start.
				clearLongPress();
				return;
			}
			const touch = e.touches[0];
			if (!touch) return;
			const target = document.elementFromPoint(touch.clientX, touch.clientY);
			const row = target?.closest<HTMLElement>("[data-channel-row-id]");
			const id = row?.dataset["channelRowId"];
			if (id && id !== channel.id) {
				props.onDragOver();
			}
		},
		[channel.id, clearLongPress, props, touchDragArmed]
	);

	const handleTouchEnd = useCallback(
		(e: React.TouchEvent<HTMLButtonElement>) => {
			clearLongPress();
			if (!touchDragArmed) return;
			const touch = e.changedTouches[0];
			let dropOnId: string | null | undefined;
			if (touch) {
				const target = document.elementFromPoint(touch.clientX, touch.clientY);
				const row = target?.closest<HTMLElement>("[data-channel-row-id]");
				if (row) dropOnId = row.dataset["channelRowId"];
			}
			if (typeof dropOnId === "string") {
				props.onDragOver();
				props.onDrop();
			} else {
				props.onDragEnd();
			}
			setTouchDragArmed(false);
		},
		[clearLongPress, props, touchDragArmed]
	);

	return (
		<li
			data-channel-row-id={channel.id}
			data-testid="channel-row"
			className={cn(
				"flex flex-wrap items-center gap-3 px-3 py-2",
				isDragging && "opacity-50",
				isDropTarget && !isDragging && "bg-surface-muted",
				isHidden && "text-secondary"
			)}
			onDragOver={(e) => {
				if (!reorderable) return;
				e.preventDefault();
				props.onDragOver();
			}}
			onDrop={(e) => {
				if (!reorderable) return;
				e.preventDefault();
				props.onDrop();
			}}
		>
			<input
				type="checkbox"
				aria-label={`Select ${channel.name}`}
				checked={isSelected}
				onChange={props.onToggleSelection}
				className="h-4 w-4 cursor-pointer"
			/>
			<button
				type="button"
				aria-label={
					reorderable
						? `Drag to reorder ${channel.name}`
						: `Switch to "Preferred order" sort to reorder channels`
				}
				title={
					reorderable
						? "Drag to reorder. On touch devices, press and hold."
						: "Switch sort to Preferred order to reorder."
				}
				disabled={!reorderable}
				draggable={reorderable}
				onDragStart={(e) => {
					if (!reorderable) {
						e.preventDefault();
						return;
					}
					e.dataTransfer.effectAllowed = "move";
					// Some browsers require a payload to start the drag.
					try {
						e.dataTransfer.setData("text/plain", channel.id);
					} catch {
						// Safari throws when called outside dragstart in some
						// contexts; the drag still works without the payload.
					}
					props.onDragStart();
				}}
				onDragEnd={props.onDragEnd}
				onTouchStart={handleTouchStart}
				onTouchMove={handleTouchMove}
				onTouchEnd={handleTouchEnd}
				onTouchCancel={() => {
					clearLongPress();
					setTouchDragArmed(false);
					props.onDragEnd();
				}}
				className={cn(
					"flex h-8 w-6 cursor-grab items-center justify-center rounded text-secondary hover:bg-surface-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30",
					touchDragArmed && "bg-accent/20 text-accent"
				)}
				// Disable browser-default touch scrolling on the handle so the
				// long-press drag feels stable.
				style={{ touchAction: reorderable ? "none" : undefined }}
			>
				<GripVertical aria-hidden="true" className="h-4 w-4" />
			</button>

			<SmartLink
				href={`/watch/${encodeURIComponent(channel.id)}`}
				aria-label={`Watch ${channel.number} ${channel.name}`}
				aria-disabled={availableSourceCount === 0}
				tabIndex={availableSourceCount === 0 ? -1 : undefined}
				title={
					availableSourceCount === 0
						? "This channel has no source available for playback"
						: `Watch ${channel.number} ${channel.name} live`
				}
				onClick={(event) => {
					if (availableSourceCount === 0) event.preventDefault();
				}}
				className={cn(
					"group flex min-w-0 flex-1 basis-[calc(100%-4rem)] items-center gap-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:basis-auto",
					availableSourceCount === 0 && "cursor-not-allowed opacity-70"
				)}
			>
				{/* Keep playback navigation separate from the row's management controls. */}
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-surface-muted text-secondary transition-colors group-hover:bg-accent/15 group-hover:text-accent">
					<ChannelLogo
						src={channel.logoUrl ? buildChannelLogoUrl(channel.id) : null}
						size={28}
						className="h-7 w-7 object-contain"
						fallback={<Tv aria-hidden="true" className="h-4 w-4" />}
					/>
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-mono text-xs text-secondary">
							{channel.number}
						</span>
						<span className="truncate text-sm font-medium text-primary group-hover:underline">
							{channel.name}
						</span>
						{!channel.hasMapping ? (
							<Badge variant="outline">No guide</Badge>
						) : null}
						{isHidden ? <Badge variant="default">Hidden</Badge> : null}
						{availableSourceCount === 0 ? (
							<Badge variant="outline">No available source</Badge>
						) : null}
					</div>
					<div className="text-xs text-secondary">
						{sources.length > 1
							? `${sources.length} sources · ${availableSourceCount} available`
							: channel.tunerName}
					</div>
				</div>
			</SmartLink>

			{/* Keep management actions together on a second mobile row so the
			    channel identity remains readable. */}
			<div className="ml-auto flex items-center gap-1">
				{sources.length > 0 ? (
					<Button
						variant="ghost"
						size="sm"
						aria-expanded={sourcesOpen}
						aria-controls={`channel-sources-${channel.id}`}
						onClick={() => setSourcesOpen((open) => !open)}
					>
						{sources.length} source{sources.length === 1 ? "" : "s"}
						<ChevronDown
							aria-hidden="true"
							className={cn(
								"h-4 w-4 transition-transform",
								sourcesOpen && "rotate-180"
							)}
						/>
					</Button>
				) : null}

				{advancedMode?.enabled && channel.tunerKind === "hdhomerun" ? (
					<div className="flex items-center gap-2">
						{quality ? (
							<span
								className="max-w-24 text-right text-[10px] text-secondary sm:max-w-none sm:text-xs"
								data-testid={`channel-quality-${channel.id}`}
							>
								{quality.active
									? [
											quality.signalStrengthPercent !== undefined
												? `SS ${quality.signalStrengthPercent}%`
												: null,
											quality.signalQualityPercent !== undefined
												? `SQ ${quality.signalQualityPercent}%`
												: null,
											quality.symbolQualityPercent !== undefined
												? `SEQ ${quality.symbolQualityPercent}%`
												: null,
											quality.lock ? `Lock ${quality.lock}` : null,
											quality.networkRateMbps !== undefined
												? `${quality.networkRateMbps} Mbps`
												: null
										]
											.filter(Boolean)
											.join(" · ") || "Tuned"
									: "Not currently tuned"}
							</span>
						) : null}
						{qualityError ? (
							<span
								role="alert"
								className="max-w-24 text-right text-[10px] text-danger sm:max-w-none sm:text-xs"
							>
								{qualityError}
							</span>
						) : null}
						<IconButton
							aria-label={`Check signal quality for ${channel.name}`}
							title="Check live HDHomeRun signal quality"
							variant="ghost"
							size="sm"
							disabled={qualityLoading}
							onClick={async () => {
								setQualityLoading(true);
								setQualityError(null);
								try {
									setQuality(
										await getChannelQuality(sources[0]?.id ?? channel.id)
									);
								} catch (failure) {
									setQualityError(
										formatClientError(failure, "Signal check failed", true)
									);
								} finally {
									setQualityLoading(false);
								}
							}}
						>
							{qualityLoading ? (
								<Spinner aria-hidden="true" className="h-4 w-4" />
							) : (
								<Radio aria-hidden="true" className="h-4 w-4" />
							)}
						</IconButton>
					</div>
				) : null}

				<IconButton
					aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
					aria-pressed={isFavorite}
					variant="ghost"
					size="sm"
					onClick={props.onToggleFavorite}
					data-testid={`favorite-${channel.id}`}
				>
					<Star
						aria-hidden="true"
						className={cn(
							"h-4 w-4",
							isFavorite ? "fill-amber-400 text-amber-500" : ""
						)}
					/>
				</IconButton>

				<IconButton
					aria-label={isHidden ? "Unhide channel" : "Hide channel"}
					aria-pressed={isHidden}
					variant="ghost"
					size="sm"
					onClick={props.onToggleHidden}
					data-testid={`hide-${channel.id}`}
				>
					{isHidden ? (
						<EyeOff aria-hidden="true" className="h-4 w-4" />
					) : (
						<Eye aria-hidden="true" className="h-4 w-4" />
					)}
				</IconButton>
			</div>

			{sourcesOpen ? (
				<ChannelSourcesPanel
					id={`channel-sources-${channel.id}`}
					sources={sources}
					disabled={props.groupingPending}
					onPrefer={props.onPreferSource}
					onSplit={props.onSplitSource}
				/>
			) : null}
		</li>
	);
}

interface ChannelSourcesPanelProps {
	id: string;
	sources: ChannelSource[];
	disabled: boolean;
	onPrefer: (sourceId: string) => void;
	onSplit: (sourceId: string) => void;
}

/** Show fallback order and lifecycle state without exposing provider internals. */
function ChannelSourcesPanel(props: ChannelSourcesPanelProps) {
	const hasRetainedSource = props.sources.some(
		(source) => source.status !== "active"
	);
	return (
		<div
			id={props.id}
			className="-mx-3 -mb-2 mt-1 basis-full border-t border-border bg-surface-muted/60 px-3 py-3"
		>
			<div className="space-y-2">
				{props.sources.map((source) => {
					const status = sourceStatusPresentation(source.status);
					return (
						<div
							key={source.id}
							className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center"
						>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2 text-sm text-primary">
									<span
										aria-hidden="true"
										className={cn("h-2 w-2 rounded-full", status.dotClass)}
									/>
									<span className="font-medium">{source.tunerName}</span>
									<span className="text-secondary">
										{source.number} · {source.name}
									</span>
									{source.preferred ? <Badge>Preferred</Badge> : null}
								</div>
								<p className="ml-4 text-xs text-secondary">{status.label}</p>
							</div>
							<div className="flex items-center gap-2 sm:justify-end">
								{!source.preferred ? (
									<Button
										variant="ghost"
										size="sm"
										disabled={props.disabled || source.status !== "active"}
										onClick={() => props.onPrefer(source.id)}
									>
										Make preferred
									</Button>
								) : null}
								{props.sources.length > 1 ? (
									<Button
										variant="ghost"
										size="sm"
										disabled={props.disabled}
										onClick={() => props.onSplit(source.id)}
									>
										<Unlink aria-hidden="true" className="h-4 w-4" />
										Separate
									</Button>
								) : null}
							</div>
						</div>
					);
				})}
			</div>
			{hasRetainedSource ? (
				<p className="mt-3 max-w-3xl text-xs leading-5 text-secondary">
					Missing sources remain linked so a provider move or temporary lineup
					outage does not erase this group. Use Separate only when the source is
					actually a different channel.
				</p>
			) : null}
		</div>
	);
}

interface MergeChannelsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	channels: ChannelListItem[];
	primaryChannelId: string | null;
	onPrimaryChange: (channelId: string) => void;
	onConfirm: () => void;
	pending: boolean;
	error: string | null;
}

/** Confirm the durable identity that survives a many-source merge. */
function MergeChannelsDialog(props: MergeChannelsDialogProps) {
	return (
		<Modal open={props.open} onOpenChange={props.onOpenChange}>
			<ModalContent>
				<ModalHeader>
					<ModalTitle>Merge channel sources</ModalTitle>
					<ModalDescription>
						These entries will become one channel in the guide. Choose the
						identity whose name, number, artwork, guide mapping, and preferences
						should remain.
					</ModalDescription>
				</ModalHeader>

				<fieldset className="space-y-2">
					<legend className="mb-2 text-sm font-medium text-primary">
						Channel identity to keep
					</legend>
					{props.channels.map((channel) => (
						<label
							key={channel.id}
							className={cn(
								"flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3",
								props.primaryChannelId === channel.id
									? "border-accent bg-accent/10"
									: "border-border"
							)}
						>
							<input
								type="radio"
								name="merge-primary-channel"
								value={channel.id}
								checked={props.primaryChannelId === channel.id}
								onChange={() => props.onPrimaryChange(channel.id)}
								className="mt-1 h-4 w-4"
							/>
							<span className="min-w-0">
								<span className="block text-sm font-medium text-primary">
									{channel.number} · {channel.name}
								</span>
								<span className="block text-xs text-secondary">
									{channel.sources?.length ?? 1} source
									{(channel.sources?.length ?? 1) === 1 ? "" : "s"} ·{" "}
									{channel.tunerName}
								</span>
							</span>
						</label>
					))}
				</fieldset>

				<p className="text-xs leading-5 text-secondary">
					Recordings and series rules move to the retained identity. Sources are
					tried in preference order, and a missing source stays attached for
					recovery instead of being silently deleted.
				</p>
				{props.error ? (
					<p role="alert" className="text-sm text-danger">
						{props.error}
					</p>
				) : null}

				<ModalFooter>
					<Button
						variant="secondary"
						disabled={props.pending}
						onClick={() => props.onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={props.pending || !props.primaryChannelId}
						onClick={props.onConfirm}
					>
						{props.pending ? <Spinner aria-hidden="true" /> : null}
						Merge {props.channels.length} channels
					</Button>
				</ModalFooter>
			</ModalContent>
		</Modal>
	);
}

function sourceStatusPresentation(status: ChannelSource["status"]): {
	label: string;
	dotClass: string;
} {
	switch (status) {
		case "missing":
			return {
				label: "Missing from the latest lineup sync; fallback remains enabled.",
				dotClass: "bg-amber-500"
			};
		case "unavailable":
			return {
				label: "Unavailable after repeated syncs; retained for recovery.",
				dotClass: "bg-danger"
			};
		case "active":
		default:
			return {
				label: "Available for live TV and recordings.",
				dotClass: "bg-success"
			};
	}
}

/* ── Helpers ───────────────────────────────────────────────────── */

/** Collapse source-specific preferences onto the identity retained by a merge. */
function mergeChannelPreferences(
	prefs: ChannelsPrefs,
	mergedIds: string[],
	primaryId: string
): ChannelsPrefs {
	const merged = new Set(mergedIds);
	const favorite = mergedIds.some((id) => prefs.favorites.includes(id));
	const hidden = mergedIds.every((id) => prefs.hidden.includes(id));
	const withoutMerged = (ids: string[]) => ids.filter((id) => !merged.has(id));
	const earliestOrder = prefs.order.findIndex((id) => merged.has(id));
	const order = withoutMerged(prefs.order);
	if (earliestOrder >= 0) {
		order.splice(Math.min(earliestOrder, order.length), 0, primaryId);
	}
	return {
		favorites: favorite
			? [...withoutMerged(prefs.favorites), primaryId]
			: withoutMerged(prefs.favorites),
		hidden: hidden
			? [...withoutMerged(prefs.hidden), primaryId]
			: withoutMerged(prefs.hidden),
		order
	};
}

function uniqueTuners(
	channels: ChannelListItem[]
): { id: string; name: string }[] {
	const map = new Map<string, string>();
	for (const c of channels) {
		const sources = c.sources ?? [];
		if (sources.length === 0) {
			// New responses represent recoverable empty groups explicitly.
			if (c.sources === undefined && !map.has(c.tunerId)) {
				map.set(c.tunerId, c.tunerName);
			}
			continue;
		}
		for (const source of sources) {
			if (!map.has(source.tunerId)) map.set(source.tunerId, source.tunerName);
		}
	}
	return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
}

function samePrefs(a: ChannelsPrefs, b: ChannelsPrefs): boolean {
	return (
		arraysEqual(a.favorites, b.favorites) &&
		arraysEqual(a.hidden, b.hidden) &&
		arraysEqual(a.order, b.order)
	);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
