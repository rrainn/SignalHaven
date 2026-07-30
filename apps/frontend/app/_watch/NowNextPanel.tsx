"use client";

import type { EpgGridProgram } from "@signalhaven/shared";
import { CircleDot, Repeat, Star, XCircle } from "lucide-react";

import { RecordingStatusBadge } from "../_recordings/RecordingStatusBadge";
import type { ProgramRecordingAction } from "../_recordings/useProgramRecordingActions";
import { Button } from "../_ui/Button";
import { cn } from "../_ui/cn";
import { IconButton } from "../_ui/IconButton";
import { Spinner } from "../_ui/Spinner";
import { formatTimeLabel } from "../_guide/time";

export interface NowNextPanelProps {
	channelName: string;
	channelNumber: string;
	/** Whether the current channel is in the user's favorites. */
	isFavorite: boolean;
	/** Prevents duplicate writes while the favorite preference is saving. */
	favoritePending?: boolean;
	/** Toggles the current channel's persisted favorite state. */
	onToggleFavorite: () => void;
	/** Program currently airing, or `null` when no EPG data is available. */
	now: EpgGridProgram | null;
	/** Next program in the future, or `null` when none is known. */
	next: EpgGridProgram | null;
	use24Hour?: boolean;
	/** Inline "Record this program" handler. */
	onRecord: (program: EpgGridProgram) => void;
	/** Inline cancellation handler for active recordings. */
	onCancel: (program: EpgGridProgram) => void;
	/** Inline "Record series" handler. */
	onRecordSeries: (program: EpgGridProgram) => void;
	pendingAction?: ProgramRecordingAction | undefined;
}

/**
 * Compact "now playing / up next" strip rendered directly under the
 * player. Surfaces the U7 inline record actions for the currently
 * airing program.
 */
export function NowNextPanel(props: NowNextPanelProps) {
	const {
		channelName,
		channelNumber,
		isFavorite,
		favoritePending = false,
		onToggleFavorite,
		now,
		next,
		use24Hour = false,
		onRecord,
		onCancel,
		onRecordSeries,
		pendingAction
	} = props;

	const activeRecording =
		now?.recordingStatus === "scheduled" ||
		now?.recordingStatus === "recording";

	return (
		<section
			data-testid="watch-now-next"
			className="rounded-lg border border-border bg-surface p-3"
			aria-label="Now playing and up next"
		>
			<header className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1">
					<h2 className="truncate text-sm font-semibold text-primary">
						<span className="text-secondary">{channelNumber}</span>{" "}
						<span>{channelName}</span>
					</h2>
					<IconButton
						aria-label={
							isFavorite
								? `Remove ${channelName} from favorites`
								: `Add ${channelName} to favorites`
						}
						aria-pressed={isFavorite}
						variant="ghost"
						size="sm"
						disabled={favoritePending}
						onClick={onToggleFavorite}
						data-testid="watch-favorite"
					>
						<Star
							aria-hidden="true"
							className={cn(
								"h-4 w-4",
								isFavorite ? "fill-amber-400 text-amber-500" : ""
							)}
						/>
					</IconButton>
				</div>
				{now ? (
					<span className="text-xs text-secondary">
						{formatTimeLabel(new Date(now.start), use24Hour)} –{" "}
						{formatTimeLabel(new Date(now.stop), use24Hour)}
					</span>
				) : null}
			</header>

			<div data-testid="watch-now" className="mt-2 space-y-1">
				{now ? (
					<>
						<p className="text-base font-medium text-primary">
							{now.title}
							<RecordingStatusBadge
								status={now.recordingStatus}
								className="ml-2 align-middle"
							/>
						</p>
						{now.subtitle ? (
							<p className="text-sm text-secondary">{now.subtitle}</p>
						) : null}
					</>
				) : (
					<p className="text-sm text-secondary">No guide data for this hour.</p>
				)}
			</div>

			{next ? (
				<p data-testid="watch-up-next" className="mt-2 text-xs text-secondary">
					<span className="font-medium text-primary">Up next:</span>{" "}
					{next.title} · {formatTimeLabel(new Date(next.start), use24Hour)}
				</p>
			) : null}

			{now ? (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button
						variant={activeRecording ? "danger" : "outline"}
						size="sm"
						disabled={pendingAction !== undefined}
						onClick={() => (activeRecording ? onCancel(now) : onRecord(now))}
						data-testid="watch-record"
					>
						{pendingAction === "schedule" || pendingAction === "cancel" ? (
							<Spinner aria-hidden="true" className="h-4 w-4" />
						) : activeRecording ? (
							<XCircle aria-hidden="true" className="h-4 w-4" />
						) : (
							<CircleDot aria-hidden="true" className="h-4 w-4" />
						)}
						{pendingAction === "schedule"
							? "Scheduling…"
							: pendingAction === "cancel"
								? "Cancelling…"
								: activeRecording
									? "Cancel recording"
									: "Record this program"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={pendingAction !== undefined}
						onClick={() => onRecordSeries(now)}
						data-testid="watch-record-series"
					>
						{pendingAction === "series" ? (
							<Spinner aria-hidden="true" className="h-4 w-4" />
						) : (
							<Repeat aria-hidden="true" className="h-4 w-4" />
						)}
						{pendingAction === "series" ? "Creating…" : "Record series"}
					</Button>
				</div>
			) : null}
		</section>
	);
}
