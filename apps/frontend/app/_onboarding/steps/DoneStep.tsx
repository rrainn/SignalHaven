"use client";

import { CheckCircle2 } from "lucide-react";

import { Button } from "../../_ui/Button";
import { Spinner } from "../../_ui/Spinner";

export type DoneStepProps = {
	/** Keeps users in setup until channel matching and guide import finish. */
	preparing: boolean;
	onFinish: () => void;
};

export function DoneStep({ preparing, onFinish }: DoneStepProps) {
	return (
		<div className="space-y-4">
			<div className="flex flex-col items-center gap-3 text-center">
				<div
					aria-hidden="true"
					className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success"
				>
					<CheckCircle2 className="h-7 w-7" />
				</div>
				<p className="max-w-prose text-sm text-secondary">
					{preparing
						? "SignalHaven is importing channels and schedule data so your guide is ready when setup closes."
						: "SignalHaven is ready to go. You can return to any of these settings at any time from the Settings page."}
				</p>
			</div>
			<div className="flex justify-center">
				<Button onClick={onFinish} disabled={preparing}>
					{preparing ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : null}
					{preparing ? "Preparing guide…" : "Open SignalHaven"}
				</Button>
			</div>
		</div>
	);
}
