"use client";

import type { RecordingStatus } from "@signalhaven/shared";

import { Badge } from "../_ui/Badge";

const STATUS_PRESENTATION: Record<
	RecordingStatus,
	{
		label: string;
		variant: "default" | "accent" | "success" | "danger" | "outline";
	}
> = {
	scheduled: { label: "Scheduled", variant: "outline" },
	recording: { label: "Recording", variant: "accent" },
	completed: { label: "Completed", variant: "success" },
	failed: { label: "Failed", variant: "danger" },
	cancelled: { label: "Cancelled", variant: "default" }
};

export interface RecordingStatusBadgeProps {
	status: RecordingStatus | null;
	className?: string | undefined;
}

/** Renders one consistent label and color for a program recording state. */
export function RecordingStatusBadge(props: RecordingStatusBadgeProps) {
	if (!props.status) return null;
	const presentation = STATUS_PRESENTATION[props.status];
	return (
		<Badge variant={presentation.variant} className={props.className}>
			{presentation.label}
		</Badge>
	);
}
