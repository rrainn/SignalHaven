"use client";

import {
	recordingsSettingsSchema,
	storageSettingsSchema,
	type Settings
} from "@signalhaven/shared";
import { FolderOpen } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import { updateSettings } from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { Input } from "../_ui/Input";
import { Spinner } from "../_ui/Spinner";
import { Switch } from "../_ui/Switch";

import { formatErrorMessage, formatIssue } from "./form-helpers";

export type StorageSectionProps = {
	settings: Settings;
	onChanged: (next: Settings) => void;
};

/**
 * Settings section for the recordings library storage location, the
 * library quota, and DVR recording padding
 * (rrainn/SignalHaven#U11-settings).
 *
 * Validates against the shared settings schemas so invalid storage or
 * padding values never reach the PATCH endpoint. Failed saves leave the
 * parent-owned settings unchanged while keeping attempted values available
 * for correction and retry.
 */
export function StorageSection(props: StorageSectionProps) {
	const { settings, onChanged } = props;

	const [path, setPath] = useState(settings.storage.path ?? "");
	const [quota, setQuota] = useState(
		settings.storage.quotaGb !== null ? String(settings.storage.quotaGb) : ""
	);
	const [paddingBeforeSec, setPaddingBeforeSec] = useState(
		String(settings.recordings.paddingBeforeSec)
	);
	const [paddingAfterSec, setPaddingAfterSec] = useState(
		String(settings.recordings.paddingAfterSec)
	);
	const [commercialDetectionEnabled, setCommercialDetectionEnabled] = useState(
		settings.recordings.commercialDetection?.enabled ?? false
	);
	const [detectorPath, setDetectorPath] = useState(
		settings.recordings.commercialDetection?.detectorPath ?? ""
	);
	const [detectorVersion, setDetectorVersion] = useState(
		settings.recordings.commercialDetection?.detectorVersion ?? "comskip-edl-v1"
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			setSavedAt(null);

			const trimmedPath = path.trim();
			const trimmedQuota = quota.trim();

			if (trimmedPath.length === 0) {
				setError("Recordings folder is required");
				return;
			}

			const storageCandidate = {
				path: trimmedPath,
				quotaGb: trimmedQuota.length > 0 ? Number(trimmedQuota) : null
			};
			const parsedStorage = storageSettingsSchema.safeParse(storageCandidate);
			if (!parsedStorage.success) {
				const first = parsedStorage.error.issues[0];
				setError(first ? formatIssue(first) : "Invalid storage settings");
				return;
			}

			const trimmedBefore = paddingBeforeSec.trim();
			const trimmedAfter = paddingAfterSec.trim();
			// NaN lets the shared schema produce a field-specific error for blanks.
			const paddingCandidate = {
				paddingBeforeSec:
					trimmedBefore.length > 0 ? Number(trimmedBefore) : Number.NaN,
				paddingAfterSec:
					trimmedAfter.length > 0 ? Number(trimmedAfter) : Number.NaN,
				...(settings.recordings.commercialDetection ||
				commercialDetectionEnabled ||
				detectorPath.trim()
					? {
							commercialDetection: {
								enabled: commercialDetectionEnabled,
								detectorPath: detectorPath.trim() || null,
								detectorVersion: detectorVersion.trim() || "comskip-edl-v1"
							}
						}
					: {})
			};
			if (commercialDetectionEnabled && !detectorPath.trim()) {
				setError(
					"Comskip executable path is required when detection is enabled"
				);
				return;
			}
			const parsedPadding =
				recordingsSettingsSchema.safeParse(paddingCandidate);
			if (!parsedPadding.success) {
				const first = parsedPadding.error.issues[0];
				setError(first ? formatIssue(first) : "Invalid recording padding");
				return;
			}

			setSubmitting(true);
			try {
				const next = await updateSettings({
					storage: parsedStorage.data,
					recordings: parsedPadding.data
				});
				// Reflect any server normalization instead of assuming the request won.
				setPath(next.storage.path ?? "");
				setQuota(
					next.storage.quotaGb !== null ? String(next.storage.quotaGb) : ""
				);
				setPaddingBeforeSec(String(next.recordings.paddingBeforeSec));
				setPaddingAfterSec(String(next.recordings.paddingAfterSec));
				setCommercialDetectionEnabled(
					next.recordings.commercialDetection?.enabled ?? false
				);
				setDetectorPath(
					next.recordings.commercialDetection?.detectorPath ?? ""
				);
				setDetectorVersion(
					next.recordings.commercialDetection?.detectorVersion ??
						"comskip-edl-v1"
				);
				onChanged(next);
				setSavedAt(new Date().toISOString());
			} catch (err) {
				setError(formatErrorMessage(err, "Could not save DVR settings"));
			} finally {
				setSubmitting(false);
			}
		},
		[
			commercialDetectionEnabled,
			detectorPath,
			detectorVersion,
			onChanged,
			path,
			quota,
			paddingAfterSec,
			paddingBeforeSec,
			settings.recordings.commercialDetection
		]
	);

	return (
		<form
			noValidate
			onSubmit={onSubmit}
			aria-label="Storage settings"
			className="space-y-4 rounded-lg border border-border bg-surface p-4"
		>
			<label className="block space-y-1 text-sm">
				<span className="text-primary">Recordings folder</span>
				<div className="flex items-center gap-2">
					<FolderOpen aria-hidden="true" className="h-4 w-4 text-muted" />
					<Input
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/var/lib/signalhaven/recordings"
						className="flex-1"
						required
					/>
				</div>
			</label>

			<label className="block space-y-1 text-sm">
				<span className="text-primary">
					Quota (GB) <span className="text-muted">— blank for unlimited</span>
				</span>
				<Input
					type="number"
					min={1}
					value={quota}
					onChange={(e) => setQuota(e.target.value)}
					placeholder="e.g. 500"
				/>
			</label>

			<fieldset className="space-y-3">
				<legend className="text-sm font-medium text-primary">
					Recording padding
				</legend>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<label className="block space-y-1 text-sm">
						<span className="text-primary">Pre-record padding (seconds)</span>
						<Input
							type="number"
							inputMode="numeric"
							min={0}
							max={3600}
							step={1}
							value={paddingBeforeSec}
							onChange={(e) => setPaddingBeforeSec(e.target.value)}
						/>
					</label>

					<label className="block space-y-1 text-sm">
						<span className="text-primary">Post-record padding (seconds)</span>
						<Input
							type="number"
							inputMode="numeric"
							min={0}
							max={3600}
							step={1}
							value={paddingAfterSec}
							onChange={(e) => setPaddingAfterSec(e.target.value)}
						/>
					</label>
				</div>
				<p className="text-xs text-secondary">
					Pre-padding applies when a job is newly created or rescheduled.
					Post-padding is read when capture starts. A recording already in
					progress keeps its current cutoff.
				</p>
			</fieldset>

			<fieldset className="space-y-3">
				<legend className="text-sm font-medium text-primary">
					Commercial detection
				</legend>
				<label className="flex items-center justify-between gap-3 text-sm">
					<span>
						<span className="block text-primary">
							Analyze completed recordings
						</span>
						<span className="block text-xs text-secondary">
							Runs one low-priority Comskip process at a time.
						</span>
					</span>
					<Switch
						checked={commercialDetectionEnabled}
						onCheckedChange={setCommercialDetectionEnabled}
						aria-label="Enable commercial detection"
					/>
				</label>
				<label className="block space-y-1 text-sm">
					<span className="text-primary">Comskip executable path</span>
					<Input
						value={detectorPath}
						onChange={(event) => setDetectorPath(event.target.value)}
						placeholder="/usr/local/bin/comskip"
					/>
				</label>
				<label className="block space-y-1 text-sm">
					<span className="text-primary">Detector configuration version</span>
					<Input
						value={detectorVersion}
						onChange={(event) => setDetectorVersion(event.target.value)}
						maxLength={100}
					/>
					<span className="block text-xs text-secondary">
						Change this after updating Comskip or its configuration to
						regenerate markers.
					</span>
				</label>
			</fieldset>

			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{savedAt && !error ? (
				<p role="status" className="text-sm text-success">
					Saved.
				</p>
			) : null}

			<div className="flex justify-end">
				<Button type="submit" disabled={submitting}>
					{submitting ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : null}
					{submitting ? "Saving…" : "Save"}
				</Button>
			</div>
		</form>
	);
}
