"use client";

import type {
	EpgGridChannel,
	EpgGridProgram,
	EpgProgram
} from "@signalhaven/shared";
import { CircleDot, Disc3, Play, Repeat, XCircle } from "lucide-react";

import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { RecordingStatusBadge } from "../_recordings/RecordingStatusBadge";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle
} from "../_ui/Modal";
import { Spinner } from "../_ui/Spinner";
import { formatDateLabel, formatTimeLabel, isSameLocalDay } from "./time";

export interface ProgramDetailsModalProps {
	program: EpgGridProgram | null;
	/** Rich fields loaded independently from the lightweight grid cell. */
	details?: Pick<EpgProgram, "description" | "categories"> | null | undefined;
	detailsStatus?: "idle" | "loading" | "ready" | "error" | undefined;
	onRetryDetails?: (() => void) | undefined;
	channel: EpgGridChannel | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onWatch: (program: EpgGridProgram) => void;
	onRecord: (program: EpgGridProgram) => void;
	onRecordSeries: (program: EpgGridProgram) => void;
	onCancel: (program: EpgGridProgram) => Promise<void>;
	recordingPending?: boolean | undefined;
	recordingError?: string | null | undefined;
	/** Whether the user prefers a 24-hour clock; defaults to false. */
	use24Hour?: boolean;
	/** Clock override used by deterministic details and guide tests. */
	now?: Date | undefined;
}

/**
 * Details modal triggered by clicking a program cell. Exposes the three
 * actions called out in the U4-guide acceptance criteria: Watch, Record,
 * Record series.
 */
export function ProgramDetailsModal(props: ProgramDetailsModalProps) {
	const {
		program,
		details,
		detailsStatus = "ready",
		onRetryDetails,
		channel,
		open,
		onOpenChange,
		onWatch,
		onRecord,
		onRecordSeries,
		onCancel,
		recordingPending = false,
		recordingError,
		use24Hour = false,
		now = new Date()
	} = props;

	if (!program) {
		return <Modal open={open} onOpenChange={onOpenChange} />;
	}

	const start = new Date(program.start);
	const stop = new Date(program.stop);
	const recording =
		program.recordingStatus === "recording" ||
		program.recordingStatus === "scheduled";
	const watchAvailable =
		channel !== null && start.getTime() <= now.getTime() && now < stop;

	return (
		<Modal open={open} onOpenChange={onOpenChange}>
			<ModalContent>
				<ModalHeader>
					<ModalTitle>{program.title}</ModalTitle>
					<ModalDescription>
						{channel ? `${channel.number} · ${channel.name} · ` : ""}
						{formatDateLabel(start)} · {formatTimeLabel(start, use24Hour)} –{" "}
						{isSameLocalDay(start, stop)
							? formatTimeLabel(stop, use24Hour)
							: `${formatDateLabel(stop)} · ${formatTimeLabel(stop, use24Hour)}`}
					</ModalDescription>
				</ModalHeader>

				<div className="space-y-3 px-1 text-sm text-secondary">
					{program.subtitle ? (
						<p className="text-primary">{program.subtitle}</p>
					) : null}
					{detailsStatus === "loading" ? (
						<div className="flex items-center gap-2" role="status">
							<Spinner aria-hidden="true" className="h-4 w-4" />
							<span>Loading program details…</span>
						</div>
					) : detailsStatus === "error" ? (
						<div className="flex flex-wrap items-center gap-2" role="alert">
							<span>Program details couldn&apos;t be loaded.</span>
							{onRetryDetails ? (
								<Button size="sm" variant="outline" onClick={onRetryDetails}>
									Retry
								</Button>
							) : null}
						</div>
					) : null}
					{details?.description ? <p>{details.description}</p> : null}
					{details && details.categories.length > 0 ? (
						<div className="flex flex-wrap gap-1">
							{details.categories.map((c) => (
								<Badge key={c} variant="outline">
									{c}
								</Badge>
							))}
						</div>
					) : null}
					<RecordingStatusBadge status={program.recordingStatus} />
					{recordingError ? (
						<p role="alert" className="text-danger">
							{recordingError}
						</p>
					) : null}
				</div>

				<ModalFooter className="flex-wrap gap-2">
					{watchAvailable ? (
						<Button onClick={() => onWatch(program)}>
							<Play aria-hidden="true" className="h-4 w-4" />
							Watch
						</Button>
					) : null}
					{recording ? (
						<Button
							variant="danger"
							disabled={recordingPending || !program.recordingId}
							onClick={() => void onCancel(program).catch(() => undefined)}
						>
							{recordingPending ? (
								<Spinner aria-hidden="true" className="h-4 w-4" />
							) : (
								<XCircle aria-hidden="true" className="h-4 w-4" />
							)}
							{recordingPending ? "Cancelling…" : "Cancel recording"}
						</Button>
					) : (
						<Button
							variant="outline"
							disabled={recordingPending}
							onClick={() => onRecord(program)}
						>
							{recordingPending ? (
								<Spinner aria-hidden="true" className="h-4 w-4" />
							) : (
								<CircleDot aria-hidden="true" className="h-4 w-4" />
							)}
							{recordingPending ? "Scheduling…" : "Record"}
						</Button>
					)}
					<Button variant="outline" onClick={() => onRecordSeries(program)}>
						<Repeat aria-hidden="true" className="h-4 w-4" />
						Record series
					</Button>
					{program.recordingStatus === "recording" ? (
						<span
							aria-hidden="true"
							className="ml-auto inline-flex items-center gap-1 text-xs text-red-500"
						>
							<Disc3 className="h-3 w-3 animate-pulse motion-reduce:animate-none" />
							Live
						</span>
					) : null}
				</ModalFooter>
			</ModalContent>
		</Modal>
	);
}
