"use client";

import type { EpgProgramDetails } from "@signalhaven/shared";
import { CalendarX2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { getEpgProgram } from "../../lib/api-client";
import { use24HourClock } from "../_preferences/PreferencesProvider";
import { useProgramRecordingActions } from "../_recordings/useProgramRecordingActions";
import { Button } from "../_ui/Button";
import { EmptyState } from "../_ui/EmptyState";
import { Spinner } from "../_ui/Spinner";
import { safeGuideReturnPath } from "./guide-return-path";
import { ProgramDetailsModal } from "./ProgramDetailsModal";

export interface ProgramDetailsPageProps {
	programId: string;
	returnTo?: string | undefined;
	/** Test seam for a preloaded details response. */
	initialDetails?: EpgProgramDetails | undefined;
	/** Test seam for program loading and deleted-program recovery. */
	loadProgram?: (() => Promise<EpgProgramDetails>) | undefined;
}

/**
 * Route-backed program details used by global search. Recording mutations share
 * the Guide's optimistic action hook and reconcile against the API response.
 */
export function ProgramDetailsPage(props: ProgramDetailsPageProps) {
	const router = useRouter();
	const use24Hour = use24HourClock();
	const returnTo = safeGuideReturnPath(props.returnTo);
	const [details, setDetails] = useState<EpgProgramDetails | null>(
		props.initialDetails ?? null
	);
	const [status, setStatus] = useState<"loading" | "ready" | "error">(
		props.initialDetails ? "ready" : "loading"
	);

	useEffect(() => {
		if (props.initialDetails) return;
		let cancelled = false;
		const load = props.loadProgram ?? (() => getEpgProgram(props.programId));
		void load()
			.then((result) => {
				if (cancelled) return;
				setDetails(result);
				setStatus("ready");
			})
			.catch(() => {
				if (!cancelled) setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [props.initialDetails, props.loadProgram, props.programId]);

	const updateProgram = useCallback(
		(
			programId: string,
			patch: Pick<
				EpgProgramDetails["program"],
				"recordingId" | "recordingStatus"
			>
		) => {
			setDetails((current) =>
				current && current.program.id === programId
					? { ...current, program: { ...current.program, ...patch } }
					: current
			);
		},
		[]
	);
	const actions = useProgramRecordingActions({
		onProgramChange: updateProgram
	});

	if (status === "loading") {
		return (
			<div className="flex min-h-64 items-center justify-center">
				<Spinner aria-label="Loading program details" />
			</div>
		);
	}

	if (status === "error" || !details) {
		return (
			<EmptyState
				icon={<CalendarX2 />}
				title="Program not found"
				description="This program may have been removed during a guide refresh. Return to the Guide to find current listings."
				action={
					<Button onClick={() => router.push(returnTo)}>Back to Guide</Button>
				}
			/>
		);
	}

	const pendingAction = actions.pending.get(details.program.id);
	const recordingError =
		actions.error?.programId === details.program.id
			? actions.error.message
			: null;

	return (
		<ProgramDetailsModal
			open
			program={details.program}
			details={details.program}
			channel={details.channel}
			use24Hour={use24Hour}
			onOpenChange={(open) => {
				if (!open) router.push(returnTo);
			}}
			onWatch={() =>
				router.push(`/watch/${encodeURIComponent(details.channel.id)}`)
			}
			onRecord={(program) => {
				void actions.schedule(program).catch(() => undefined);
			}}
			onRecordSeries={(program) => {
				void actions.recordSeries(program).catch(() => undefined);
			}}
			onCancel={actions.cancel}
			recordingPending={pendingAction !== undefined}
			recordingError={recordingError}
		/>
	);
}
