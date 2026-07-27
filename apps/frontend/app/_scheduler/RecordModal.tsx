"use client";

import { CircleDot, Repeat } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../_ui/Button";
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
import { formatTimePreference } from "../_preferences/formatting";

export type RecordModalMode = "one-off" | "series";

/** The minimum program shape the {@link RecordModal} needs to render. */
export type RecordableProgram = {
	id: string;
	title: string;
	channelId: string;
	start: string;
	stop: string;
	subtitle?: string | null | undefined;
};

export interface RecordModalProps {
	/** The program the user wants to record. `null` keeps the modal closed. */
	program: RecordableProgram | null;
	/** Optional human-readable channel label rendered in the description. */
	channelLabel?: string | null | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Schedule a one-off recording for `program`. */
	onRecord: (program: RecordableProgram) => Promise<void>;
	/** Create a series rule scoped to `program.title` + `program.channelId`. */
	onRecordSeries: (program: RecordableProgram) => Promise<void>;
	/** Whether the user prefers a 24-hour clock; defaults to false. */
	use24Hour?: boolean | undefined;
}

/**
 * Shared "Record" modal (rrainn/SignalHaven#U9-scheduler).
 *
 * Reusable from the program-details modal in U4 (Guide) and from any
 * other surface that wants to schedule a recording. Renders the two
 * actions called out in the U9 acceptance criteria — "Record" (one-off)
 * and "Record series" (season pass) — and surfaces inline error /
 * success state so consumers don't have to duplicate the toast wiring.
 */
export function RecordModal(props: RecordModalProps) {
	const { program, open, onOpenChange, onRecord, onRecordSeries } = props;
	const use24Hour = use24HourClock(props.use24Hour);

	const [submitting, setSubmitting] = useState<RecordModalMode | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<RecordModalMode | null>(null);
	const submittingRef = useRef(false);

	// Reset state when the modal is reopened or aimed at a new program.
	useEffect(() => {
		if (!open) {
			submittingRef.current = false;
			setSubmitting(null);
			setError(null);
			setDone(null);
		}
	}, [open, program?.id]);

	const handle = async (mode: RecordModalMode) => {
		// React state updates after the click returns, so the ref closes the small
		// window where two rapid interactions could invoke the handler twice.
		if (!program || submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(mode);
		setError(null);
		try {
			if (mode === "one-off") await onRecord(program);
			else await onRecordSeries(program);
			setDone(mode);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to schedule");
		} finally {
			submittingRef.current = false;
			setSubmitting(null);
		}
	};

	if (!program) {
		return <Modal open={open} onOpenChange={onOpenChange} />;
	}

	const start = new Date(program.start);
	const stop = new Date(program.stop);

	return (
		<Modal open={open} onOpenChange={onOpenChange}>
			<ModalContent data-testid="record-modal">
				<ModalHeader>
					<ModalTitle>{program.title}</ModalTitle>
					<ModalDescription>
						{props.channelLabel ? `${props.channelLabel} · ` : ""}
						{formatTimePreference(start, use24Hour)} –{" "}
						{formatTimePreference(stop, use24Hour)}
					</ModalDescription>
				</ModalHeader>

				{program.subtitle ? (
					<p className="px-1 text-sm text-secondary">{program.subtitle}</p>
				) : null}

				{done === "one-off" ? (
					<p
						role="status"
						data-testid="record-modal-success"
						className="px-1 text-sm text-success"
					>
						Recording scheduled.
					</p>
				) : done === "series" ? (
					<p
						role="status"
						data-testid="record-modal-success"
						className="px-1 text-sm text-success"
					>
						Series rule created.
					</p>
				) : null}

				{error ? (
					<p
						role="alert"
						data-testid="record-modal-error"
						className="px-1 text-sm text-danger"
					>
						{error}
					</p>
				) : null}

				<ModalFooter className="flex-wrap gap-2">
					<Button
						data-testid="record-modal-record"
						disabled={submitting !== null || done !== null}
						onClick={() => void handle("one-off")}
					>
						{submitting === "one-off" ? (
							<Spinner aria-hidden="true" className="h-4 w-4" />
						) : (
							<CircleDot aria-hidden="true" className="h-4 w-4" />
						)}
						Record
					</Button>
					<Button
						variant="outline"
						data-testid="record-modal-record-series"
						disabled={submitting !== null || done !== null}
						onClick={() => void handle("series")}
					>
						{submitting === "series" ? (
							<Spinner aria-hidden="true" className="h-4 w-4" />
						) : (
							<Repeat aria-hidden="true" className="h-4 w-4" />
						)}
						Record series
					</Button>
					<Button
						variant="ghost"
						className="ml-auto"
						onClick={() => onOpenChange(false)}
					>
						{done ? "Close" : "Cancel"}
					</Button>
				</ModalFooter>
			</ModalContent>
		</Modal>
	);
}
