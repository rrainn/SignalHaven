"use client";

import type {
	ChannelListItem,
	EventMessage,
	Recording,
	RecordingConflict,
	SeriesRule
} from "@signalhaven/shared";
import {
	RECORDING_EVENT,
	recordingConflictSchema,
	SERIES_RULE_EVENT
} from "@signalhaven/shared";
import {
	AlertTriangle,
	CalendarClock,
	Disc3,
	ListChecks,
	Pencil,
	Plus,
	Trash2,
	XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import {
	cancelRecording,
	createSeriesRule,
	deleteSeriesRule,
	listChannels,
	listAllRecordings,
	listRecordingConflicts,
	listSeriesRules,
	updateSeriesRule
} from "../../lib/api-client";
import { parseRecordingEvent } from "../../lib/recording-events";
import { useWebSocketEvents } from "../../lib/ws-client";
import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
import { IconButton } from "../_ui/IconButton";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle
} from "../_ui/Modal";
import { PageHeader } from "../_ui/PageHeader";
import { Spinner } from "../_ui/Spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../_ui/Tabs";
import { use24HourClock } from "../_preferences/PreferencesProvider";
import { formatDateTimePreference } from "../_preferences/formatting";

import { SeriesRuleEditor } from "./SeriesRuleEditor";
import {
	initialSchedulerState,
	schedulerReducer,
	selectSortedConflicts,
	selectSortedSeriesRules,
	selectUpcomingRecordings,
	type SchedulerTab
} from "./state";

/** Async hook overrides exposed for tests. */
export interface SchedulerPageProps {
	initialRecordings?: Recording[] | undefined;
	initialSeriesRules?: SeriesRule[] | undefined;
	initialConflicts?: RecordingConflict[] | undefined;
	initialChannels?: ChannelListItem[] | undefined;
	loadRecordings?: (() => Promise<Recording[]>) | undefined;
	loadSeriesRules?: (() => Promise<SeriesRule[]>) | undefined;
	loadConflicts?: (() => Promise<RecordingConflict[]>) | undefined;
	loadChannels?: (() => Promise<ChannelListItem[]>) | undefined;
	onCancelRecording?: ((id: string) => Promise<void>) | undefined;
	onCreateSeriesRule?:
		| ((input: Parameters<typeof createSeriesRule>[0]) => Promise<SeriesRule>)
		| undefined;
	onUpdateSeriesRule?:
		| ((
				id: string,
				patch: Parameters<typeof updateSeriesRule>[1]
		  ) => Promise<SeriesRule>)
		| undefined;
	onDeleteSeriesRule?: ((id: string) => Promise<void>) | undefined;
	/** Disable the WS subscription (always disabled in tests). */
	enableWebSocket?: boolean | undefined;
}

const STATUS_BADGE: Record<
	Recording["status"],
	"default" | "accent" | "success" | "danger" | "outline"
> = {
	scheduled: "outline",
	recording: "accent",
	completed: "success",
	failed: "danger",
	cancelled: "default"
};

/**
 * DVR scheduler page (rrainn/SignalHaven#U9-scheduler).
 *
 * Tabbed UI surfacing the three areas called out in the U9 acceptance
 * criteria:
 *
 *   * **Upcoming** — chronological list of every scheduled / in-flight
 *     recording, with a status badge and a quick-cancel button.
 *   * **Series rules** — table of "season pass" rules with create /
 *     edit / delete affordances driving the shared
 *     {@link SeriesRuleEditor}.
 *   * **Conflicts** — list of conflicts surfaced by the evaluator.
 *     Each row exposes "Drop" (cancel the affected recording) and
 *     "Accept" (acknowledge the auto-resolution and dismiss the row).
 *
 * Real-time updates flow through the `recordings` WS topic — the page
 * subscribes to `recording.conflict`, `recording.scheduled`,
 * `recording.cancelled`, etc. Tests pass `enableWebSocket={false}` and
 * drive the reducer directly.
 */
