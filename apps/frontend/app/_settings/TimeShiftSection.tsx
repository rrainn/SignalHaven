"use client";

import { timeShiftSettingsSchema, type Settings } from "@signalhaven/shared";
import { useCallback, useState, type FormEvent } from "react";

import { updateSettings } from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { Input } from "../_ui/Input";
import { Spinner } from "../_ui/Spinner";
import { Switch } from "../_ui/Switch";

import { formatErrorMessage, formatIssue } from "./form-helpers";

export interface TimeShiftSectionProps {
	settings: Settings;
	onChanged: (next: Settings) => void;
}

/** Configures the disposable rolling buffer used by live television. */
export function TimeShiftSection(props: TimeShiftSectionProps) {
	const { settings, onChanged } = props;
	const configured = settings.timeShift;
	const [enabled, setEnabled] = useState(configured.enabled);
	const [bufferPath, setBufferPath] = useState(configured.bufferPath ?? "");
	const [durationMinutes, setDurationMinutes] = useState(
		String(configured.durationMinutes)
	);
	const [maxDiskGb, setMaxDiskGb] = useState(String(configured.maxDiskGb));
	const [idleGraceSeconds, setIdleGraceSeconds] = useState(
		String(configured.idleGraceSeconds)
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			setSaved(false);
			const parsed = timeShiftSettingsSchema.safeParse({
				enabled,
				bufferPath: bufferPath.trim() || null,
				durationMinutes: Number(durationMinutes),
				maxDiskGb: Number(maxDiskGb),
				idleGraceSeconds: Number(idleGraceSeconds)
			});
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				setError(first ? formatIssue(first) : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				const next = await updateSettings({ timeShift: parsed.data });
				onChanged(next);
				setSaved(true);
			} catch (cause) {
				setError(formatErrorMessage(cause, "Could not save"));
			} finally {
				setSubmitting(false);
			}
		},
		[
			bufferPath,
			durationMinutes,
			enabled,
			idleGraceSeconds,
			maxDiskGb,
			onChanged
		]
	);

	return (
		<form
			noValidate
			onSubmit={onSubmit}
			aria-label="Live TV buffer settings"
			className="space-y-4"
		>
			<Card>
				<CardHeader>
					<CardTitle>Live TV buffer</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<label className="flex items-center justify-between gap-2 text-sm">
						<span className="text-primary">Enable pause and rewind</span>
						<Switch
							checked={enabled}
							onCheckedChange={setEnabled}
							aria-label="Enable live TV buffer"
						/>
					</label>

					<div className="grid gap-3 sm:grid-cols-3">
						<label className="space-y-1 text-sm">
							<span className="text-primary">Window (minutes)</span>
							<Input
								type="number"
								min={1}
								max={240}
								disabled={!enabled}
								value={durationMinutes}
								onChange={(event) => setDurationMinutes(event.target.value)}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="text-primary">Maximum disk (GB)</span>
							<Input
								type="number"
								min={0.1}
								step={0.1}
								disabled={!enabled}
								value={maxDiskGb}
								onChange={(event) => setMaxDiskGb(event.target.value)}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="text-primary">Idle grace (seconds)</span>
							<Input
								type="number"
								min={0}
								max={3600}
								disabled={!enabled}
								value={idleGraceSeconds}
								onChange={(event) => setIdleGraceSeconds(event.target.value)}
							/>
						</label>
					</div>

					<label className="block space-y-1 text-sm">
						<span className="text-primary">Buffer directory</span>
						<Input
							disabled={!enabled}
							value={bufferPath}
							placeholder="Operating-system temporary directory"
							onChange={(event) => setBufferPath(event.target.value)}
						/>
						<span className="block text-xs text-muted">
							Time-shift files are disposable and never appear in Recordings.
						</span>
					</label>

					{error ? (
						<p role="alert" className="text-sm text-danger">
							{error}
						</p>
					) : null}
					{saved ? (
						<p role="status" className="text-sm text-success">
							Saved. New live sessions will use this policy.
						</p>
					) : null}

					<Button type="submit" disabled={submitting}>
						{submitting ? (
							<Spinner aria-hidden="true" className="h-4 w-4" />
						) : null}
						Save live TV buffer
					</Button>
				</CardContent>
			</Card>
		</form>
	);
}
