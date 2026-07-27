"use client";

import { Tv } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../_ui/Button";

export type WelcomeStepProps = {
	onNext: () => void;
	onSkip: () => void;
	footer?: ReactNode;
};

export function WelcomeStep({ onNext, onSkip, footer }: WelcomeStepProps) {
	return (
		<div className="space-y-4">
			<div className="flex flex-col items-center gap-3 text-center">
				<div
					aria-hidden="true"
					className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent"
				>
					<Tv className="h-7 w-7" />
				</div>
				<p className="max-w-prose text-sm text-secondary">
					Let&rsquo;s get SignalHaven ready in a few quick steps: detect your
					tuners, review guide data, and choose where recordings live. HDHomeRun
					guides are configured automatically.
				</p>
			</div>
			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				<Button variant="ghost" onClick={onSkip}>
					Skip setup
				</Button>
				<Button onClick={onNext}>Get started</Button>
			</div>
			{footer}
		</div>
	);
}
