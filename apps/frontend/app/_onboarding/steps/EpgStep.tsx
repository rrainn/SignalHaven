"use client";

import type { EpgSource } from "@signalhaven/shared";
import { CalendarRange } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import { ApiError, createEpgSource } from "../../../lib/api-client";
import { Badge } from "../../_ui/Badge";
import { Button } from "../../_ui/Button";
import { EmptyState } from "../../_ui/EmptyState";
import { Input } from "../../_ui/Input";
import { Spinner } from "../../_ui/Spinner";

export type EpgStepProps = {
	existingSources: EpgSource[];
	onSourceCreated: (source: EpgSource) => void;
	onNext: () => void;
	onBack: () => void;
	onSkip: () => void;
};

/**
 * Add an XMLTV guide source. We deliberately keep the form minimal — name +
 * URL — so the wizard stays a quick win. Power-user options (timezone,
 * refresh interval, file paths) live in the full Settings UI.
 */
export function EpgStep(props: EpgStepProps) {
	const { existingSources, onSourceCreated, onNext, onBack, onSkip } = props;
	const hasManagedGuide = existingSources.some(
		(source) => source.kind === "hdhomerun_guide"
	);

	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			const trimmedName = name.trim();
			const trimmedUrl = url.trim();
			if (!trimmedName || !trimmedUrl) {
				setError("Both fields are required");
				return;
			}
			setSubmitting(true);
			try {
				const created = await createEpgSource({
					name: trimmedName,
					kind: "xmltv",
					url: trimmedUrl,
					refreshIntervalMinutes: 720,
					enabled: true
				});
				onSourceCreated(created);
				setName("");
				setUrl("");
			} catch (err) {
				if (err instanceof ApiError) {
					setError(err.message);
				} else {
					setError(err instanceof Error ? err.message : "Could not save");
				}
			} finally {
				setSubmitting(false);
			}
		},
		[name, onSourceCreated, url]
	);

	return (
		<div className="space-y-4">
			<p className="text-sm text-secondary">
				{hasManagedGuide
					? "Your HDHomeRun guide is managed automatically. You can optionally add an XMLTV source for other tuners."
					: "Guide data tells SignalHaven what’s playing on each channel. Add an XMLTV URL from your playlist or guide provider."}
			</p>

			{existingSources.length === 0 ? (
				<EmptyState
					icon={<CalendarRange aria-hidden="true" />}
					title="No guide sources yet"
					description="Add an XMLTV source to populate the channel grid. HDHomeRun guides appear automatically after adding the tuner."
				/>
			) : (
				<ul aria-label="Guide sources" className="space-y-1 text-sm">
					{existingSources.map((source) => (
						<li
							key={source.id}
							className="flex items-center gap-2 text-secondary"
						>
							<Badge variant="outline">{source.kind.toUpperCase()}</Badge>
							<span>{source.name}</span>
						</li>
					))}
				</ul>
			)}

			<form
				onSubmit={onSubmit}
				aria-label="Add guide source"
				className="space-y-3 rounded-lg border border-border bg-surface p-4"
			>
				<label className="block space-y-1 text-sm">
					<span className="text-primary">Name</span>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="My XMLTV guide"
					/>
				</label>
				<label className="block space-y-1 text-sm">
					<span className="text-primary">XMLTV URL</span>
					<Input
						type="url"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="https://example.com/guide.xml"
					/>
				</label>
				{error ? (
					<p role="alert" className="text-sm text-danger">
						{error}
					</p>
				) : null}
				<div className="flex justify-end">
					<Button type="submit" disabled={submitting}>
						{submitting ? (
							<Spinner aria-hidden="true" className="h-4 w-4" />
						) : null}
						{submitting ? "Saving…" : "Add guide source"}
					</Button>
				</div>
			</form>

			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<div className="flex flex-col-reverse gap-2 sm:flex-row">
					<Button variant="ghost" onClick={onSkip}>
						Skip
					</Button>
					<Button onClick={onNext}>Continue</Button>
				</div>
			</div>
		</div>
	);
}
