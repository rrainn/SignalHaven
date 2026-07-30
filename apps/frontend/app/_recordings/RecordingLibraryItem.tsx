"use client";

import type { ChannelListItem, RecordingListItem } from "@signalhaven/shared";
import {
	CheckSquare,
	Eye,
	EyeOff,
	Shield,
	ShieldCheck,
	Square,
	Trash2
} from "lucide-react";

import { formatDateTimePreference } from "../_preferences/formatting";
import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { IconButton } from "../_ui/IconButton";
import { cn } from "../_ui/cn";
import { buildRecordingArtworkUrl } from "../../lib/api-client";

import { RecordingArtwork } from "./RecordingArtwork";
import { RecordingStatusBadge } from "./RecordingStatusBadge";
import {
	formatEpisodeLabel,
	formatPartialRecordingReason,
	getRecordingFailurePresentation,
	getRecordingViewState
} from "./presentation";
import { formatBytes, formatDuration } from "./state";

export interface RecordingLibraryItemProps {
	recording: RecordingListItem;
	channel: ChannelListItem | null;
	mode: "grid" | "list";
	selected?: boolean | undefined;
	selectable?: boolean | undefined;
	pending?: boolean | undefined;
	use24Hour: boolean;
	onToggleSelect?: (() => void) | undefined;
	onOpen: () => void;
	onDelete: () => void;
	onToggleProtected: () => void;
	onToggleWatched: () => void;
}

/**
 * Shared rich recording item used by the library and series views. Keeping
 * status, metadata, progress, and action semantics here prevents the two
 * surfaces from drifting apart.
 */
export function RecordingLibraryItem(props: RecordingLibraryItemProps) {
	return props.mode === "grid" ? (
		<RecordingCard {...props} />
	) : (
		<RecordingRow {...props} />
	);
}

/** Render shared state badges in a stable, screen-reader-friendly order. */
function RecordingBadges({ recording }: { recording: RecordingListItem }) {
	const viewState = getRecordingViewState(recording);
	return (
		<div className="flex flex-wrap items-center gap-1">
			<RecordingStatusBadge status={recording.status} />
			{recording.manuallyProtected ? (
				<Badge variant="outline">
					<ShieldCheck aria-hidden="true" className="mr-1 h-3 w-3" />
					Protected
				</Badge>
			) : null}
			<Badge variant={viewState.kind === "in-progress" ? "accent" : "outline"}>
				{viewState.label}
			</Badge>
		</div>
	);
}

/** Render progress only when a recording has a meaningful resume position. */
function RecordingProgress({ recording }: { recording: RecordingListItem }) {
	const viewState = getRecordingViewState(recording);
	if (viewState.kind !== "in-progress") return null;
	return (
		<div
			data-testid={`recording-progress-${recording.id}`}
			className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
			role="progressbar"
			aria-label="Recording watch progress"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={viewState.progressPercent}
		>
			<div
				className="h-full rounded-full bg-accent"
				style={{ width: `${viewState.progressPercent}%` }}
			/>
		</div>
	);
}

/** Render episode, partial-capture, and safe failure summaries. */
function RecordingSupportingCopy({
	recording
}: {
	recording: RecordingListItem;
}) {
	const episodeLabel = recording.metadata
		? formatEpisodeLabel(recording.metadata)
		: null;
	const partialReason = formatPartialRecordingReason(recording.startReason);
	const failure =
		recording.status === "failed"
			? getRecordingFailurePresentation(recording.errorMessage)
			: null;
	return (
		<>
			{episodeLabel ? (
				<p
					data-testid={`recording-episode-${recording.id}`}
					className="line-clamp-1 text-xs text-secondary"
				>
					{episodeLabel}
				</p>
			) : null}
			{partialReason ? (
				<p
					data-testid={`recording-late-start-${recording.id}`}
					className="text-xs font-medium text-primary"
				>
					Partial recording · started late
				</p>
			) : null}
			{failure ? (
				<p
					data-testid={`recording-failure-${recording.id}`}
					className="text-xs font-medium text-danger"
				>
					{failure.summary}
				</p>
			) : null}
		</>
	);
}

/** Render controls that mutate only one explicit recording field at a time. */
function RecordingActions(props: RecordingLibraryItemProps) {
	const { recording, pending } = props;
	return (
		<div className="flex flex-wrap items-center gap-1">
			<Button
				size="sm"
				onClick={props.onOpen}
				disabled={pending}
				data-testid={`recording-play-${recording.id}`}
			>
				{recording.status === "completed" ? "Play" : "View details"}
			</Button>
			<IconButton
				aria-label={
					recording.manuallyProtected
						? "Unprotect recording"
						: "Protect recording"
				}
				onClick={props.onToggleProtected}
				disabled={pending}
				data-testid={`recording-protect-${recording.id}`}
			>
				{recording.manuallyProtected ? (
					<ShieldCheck aria-hidden="true" className="h-4 w-4" />
				) : (
					<Shield aria-hidden="true" className="h-4 w-4" />
				)}
			</IconButton>
			<IconButton
				aria-label={
					recording.watchedAt
						? "Mark recording unwatched"
						: "Mark recording watched"
				}
				onClick={props.onToggleWatched}
				disabled={pending}
				data-testid={`recording-watched-${recording.id}`}
			>
				{recording.watchedAt ? (
					<EyeOff aria-hidden="true" className="h-4 w-4" />
				) : (
					<Eye aria-hidden="true" className="h-4 w-4" />
				)}
			</IconButton>
			<IconButton
				aria-label="Delete recording"
				onClick={props.onDelete}
				disabled={pending}
				data-testid={`recording-delete-${recording.id}`}
			>
				<Trash2 aria-hidden="true" className="h-4 w-4" />
			</IconButton>
		</div>
	);
}

