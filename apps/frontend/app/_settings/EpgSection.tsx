"use client";

import {
	epgSourceCreateSchema,
	type EpgSource,
	type EventMessage
} from "@signalhaven/shared";
import { CalendarRange, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import {
	createEpgSource,
	deleteEpgSource,
	refreshEpgSource,
	updateEpgSource
} from "../../lib/api-client";
import { useWebSocketEvents } from "../../lib/ws-client";
import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
import { Input } from "../_ui/Input";
import { Spinner } from "../_ui/Spinner";
import { Switch } from "../_ui/Switch";

import { formatErrorMessage, formatIssue } from "./form-helpers";

export type EpgSectionProps = {
	sources: EpgSource[];
	onChanged: () => Promise<void> | void;
};

/**
 * Settings section for managing EPG sources (rrainn/SignalHaven#U11-settings).
 *
 * Renders existing sources with last-refresh metadata and offers add /
 * edit / remove / force-refresh actions. Subscribes to the `epg` WS topic
 * so an external refresh (or one initiated from a different tab)
 * surfaces here without needing a manual reload.
 */
export function EpgSection(props: EpgSectionProps) {
	const { sources, onChanged } = props;
	const [showAdd, setShowAdd] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [errorById, setErrorById] = useState<Record<string, string>>({});

	// Refresh-progress events come back as `epg.refresh` on the `epg` topic.
	// We just trigger a list refetch so the UI shows the latest counts.
	useWebSocketEvents({
		topics: ["epg"],
		enabled: true,
		onEvent: useCallback(
			(event: EventMessage) => {
				if (
					event.event === "epg.refresh" ||
					event.event === "source.created" ||
					event.event === "source.updated" ||
					event.event === "source.deleted"
				) {
					void onChanged();
				}
			},
			[onChanged]
		)
	});

	const handleRefresh = useCallback(
		async (source: EpgSource) => {
			setBusyId(source.id);
			try {
				await refreshEpgSource(source.id);
				await onChanged();
				setErrorById((prev) => omitKey(prev, source.id));
			} catch (err) {
				setErrorById((prev) => ({
					...prev,
					[source.id]: formatErrorMessage(err, "Refresh failed")
				}));
			} finally {
				setBusyId((curr) => (curr === source.id ? null : curr));
			}
		},
		[onChanged]
	);

	const handleDelete = useCallback(
		async (source: EpgSource) => {
			setBusyId(source.id);
			try {
				await deleteEpgSource(source.id);
				await onChanged();
			} catch (err) {
				setErrorById((prev) => ({
					...prev,
					[source.id]: formatErrorMessage(err, "Delete failed")
				}));
			} finally {
				setBusyId((curr) => (curr === source.id ? null : curr));
			}
		},
		[onChanged]
	);

	const handleToggleEnabled = useCallback(
		async (source: EpgSource, enabled: boolean) => {
			setBusyId(source.id);
			try {
				await updateEpgSource(source.id, { enabled });
				await onChanged();
				setErrorById((prev) => omitKey(prev, source.id));
			} catch (err) {
				setErrorById((prev) => ({
					...prev,
					[source.id]: formatErrorMessage(err, "Update failed")
				}));
			} finally {
				setBusyId((curr) => (curr === source.id ? null : curr));
			}
		},
		[onChanged]
	);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<Button onClick={() => setShowAdd((v) => !v)} variant="outline">
					<Plus aria-hidden="true" className="h-4 w-4" />
					{showAdd ? "Hide add form" : "Add EPG source"}
				</Button>
				<p className="text-xs text-muted">
					HDHomeRun guides are added and authenticated automatically with their
					tuner.
				</p>
			</div>

			{showAdd ? (
				<AddEpgSourceForm
					onCreated={async () => {
						setShowAdd(false);
						await onChanged();
					}}
				/>
			) : null}

			{sources.length === 0 ? (
				<EmptyState
					icon={<CalendarRange aria-hidden="true" />}
					title="No EPG sources configured"
					description="Add at least one XMLTV URL or HDHomeRun guide so SignalHaven can populate program data."
				/>
			) : (
				<ul aria-label="EPG sources" className="space-y-2">
					{sources.map((source) => (
						<li key={source.id}>
							<Card>
								<CardContent className="flex flex-wrap items-center gap-3 pt-4 sm:pt-6">
									<div className="flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<p className="font-medium text-primary">{source.name}</p>
											<Badge variant="outline">
												{source.kind === "hdhomerun_guide"
													? "HDHOMERUN"
													: "XMLTV"}
											</Badge>
											<LastRefreshBadge source={source} />
										</div>
										{source.kind === "hdhomerun_guide" ? (
											<p className="text-xs text-secondary">
												Managed automatically from the tuner
											</p>
										) : (
											<p className="text-xs text-secondary">
												{source.url ?? source.filePath ?? ""}
											</p>
										)}
										<p className="mt-1 text-xs text-muted">
											Refresh interval: {source.refreshIntervalMinutes} min
										</p>
										{source.lastRefreshStatus === "error" &&
										source.lastRefreshError &&
										// A failed retry is newer than the persisted source state.
										!errorById[source.id] ? (
											<p role="alert" className="mt-1 text-xs text-danger">
												{source.lastRefreshError}
											</p>
										) : null}
										{errorById[source.id] ? (
											<p role="alert" className="mt-1 text-xs text-danger">
												{errorById[source.id]}
											</p>
										) : null}
									</div>
									<label className="flex items-center gap-2 text-xs text-secondary">
										<span>Enabled</span>
										<Switch
											checked={source.enabled}
											disabled={busyId === source.id}
											onCheckedChange={(value: boolean) =>
												void handleToggleEnabled(source, value)
											}
											aria-label={`Toggle ${source.name}`}
										/>
									</label>
									<div className="flex items-center gap-1">
										<Button
											size="sm"
											variant="ghost"
											onClick={() => void handleRefresh(source)}
											disabled={busyId === source.id}
											aria-label={`Refresh ${source.name}`}
										>
											{busyId === source.id ? (
												<Spinner aria-hidden="true" className="h-4 w-4" />
											) : (
												<RefreshCw aria-hidden="true" className="h-4 w-4" />
											)}
										</Button>
										{source.tunerId ? null : (
											<Button
												size="sm"
												variant="ghost"
												onClick={() => void handleDelete(source)}
												disabled={busyId === source.id}
												aria-label={`Remove ${source.name}`}
											>
												<Trash2 aria-hidden="true" className="h-4 w-4" />
											</Button>
										)}
									</div>
								</CardContent>
							</Card>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function LastRefreshBadge({ source }: { source: EpgSource }): ReactNode {
	if (!source.lastRefreshAt) {
		return (
			<Badge variant="outline" data-testid="epg-refresh-never">
				Never refreshed
			</Badge>
		);
	}
	const variant: "success" | "danger" =
		source.lastRefreshStatus === "ok" ? "success" : "danger";
	const label = formatRelative(source.lastRefreshAt);
	return (
		<Badge variant={variant} data-testid="epg-refresh-last">
			Last refresh: {label}
		</Badge>
	);
}

function formatRelative(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "unknown";
	const now = Date.now();
	const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
	if (deltaSec < 60) return `${deltaSec}s ago`;
	const min = Math.floor(deltaSec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}

type AddEpgSourceFormProps = {
	onCreated: () => Promise<void> | void;
};

function AddEpgSourceForm({ onCreated }: AddEpgSourceFormProps) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [filePath, setFilePath] = useState("");
	const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState("720");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);

			const intervalNumber = Number(refreshIntervalMinutes);
			const candidate: Record<string, unknown> = {
				kind: "xmltv",
				name: name.trim(),
				refreshIntervalMinutes: Number.isFinite(intervalNumber)
					? intervalNumber
					: refreshIntervalMinutes,
				enabled: true
			};
			const trimmedUrl = url.trim();
			const trimmedPath = filePath.trim();
			if (trimmedUrl) candidate.url = trimmedUrl;
			if (trimmedPath) candidate.filePath = trimmedPath;
			// Surface a friendlier message before shared schema validation.
			if (!trimmedUrl && !trimmedPath) {
				setError("Provide either a URL or a file path");
				return;
			}
			const parsed = epgSourceCreateSchema.safeParse(candidate);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				setError(first ? formatIssue(first) : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				await createEpgSource(parsed.data);
				setName("");
				setUrl("");
				setFilePath("");
				setRefreshIntervalMinutes("720");
				await onCreated();
			} catch (err) {
				setError(formatErrorMessage(err, "Could not save"));
			} finally {
				setSubmitting(false);
			}
		},
		[filePath, name, onCreated, refreshIntervalMinutes, url]
	);

	return (
		<form
			noValidate
			onSubmit={onSubmit}
			aria-label="Add EPG source"
			className="space-y-3 rounded-lg border border-border bg-surface p-4"
		>
			<Card>
				<CardHeader>
					<CardTitle>New EPG source</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="mb-3 text-xs text-muted">
						Add an XMLTV source here. HDHomeRun guides are managed automatically
						when you add the tuner.
					</p>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="space-y-1 text-sm sm:col-span-2">
							<span className="text-primary">Name</span>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My XMLTV guide"
								required
							/>
						</label>
						<label className="space-y-1 text-sm sm:col-span-2">
							<span className="text-primary">URL</span>
							<Input
								type="url"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="https://example.com/guide.xml"
							/>
						</label>
						<label className="space-y-1 text-sm sm:col-span-2">
							<span className="text-primary">File path (alternative)</span>
							<Input
								value={filePath}
								onChange={(e) => setFilePath(e.target.value)}
								placeholder="/var/lib/signalhaven/guide.xml"
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="text-primary">Refresh interval (minutes)</span>
							<Input
								type="number"
								min={5}
								max={10080}
								value={refreshIntervalMinutes}
								onChange={(e) => setRefreshIntervalMinutes(e.target.value)}
							/>
						</label>
					</div>
				</CardContent>
			</Card>

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
					{submitting ? "Saving…" : "Save EPG source"}
				</Button>
			</div>
		</form>
	);
}

function omitKey<K extends string, V>(
	record: Record<K, V>,
	key: K
): Record<K, V> {
	if (!(key in record)) return record;
	const next = { ...record };
	delete next[key];
	return next;
}
