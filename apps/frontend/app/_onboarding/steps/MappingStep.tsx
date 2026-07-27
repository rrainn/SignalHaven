"use client";

import { Sparkles } from "lucide-react";

import { Button } from "../../_ui/Button";

export type MappingStepProps = {
	onNext: () => void;
	onBack: () => void;
	onSkip: () => void;
};

/**
 * Channel mapping review.
 *
 * The actual matching is automatic on the backend (tvg-id, exact name,
 * normalized name, channel-number prefix; see `epg-candidates`). Surfacing
 * the per-channel review UI is too dense for the wizard, so we keep this
 * step short with a deep link to the Channels page where users can adjust
 * mappings later.
 */
export function MappingStep({ onNext, onBack, onSkip }: MappingStepProps) {
	return (
		<div className="space-y-4">
			<div className="rounded-lg border border-border bg-surface p-4">
				<div className="flex items-start gap-3">
					<Sparkles
						aria-hidden="true"
						className="mt-0.5 h-5 w-5 flex-shrink-0 text-accent"
					/>
					<div className="space-y-1 text-sm">
						<p className="font-medium text-primary">
							Channel mapping runs automatically
						</p>
						<p className="text-secondary">
							SignalHaven pairs each tuner channel with guide data using
							<code className="mx-1 rounded bg-surface-muted px-1 text-xs">
								tvg-id
							</code>
							when present, falling back to display name and channel-number
							heuristics.
						</p>
						<p className="text-secondary">
							Visit{" "}
							<a
								href="/channels"
								className="text-accent underline-offset-4 hover:underline"
							>
								Channels
							</a>{" "}
							to review and override the automatic mapping when guide data looks
							off — your overrides are remembered through guide refreshes.
						</p>
					</div>
				</div>
			</div>

			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<div className="flex flex-col-reverse gap-2 sm:flex-row">
					<Button variant="ghost" onClick={onSkip}>
						Skip
					</Button>
					<Button onClick={onNext}>Looks good</Button>
				</div>
			</div>
		</div>
	);
}
