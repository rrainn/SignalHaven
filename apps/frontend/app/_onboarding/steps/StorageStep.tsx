"use client";

import { FolderOpen } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import { ApiError, updateSettings } from "../../../lib/api-client";
import { Button } from "../../_ui/Button";
import { Input } from "../../_ui/Input";
import { Spinner } from "../../_ui/Spinner";

const DEFAULT_RECORDINGS_PATH = "/var/lib/signalhaven/recordings";

export type StorageStepProps = {
	/** Current storage path; empty means not yet configured. */
	currentPath: string | null;
	onPathSaved: (path: string) => void;
	onNext: () => void;
	onBack: () => void;
	onSkip: () => void;
};

/**
 * Choose a recordings folder. The container path is prefilled because a
 * placeholder is not submitted and made the working default look invalid.
 */
export function StorageStep(props: StorageStepProps) {
	const { currentPath, onPathSaved, onNext, onBack, onSkip } = props;

	const [path, setPath] = useState(currentPath ?? DEFAULT_RECORDINGS_PATH);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			const trimmed = path.trim();
			if (!trimmed) {
				setError("Folder path is required");
				return;
			}
			setSubmitting(true);
			try {
				const updated = await updateSettings({
					storage: { path: trimmed, quotaGb: null }
				});
				onPathSaved(updated.storage.path ?? trimmed);
				onNext();
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
		[onNext, onPathSaved, path]
	);

	return (
		<div className="space-y-4">
			<p id="recordings-folder-help" className="text-sm text-secondary">
				Recording requires a writable folder. The standard container path is
				ready below; change it only if your recordings volume is mounted
				elsewhere. You can update this later in Settings.
			</p>

			<form
				onSubmit={onSubmit}
				aria-label="Choose recordings folder"
				className="space-y-3 rounded-lg border border-border bg-surface p-4"
			>
				<label htmlFor="recordings-folder" className="block space-y-1 text-sm">
					<span className="text-primary">Recordings folder</span>
					<div className="flex items-center gap-2">
						<FolderOpen aria-hidden="true" className="h-4 w-4 text-muted" />
						<Input
							id="recordings-folder"
							value={path}
							onChange={(e) => setPath(e.target.value)}
							aria-describedby="recordings-folder-help"
							className="flex-1"
						/>
					</div>
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
						{submitting ? "Saving…" : "Save and continue"}
					</Button>
				</div>
			</form>

			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<Button variant="ghost" onClick={onSkip}>
					Set up later
				</Button>
			</div>
		</div>
	);
}