/** Card layout optimized for artwork-forward grid browsing. */
function RecordingCard(props: RecordingLibraryItemProps) {
	const recording = props.recording;
	const selectable = props.selectable !== false;
	return (
		<Card
			data-testid={`recording-card-${recording.id}`}
			data-recording-id={recording.id}
			aria-busy={props.pending}
			className={cn(
				"flex h-full flex-col overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_22rem]",
				props.selected && "ring-2 ring-primary",
				props.pending && "opacity-70"
			)}
		>
			<RecordingArtwork
				src={
					recording.metadata?.artworkUrl
						? buildRecordingArtworkUrl(recording.id)
						: null
				}
				title={recording.title}
				className="aspect-video w-full"
			/>
			<CardHeader className="flex flex-row items-start justify-between gap-2">
				<div className="flex min-w-0 flex-1 items-start gap-2">
					{selectable ? (
						<button
							type="button"
							aria-label={props.selected ? "Deselect" : "Select"}
							aria-pressed={props.selected}
							data-testid={`recording-select-${recording.id}`}
							onClick={props.onToggleSelect}
							disabled={props.pending}
							className="mt-0.5 text-muted hover:text-primary"
						>
							{props.selected ? (
								<CheckSquare aria-hidden="true" className="h-4 w-4" />
							) : (
								<Square aria-hidden="true" className="h-4 w-4" />
							)}
						</button>
					) : null}
					<div className="min-w-0">
						<CardTitle className="line-clamp-2 text-base">
							<button
								type="button"
								className="text-left hover:underline"
								onClick={props.onOpen}
							>
								{recording.title || "Untitled recording"}
							</button>
						</CardTitle>
						<RecordingSupportingCopy recording={recording} />
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex flex-1 flex-col justify-end gap-2 text-xs text-secondary">
				<RecordingBadges recording={recording} />
				<p>{props.channel?.name ?? "Unknown channel"}</p>
				<p>
					{formatDateTimePreference(
						recording.actualStart ?? recording.scheduledStart,
						props.use24Hour
					)}
				</p>
				<p>
					{formatDuration(recording.durationSeconds)} ·{" "}
					{formatBytes(recording.fileSize)}
				</p>
				<RecordingProgress recording={recording} />
				<RecordingActions {...props} />
			</CardContent>
		</Card>
	);
}

/** Compact row layout that retains artwork and episode differentiation. */
function RecordingRow(props: RecordingLibraryItemProps) {
	const recording = props.recording;
	const selectable = props.selectable !== false;
	return (
		<div
			data-testid={`recording-row-${recording.id}`}
			data-recording-id={recording.id}
			aria-busy={props.pending}
			className={cn(
				"flex items-center gap-3 px-3 py-2 [content-visibility:auto] [contain-intrinsic-size:auto_5rem]",
				props.selected && "bg-surface-muted",
				props.pending && "opacity-70"
			)}
		>
			{selectable ? (
				<button
					type="button"
					aria-label={props.selected ? "Deselect" : "Select"}
					aria-pressed={props.selected}
					data-testid={`recording-select-${recording.id}`}
					onClick={props.onToggleSelect}
					disabled={props.pending}
					className="text-muted hover:text-primary"
				>
					{props.selected ? (
						<CheckSquare aria-hidden="true" className="h-4 w-4" />
					) : (
						<Square aria-hidden="true" className="h-4 w-4" />
					)}
				</button>
			) : null}
			<RecordingArtwork
				src={
					recording.metadata?.artworkUrl
						? buildRecordingArtworkUrl(recording.id)
						: null
				}
				title={recording.title}
				className="h-14 w-24 shrink-0 rounded"
			/>
			<div className="min-w-0 flex-1">
				<button
					type="button"
					className="block truncate text-left text-sm font-medium text-primary hover:underline"
					onClick={props.onOpen}
				>
					{recording.title || "Untitled recording"}
				</button>
				<RecordingSupportingCopy recording={recording} />
				<div className="mt-1 md:hidden">
					<RecordingBadges recording={recording} />
				</div>
				<p className="truncate text-xs text-secondary">
					{props.channel?.name ?? "Unknown channel"} ·{" "}
					{formatDateTimePreference(
						recording.actualStart ?? recording.scheduledStart,
						props.use24Hour
					)}
				</p>
				<RecordingProgress recording={recording} />
			</div>
			<div className="hidden flex-col items-end gap-1 md:flex">
				<span className="text-xs text-secondary">
					{formatDuration(recording.durationSeconds)} ·{" "}
					{formatBytes(recording.fileSize)}
				</span>
				<RecordingBadges recording={recording} />
			</div>
			<RecordingActions {...props} />
		</div>
	);
}