export function SchedulerPage(props: SchedulerPageProps) {
	const use24Hour = use24HourClock();
	const useFixture =
		Boolean(props.initialRecordings) ||
		Boolean(props.initialSeriesRules) ||
		Boolean(props.initialConflicts);

	const [state, dispatch] = useReducer(schedulerReducer, undefined, () => ({
		...initialSchedulerState,
		recordings: props.initialRecordings ?? [],
		seriesRules: props.initialSeriesRules ?? [],
		conflicts: props.initialConflicts ?? []
	}));

	const [channels, setChannels] = useState<ChannelListItem[]>(
		props.initialChannels ?? []
	);
	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
		useFixture ? "ready" : "idle"
	);
	const [error, setError] = useState<Error | null>(null);

	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<SeriesRule | null>(null);
	const [editorSubmitting, setEditorSubmitting] = useState(false);
	const [editorError, setEditorError] = useState<string | null>(null);

	const [pendingDeleteRule, setPendingDeleteRule] = useState<SeriesRule | null>(
		null
	);

	const [pendingCancel, setPendingCancel] = useState<Recording | null>(null);
	const [cancelling, setCancelling] = useState(false);

	const loadRecordingRows = useCallback(
		() =>
			props.loadRecordings
				? props.loadRecordings()
				: Promise.all([
						listAllRecordings({ status: "scheduled" }),
						listAllRecordings({ status: "recording" })
					]).then(([scheduled, recording]) => [...scheduled, ...recording]),
		[props.loadRecordings]
	);
	const loadRuleRows = useCallback(
		() =>
			props.loadSeriesRules
				? props.loadSeriesRules()
				: listSeriesRules().then((page) => page.items),
		[props.loadSeriesRules]
	);
	const loadConflictRows = useCallback(
		() =>
			props.loadConflicts
				? props.loadConflicts()
				: listRecordingConflicts().then((page) => page.items),
		[props.loadConflicts]
	);
	const loadChannelRows = useCallback(
		() =>
			props.loadChannels
				? props.loadChannels()
				: listChannels().then((page) => page.items),
		[props.loadChannels]
	);

	const reconcileLiveState = useCallback(async () => {
		try {
			const [recordings, conflicts] = await Promise.all([
				loadRecordingRows(),
				loadConflictRows()
			]);
			dispatch({ type: "set-recordings", recordings });
			dispatch({ type: "set-conflicts", conflicts });
		} catch (failure) {
			console.warn("Failed to reconcile scheduler state", failure);
			setError(
				failure instanceof Error
					? failure
					: new Error("Failed to refresh scheduler")
			);
		}
	}, [loadConflictRows, loadRecordingRows]);

	// Initial load.
	useEffect(() => {
		if (useFixture) return;
		let cancelled = false;
		setStatus("loading");
		Promise.all([
			loadRecordingRows(),
			loadRuleRows(),
			loadConflictRows(),
			loadChannelRows()
		])
			.then(([recs, rules, conflicts, chans]) => {
				if (cancelled) return;
				dispatch({ type: "set-recordings", recordings: recs });
				dispatch({ type: "set-series-rules", rules });
				dispatch({ type: "set-conflicts", conflicts });
				setChannels(chans);
				setStatus("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err : new Error("Failed to load"));
				setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [
		useFixture,
		loadRecordingRows,
		loadRuleRows,
		loadConflictRows,
		loadChannelRows
	]);

	// Real-time conflict + recording updates from the WS bus.
	const handleEvent = useCallback((ev: EventMessage) => {
		if (ev.topic !== "recordings") return;
		if (ev.event === SERIES_RULE_EVENT.conflict) {
			const parsed = recordingConflictSchema.safeParse(ev.data);
			if (parsed.success) {
				dispatch({ type: "add-conflict", conflict: parsed.data });
			}
			return;
		}
		const parsed = parseRecordingEvent(ev);
		if (!parsed) return;
		if (parsed.event === RECORDING_EVENT.deleted) {
			dispatch({ type: "remove-recording", recordingId: parsed.recording.id });
			return;
		}
		dispatch({ type: "upsert-recording", recording: parsed.recording });
	}, []);

	useWebSocketEvents({
		topics: ["recordings"],
		onEvent: handleEvent,
		enabled: props.enableWebSocket !== false && !useFixture,
		onReconnect: reconcileLiveState
	});

	const upcoming = useMemo(() => selectUpcomingRecordings(state), [state]);
	const sortedRules = useMemo(() => selectSortedSeriesRules(state), [state]);
	const sortedConflicts = useMemo(() => selectSortedConflicts(state), [state]);

	const channelMap = useMemo(() => {
		const m = new Map<string, ChannelListItem>();
		for (const c of channels) m.set(c.id, c);
		return m;
	}, [channels]);

	/* ── Series rule actions ─────────────────────────────────────────── */

	const openCreate = useCallback(() => {
		setEditing(null);
		setEditorError(null);
		setEditorOpen(true);
	}, []);

	const openEdit = useCallback((rule: SeriesRule) => {
		setEditing(rule);
		setEditorError(null);
		setEditorOpen(true);
	}, []);

	const onEditorSubmit = useCallback(
		async (value: {
			title: string;
			channelId: string | null;
			keepCount: number;
			retentionDays: number | null;
			newOnly: boolean;
			priority: number;
		}) => {
			setEditorSubmitting(true);
			setEditorError(null);
			try {
				if (editing) {
					const updater = props.onUpdateSeriesRule ?? updateSeriesRule;
					const updated = await updater(editing.id, value);
					dispatch({ type: "upsert-series-rule", rule: updated });
				} else {
					const creator = props.onCreateSeriesRule ?? createSeriesRule;
					const created = await creator({
						title: value.title,
						channelId: value.channelId,
						keepCount: value.keepCount,
						retentionDays: value.retentionDays,
						newOnly: value.newOnly,
						priority: value.priority
					});
					dispatch({ type: "upsert-series-rule", rule: created });
				}
				setEditorOpen(false);
			} catch (err) {
				setEditorError(
					err instanceof Error ? err.message : "Failed to save series rule"
				);
			} finally {
				setEditorSubmitting(false);
			}
		},
		[editing, props.onCreateSeriesRule, props.onUpdateSeriesRule]
	);

	const confirmDeleteRule = useCallback(async () => {
		if (!pendingDeleteRule) return;
		const remover = props.onDeleteSeriesRule ?? deleteSeriesRule;
		try {
			await remover(pendingDeleteRule.id);
			dispatch({ type: "remove-series-rule", ruleId: pendingDeleteRule.id });
			setPendingDeleteRule(null);
		} catch (err) {
			setError(
				err instanceof Error ? err : new Error("Failed to delete series rule")
			);
		}
	}, [pendingDeleteRule, props.onDeleteSeriesRule]);

	/* ── Recording actions ───────────────────────────────────────────── */

	const confirmCancel = useCallback(async () => {
		if (!pendingCancel) return;
		setCancelling(true);
		const canceller = props.onCancelRecording ?? cancelRecording;
		try {
			await canceller(pendingCancel.id);
			dispatch({ type: "remove-recording", recordingId: pendingCancel.id });
			setPendingCancel(null);
		} catch (err) {
			setError(
				err instanceof Error ? err : new Error("Failed to cancel recording")
			);
		} finally {
			setCancelling(false);
		}
	}, [pendingCancel, props.onCancelRecording]);

	/* ── Conflict actions ────────────────────────────────────────────── */

	const dropConflict = useCallback(
		async (conflict: RecordingConflict) => {
			// "Drop" cancels the affected recording (if it has one) and
			// dismisses the conflict row. Synthetic candidates (no live
			// recording row yet) just dismiss locally.
			const canceller = props.onCancelRecording ?? cancelRecording;
			try {
				const target = state.recordings.find(
					(r) => r.programId === conflict.programId && r.programId !== null
				);
				if (target) {
					await canceller(target.id);
					dispatch({ type: "remove-recording", recordingId: target.id });
				}
				dispatch({ type: "resolve-conflict", conflictId: conflict.id });
			} catch (err) {
				setError(
					err instanceof Error ? err : new Error("Failed to drop conflict")
				);
			}
		},
		[props.onCancelRecording, state.recordings]
	);

	const acceptConflict = useCallback((conflict: RecordingConflict) => {
		dispatch({ type: "resolve-conflict", conflictId: conflict.id });
	}, []);

	/* ── Render ──────────────────────────────────────────────────────── */

	if (status === "loading") {
		return (
			<div
				data-testid="scheduler-loading"
				className="flex items-center justify-center p-12"
			>
				<Spinner aria-label="Loading scheduler" />
			</div>
		);
	}

	if (status === "error") {
		return (
			<EmptyState
				data-testid="scheduler-error"
				icon={<AlertTriangle />}
				title="Couldn't load scheduler"
				description={error?.message ?? "Please try again."}
				action={<Button onClick={() => location.reload()}>Reload</Button>}
			/>
		);
	}

	return (
		<section
			data-testid="scheduler-page"
			className="flex flex-col gap-4"
			aria-labelledby="scheduler-heading"
		>
			<PageHeader
				headingId="scheduler-heading"
				title="Scheduler"
				description="Manage what gets recorded — upcoming jobs, series rules, and conflicts."
			/>

			<Tabs
				value={state.tab}
				onValueChange={(v) =>
					dispatch({ type: "set-tab", tab: v as SchedulerTab })
				}
			>
				{/* Compact labels prevent the three-tab strip from widening mobile pages. */}
				<TabsList className="grid w-full grid-cols-3 sm:inline-flex sm:w-auto">
					<TabsTrigger
						value="upcoming"
						data-testid="scheduler-tab-upcoming"
						className="min-w-0 gap-1 px-2 text-xs sm:gap-2 sm:px-3 sm:text-sm"
					>
						<CalendarClock
							aria-hidden="true"
							className="hidden h-4 w-4 sm:block"
						/>
						Upcoming
						{upcoming.length > 0 ? (
							<Badge
								variant="outline"
								data-testid="scheduler-upcoming-count"
								className="hidden sm:inline-flex"
							>
								{upcoming.length}
							</Badge>
						) : null}
					</TabsTrigger>
					<TabsTrigger
						value="series"
						data-testid="scheduler-tab-series"
						className="min-w-0 gap-1 px-2 text-xs sm:gap-2 sm:px-3 sm:text-sm"
					>
						<ListChecks
							aria-hidden="true"
							className="hidden h-4 w-4 sm:block"
						/>
						Series rules
						{sortedRules.length > 0 ? (
							<Badge variant="outline" className="hidden sm:inline-flex">
								{sortedRules.length}
							</Badge>
						) : null}
					</TabsTrigger>
					<TabsTrigger
						value="conflicts"
						data-testid="scheduler-tab-conflicts"
						className="min-w-0 gap-1 px-2 text-xs sm:gap-2 sm:px-3 sm:text-sm"
					>
						<AlertTriangle
							aria-hidden="true"
							className="hidden h-4 w-4 sm:block"
						/>
						Conflicts
						{sortedConflicts.length > 0 ? (
							<Badge
								variant="danger"
								data-testid="scheduler-conflicts-count"
								className="hidden sm:inline-flex"
							>
								{sortedConflicts.length}
							</Badge>
						) : null}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="upcoming">
					<UpcomingList
						recordings={upcoming}
						channelMap={channelMap}
						use24Hour={use24Hour}
						onCancel={(r) => setPendingCancel(r)}
					/>
				</TabsContent>

				<TabsContent value="series">
					<div className="flex items-center justify-between gap-2 pb-3">
						<p className="text-sm text-secondary">
							Recurring "season pass" rules. The scheduler evaluates these on
							every EPG refresh.
						</p>
						<Button onClick={openCreate} data-testid="scheduler-new-rule">
							<Plus aria-hidden="true" className="h-4 w-4" />
							New rule
						</Button>
					</div>
					<SeriesRulesTable
						rules={sortedRules}
						channelMap={channelMap}
						onEdit={openEdit}
						onDelete={(rule) => setPendingDeleteRule(rule)}
					/>
				</TabsContent>

				<TabsContent value="conflicts">
					<ConflictsList
						conflicts={sortedConflicts}
						channelMap={channelMap}
						use24Hour={use24Hour}
						onDrop={(c) => void dropConflict(c)}
						onAccept={acceptConflict}
					/>
				</TabsContent>
			</Tabs>

			{/* Series rule editor modal */}
			<Modal
				open={editorOpen}
				onOpenChange={(o) => {
					if (!o && !editorSubmitting) {
						setEditorOpen(false);
						setEditing(null);
					}
				}}
			>
				<ModalContent data-testid="scheduler-editor-modal">
					<ModalHeader>
						<ModalTitle>
							{editing ? "Edit series rule" : "New series rule"}
						</ModalTitle>
						<ModalDescription>
							{editing
								? "Update the recurring rule used to schedule episodes."
								: "Add a recurring rule. The scheduler will record matching upcoming episodes automatically."}
						</ModalDescription>
					</ModalHeader>
					<SeriesRuleEditor
						rule={editing}
						channels={channels}
						onSubmit={onEditorSubmit}
						onCancel={() => {
							if (editorSubmitting) return;
							setEditorOpen(false);
							setEditing(null);
						}}
						submitting={editorSubmitting}
						serverError={editorError}
					/>
				</ModalContent>
			</Modal>

			{/* Cancel recording confirmation */}
			<Modal
				open={pendingCancel !== null}
				onOpenChange={(o) => {
					if (!o && !cancelling) setPendingCancel(null);
				}}
			>
				<ModalContent data-testid="scheduler-cancel-confirm">
					<ModalHeader>
						<ModalTitle>Cancel recording?</ModalTitle>
						<ModalDescription>
							{pendingCancel
								? `"${pendingCancel.title}" will not be recorded.`
								: ""}
						</ModalDescription>
					</ModalHeader>
					<ModalFooter>
						<Button
							variant="outline"
							onClick={() => setPendingCancel(null)}
							disabled={cancelling}
						>
							Keep
						</Button>
						<Button
							variant="danger"
							onClick={() => void confirmCancel()}
							disabled={cancelling}
							data-testid="scheduler-cancel-confirm-button"
						>
							{cancelling ? "Cancelling…" : "Cancel recording"}
						</Button>
					</ModalFooter>
				</ModalContent>
			</Modal>

			{/* Delete series rule confirmation */}
			<Modal
				open={pendingDeleteRule !== null}
				onOpenChange={(o) => {
					if (!o) setPendingDeleteRule(null);
				}}
			>
				<ModalContent data-testid="scheduler-delete-rule-confirm">
					<ModalHeader>
						<ModalTitle>Delete series rule?</ModalTitle>
						<ModalDescription>
							{pendingDeleteRule
								? `"${pendingDeleteRule.title}" will stop scheduling new recordings. Existing recordings are preserved.`
								: ""}
						</ModalDescription>
					</ModalHeader>
					<ModalFooter>
						<Button
							variant="outline"
							onClick={() => setPendingDeleteRule(null)}
						>
							Cancel
						</Button>
						<Button
							variant="danger"
							onClick={() => void confirmDeleteRule()}
							data-testid="scheduler-delete-rule-confirm-button"
						>
							Delete rule
						</Button>
					</ModalFooter>
				</ModalContent>
			</Modal>
		</section>
	);
}

/* ── Subcomponents ─────────────────────────────────────────────────── */

function channelLabel(
	channelMap: Map<string, ChannelListItem>,
	id: string
): string {
	const c = channelMap.get(id);
	if (!c) return "Unknown channel";
	return `${c.number} ${c.name}`;
}

interface UpcomingListProps {
	recordings: Recording[];
	channelMap: Map<string, ChannelListItem>;
	use24Hour: boolean;
	onCancel: (r: Recording) => void;
}

function UpcomingList(props: UpcomingListProps) {
	if (props.recordings.length === 0) {
		return (
			<EmptyState
				data-testid="scheduler-upcoming-empty"
				icon={<CalendarClock />}
				title="Nothing upcoming"
				description="Schedule a recording from the guide or add a series rule to populate this list."
			/>
		);
	}
	return (
		<ul data-testid="scheduler-upcoming-list" className="flex flex-col gap-2">
			{props.recordings.map((r) => (
				<li key={r.id} data-testid={`scheduler-upcoming-${r.id}`}>
					<Card>
						<CardContent className="flex flex-wrap items-center gap-3 py-3">
							<div className="flex flex-1 flex-col gap-1 min-w-[14rem]">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium text-primary">{r.title}</span>
									<Badge
										variant={STATUS_BADGE[r.status]}
										data-testid={`scheduler-upcoming-status-${r.id}`}
									>
										{r.status === "recording" ? (
											<>
												<Disc3
													aria-hidden="true"
													className="mr-1 h-3 w-3 animate-pulse"
												/>
												Recording
											</>
										) : (
											r.status
										)}
									</Badge>
									{r.seriesRuleId ? (
										<Badge variant="outline">Series</Badge>
									) : null}
								</div>
								<span className="text-xs text-secondary">
									{channelLabel(props.channelMap, r.channelId)} ·{" "}
									{formatDateTimePreference(r.scheduledStart, props.use24Hour)}{" "}
									– {formatDateTimePreference(r.scheduledEnd, props.use24Hour)}
								</span>
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => props.onCancel(r)}
								data-testid={`scheduler-upcoming-cancel-${r.id}`}
							>
								<XCircle aria-hidden="true" className="h-4 w-4" />
								Cancel
							</Button>
						</CardContent>
					</Card>
				</li>
			))}
		</ul>
	);
}

interface SeriesRulesTableProps {
	rules: SeriesRule[];
	channelMap: Map<string, ChannelListItem>;
	onEdit: (r: SeriesRule) => void;
	onDelete: (r: SeriesRule) => void;
}

function SeriesRulesTable(props: SeriesRulesTableProps) {
	if (props.rules.length === 0) {
		return (
			<EmptyState
				data-testid="scheduler-series-empty"
				icon={<ListChecks />}
				title="No series rules"
				description="Create a rule to record every episode of a show automatically."
			/>
		);
	}
	return (
		<ul data-testid="scheduler-series-list" className="flex flex-col gap-2">
			{props.rules.map((rule) => (
				<li key={rule.id} data-testid={`scheduler-series-${rule.id}`}>
					<Card>
						<CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
							<div>
								<CardTitle className="text-base">{rule.title}</CardTitle>
								<p className="text-xs text-secondary">
									{rule.channelId
										? channelLabel(props.channelMap, rule.channelId)
										: "Any channel"}
								</p>
							</div>
							<div className="flex items-center gap-1">
								<IconButton
									aria-label={`Edit ${rule.title}`}
									data-testid={`scheduler-series-edit-${rule.id}`}
									onClick={() => props.onEdit(rule)}
								>
									<Pencil aria-hidden="true" className="h-4 w-4" />
								</IconButton>
								<IconButton
									aria-label={`Delete ${rule.title}`}
									data-testid={`scheduler-series-delete-${rule.id}`}
									onClick={() => props.onDelete(rule)}
								>
									<Trash2 aria-hidden="true" className="h-4 w-4" />
								</IconButton>
							</div>
						</CardHeader>
						<CardContent className="flex flex-wrap gap-2 text-xs text-secondary">
							<Badge variant="outline">Keep newest {rule.keepCount}</Badge>
							<Badge variant="outline">
								{rule.retentionDays === null
									? "No age limit"
									: `Delete after ${rule.retentionDays} ${
											rule.retentionDays === 1 ? "day" : "days"
										}`}
							</Badge>
							<Badge variant="outline">Priority {rule.priority}</Badge>
							{rule.newOnly ? (
								<Badge variant="outline">New only</Badge>
							) : (
								<Badge variant="outline">All airings</Badge>
							)}
						</CardContent>
					</Card>
				</li>
			))}
		</ul>
	);
}

interface ConflictsListProps {
	conflicts: RecordingConflict[];
	channelMap: Map<string, ChannelListItem>;
	use24Hour: boolean;
	onDrop: (c: RecordingConflict) => void;
	onAccept: (c: RecordingConflict) => void;
}

function ConflictsList(props: ConflictsListProps) {
	if (props.conflicts.length === 0) {
		return (
			<EmptyState
				data-testid="scheduler-conflicts-empty"
				icon={<AlertTriangle />}
				title="No conflicts"
				description="The scheduler hasn't surfaced any conflicts. You're all set."
			/>
		);
	}
	return (
		<ul data-testid="scheduler-conflicts-list" className="flex flex-col gap-2">
			{props.conflicts.map((c) => (
				<li key={c.id} data-testid={`scheduler-conflict-${c.id}`}>
					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="flex items-center gap-2 text-base">
								<AlertTriangle
									aria-hidden="true"
									className="h-4 w-4 text-danger"
								/>
								{c.title}
							</CardTitle>
							<p className="text-xs text-secondary">
								{channelLabel(props.channelMap, c.channelId)} ·{" "}
								{formatDateTimePreference(c.scheduledStart, props.use24Hour)} –{" "}
								{formatDateTimePreference(c.scheduledEnd, props.use24Hour)}
							</p>
						</CardHeader>
						<CardContent className="flex flex-wrap items-center gap-3">
							<p
								className="flex-1 text-sm text-primary min-w-[16rem]"
								data-testid={`scheduler-conflict-message-${c.id}`}
							>
								{c.message}
							</p>
							<Badge variant="outline">{c.reason.replace(/_/g, " ")}</Badge>
							<div className="flex items-center gap-2">
								<Button
									variant="danger"
									size="sm"
									data-testid={`scheduler-conflict-drop-${c.id}`}
									onClick={() => props.onDrop(c)}
								>
									Drop
								</Button>
								<Button
									variant="outline"
									size="sm"
									data-testid={`scheduler-conflict-accept-${c.id}`}
									onClick={() => props.onAccept(c)}
								>
									Accept resolution
								</Button>
							</div>
						</CardContent>
					</Card>
				</li>
			))}
		</ul>
	);
}
