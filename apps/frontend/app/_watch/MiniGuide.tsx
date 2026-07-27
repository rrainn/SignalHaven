"use client";

import type { EpgGridProgram } from "@signalhaven/shared";
import { CalendarRange, CircleDot, Repeat, XCircle } from "lucide-react";

import { EmptyState } from "../_ui/EmptyState";
import { IconButton } from "../_ui/IconButton";
import { RecordingStatusBadge } from "../_recordings/RecordingStatusBadge";
import type { ProgramRecordingAction } from "../_recordings/useProgramRecordingActions";
import { Spinner } from "../_ui/Spinner";
import { formatTimeLabel } from "../_guide/time";
import { cn } from "../_ui/cn";

export interface MiniGuideProps {
	/** Programs scoped to the current channel, sorted ascending by start. */
	programs: EpgGridProgram[];
	/** Reference "now" — the entry whose [start, stop) contains it is highlighted. */
	now: Date;
	use24Hour?: boolean;
	onRecord: (program: EpgGridProgram) => void;
	onCancel: (program: EpgGridProgram) => void;
	onRecordSeries: (program: EpgGridProgram) => void;
	pendingActions: ReadonlyMap<string, ProgramRecordingAction>;
}

/**
 * Compact program list rendered below the player. Shows the next ~6
 * entries on the active channel and exposes inline record / record
 * series actions per row.
 */
export function MiniGuide(props: MiniGuideProps) {
	const {
		programs,
		now,
		use24Hour = false,
		onRecord,
		onCancel,
		onRecordSeries,
		pendingActions
	} = props;

	if (programs.length === 0) {
		return (
			<section
				data-testid="watch-mini-guide"
				aria-label="Channel mini-guide"
				className="rounded-lg border border-border bg-surface"
			>
				<EmptyState
					icon={<CalendarRange aria-hidden="true" />}
					title="No upcoming programs"
					description="There's no guide data for this channel yet."
				/>
			</section>
		);
	}

	const ts = now.getTime();

	return (
		<section
			data-testid="watch-mini-guide"
			aria-label="Channel mini-guide"
			className="rounded-lg border border-border bg-surface"
		>
			<h2 className="border-b border-border px-3 py-2 text-sm font-semibold text-primary">
				On this channel
			</h2>
			<ul className="divide-y divide-border">
				{programs.map((p) => {
					const start = Date.parse(p.start);
					const stop = Date.parse(p.stop);
					const airing = start <= ts && ts < stop;
					const activeRecording =
						p.recordingStatus === "scheduled" ||
						p.recordingStatus === "recording";
					const pendingAction = pendingActions.get(p.id);
					return (
						<li
							key={p.id}
							data-testid="mini-guide-row"
							className={cn(
								"flex items-start gap-3 px-3 py-2",
								airing && "bg-surface-muted"
							)}
						>
							<span className="w-16 shrink-0 text-xs tabular-nums text-secondary">
								{formatTimeLabel(new Date(p.start), use24Hour)}
							</span>
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium text-primary">
									{p.title}
									{airing ? (
										<span className="ml-2 text-[10px] uppercase tracking-wide text-accent">
											Now
										</span>
									) : null}
									<RecordingStatusBadge
										status={p.recordingStatus}
										className="ml-2 align-middle"
									/>
								</p>
								{p.subtitle ? (
									<p className="truncate text-xs text-secondary">
										{p.subtitle}
									</p>
								) : null}
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<IconButton
									aria-label={
										pendingAction === "schedule"
											? `Scheduling ${p.title}`
											: pendingAction === "cancel"
												? `Cancelling ${p.title}`
												: activeRecording
													? `Cancel recording ${p.title}`
													: `Record ${p.title}`
									}
									size="sm"
									variant={activeRecording ? "danger" : "ghost"}
									data-testid={`mini-guide-record-${p.id}`}
									disabled={pendingAction !== undefined}
									onClick={() => (activeRecording ? onCancel(p) : onRecord(p))}
								>
									{pendingAction === "schedule" ||
									pendingAction === "cancel" ? (
										<Spinner aria-hidden="true" />
									) : activeRecording ? (
										<XCircle aria-hidden="true" />
									) : (
										<CircleDot aria-hidden="true" />
									)}
								</IconButton>
								<IconButton
									aria-label={`Record series for ${p.title}`}
									size="sm"
									variant="ghost"
									data-testid={`mini-guide-record-series-${p.id}`}
									disabled={pendingAction !== undefined}
									onClick={() => onRecordSeries(p)}
								>
									{pendingAction === "series" ? (
										<Spinner aria-hidden="true" />
									) : (
										<Repeat aria-hidden="true" />
									)}
								</IconButton>
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
